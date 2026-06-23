import asyncio
import json
import logging

from app.models import message_wire

logger = logging.getLogger(__name__)

APPROVAL_TIMEOUT_SECONDS = 300


class RoomHub:
    def __init__(
        self,
        sio,
        store,
        chat_service,
        *,
        run_store=None,
        turn_runner=None,
        skills=None,
        tool_factory=None,
        asset_store=None,
        asset_hub=None,
    ):
        self._sio = sio
        self._store = store
        self._chat = chat_service
        self._run_store = run_store
        self._runner = turn_runner
        self._skills = skills
        self._tool_factory = tool_factory
        self._asset_store = asset_store
        self._asset_hub = asset_hub
        # queues hold turn descriptors: {"kind": "prompt", "messageId": id}
        # or {"kind": "skill", "author": …, "skillName": …, "args": …}
        self._queues: dict[str, list[dict]] = {}
        self._busy: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}
        # room_id -> {"messageId", "content", "state"} while a chat generation streams
        self._active: dict[str, dict] = {}
        # room_id -> {"runId": …} while a skill run is in progress
        self._active_runs: dict[str, dict] = {}
        # run_id -> {"future": asyncio.Future, "step_index": int, "action": dict}
        self._pending_approvals: dict[str, dict] = {}
        self._approval_timeout = APPROVAL_TIMEOUT_SECONDS

    def _lock(self, room_id: str) -> asyncio.Lock:
        return self._locks.setdefault(room_id, asyncio.Lock())

    def active_snapshot(self, room_id: str) -> dict | None:
        active = self._active.get(room_id)
        if active is None:
            return None
        return {
            "roomId": room_id,
            "messageId": active["messageId"],
            "content": active["content"],
            "state": active["state"],
        }

    async def attach_subscriber(self, room_id: str, sid: str) -> None:
        # Atomic wrt the token loop: either a token is in the snapshot (and this
        # client was not yet in the room for its live emit) or it is excluded and
        # this client is in the room to receive it live — never both, never neither.
        async with self._lock(room_id):
            await self._sio.enter_room(sid, room_id)
            snapshot = self.active_snapshot(room_id)
            if snapshot is not None:
                await self._sio.emit("stream_snapshot", snapshot, to=sid)
                return
            # If a skill run is active, send a run_snapshot to the late joiner.
            active_run = self._active_runs.get(room_id)
            if active_run is not None and self._run_store is not None:
                from app.runs import run_wire
                run = await self._run_store.get_run(active_run["runId"])
                if run is not None:
                    await self._sio.emit("run_snapshot", {"roomId": room_id, "run": run_wire(run)}, to=sid)

    async def handle_prompt(self, room_id: str, author: str, text: str) -> None:
        user_msg = await self._store.add_message(room_id, author, "user", text, "complete")
        await self._sio.emit("message_created", {"message": message_wire(user_msg)}, room=room_id)

        async with self._lock(room_id):
            self._queues.setdefault(room_id, []).append({"kind": "prompt", "messageId": user_msg.id})
            if room_id in self._busy:
                await self._emit_status(room_id, "queued")
                return
            self._busy.add(room_id)

        asyncio.create_task(self._drain(room_id))

    async def handle_skill_run(self, room_id: str, author: str, skill_name: str, args: dict) -> None:
        spec = self._skills.get(skill_name)
        if spec is None:
            await self._sio.emit("error", {"roomId": room_id, "message": f"unknown skill {skill_name}"}, room=room_id)
            return
        try:
            clean = self._skills.validate_args(spec, args)
        except Exception as e:
            await self._sio.emit("error", {"roomId": room_id, "message": str(e)}, room=room_id)
            return
        async with self._lock(room_id):
            self._queues.setdefault(room_id, []).append(
                {"kind": "skill", "author": author, "skillName": skill_name, "args": clean}
            )
            if room_id in self._busy:
                await self._emit_status(room_id, "queued")
                return
            self._busy.add(room_id)
        asyncio.create_task(self._drain(room_id))

    async def _drain(self, room_id: str) -> None:
        while True:
            async with self._lock(room_id):
                queue = self._queues.get(room_id, [])
                if not queue:
                    self._busy.discard(room_id)
                    await self._emit_status(room_id, "idle")
                    return
                descriptor = queue.pop(0)
            try:
                if descriptor["kind"] == "skill":
                    await self._run_skill(room_id, descriptor)
                else:
                    await self._run_generation(room_id)
            except Exception:
                await self._sio.emit(
                    "error",
                    {"roomId": room_id, "message": "generation failed"},
                    room=room_id,
                )
                # keep draining remaining queued turns rather than orphaning them

    async def _run_generation(self, room_id: str) -> None:
        room = await self._store.get_room(room_id)
        await self._emit_status(room_id, "generating")

        assistant = await self._store.add_message(room_id, "assistant", "assistant", "", "streaming")
        await self._sio.emit("message_created", {"message": message_wire(assistant)}, room=room_id)

        history = await self._store.list_messages(room_id)
        context = [m for m in history if m.id != assistant.id]

        async with self._lock(room_id):
            self._active[room_id] = {
                "messageId": assistant.id,
                "content": "",
                "state": "generating",
            }

        content = ""
        try:
            async for token in self._generation_tokens(context, room.model):
                content += token
                async with self._lock(room_id):
                    self._active[room_id]["content"] = content
                    await self._sio.emit(
                        "token",
                        {"roomId": room_id, "messageId": assistant.id, "delta": token},
                        room=room_id,
                    )
        finally:
            async with self._lock(room_id):
                self._active.pop(room_id, None)

        await self._store.complete_message(assistant.id, content)
        await self._sio.emit(
            "message_completed",
            {"roomId": room_id, "messageId": assistant.id},
            room=room_id,
        )

    async def _generation_tokens(self, context, model):
        """Yield plain-chat token deltas.

        Unified executor: every turn flows through ``TurnRunner.run`` — plain
        chat uses the no-tool path (``skill=None``), and its ``StepToken`` deltas
        are projected onto the legacy ``token`` wire event by ``_run_generation``.
        Only the token SOURCE changes here; the wire protocol is unchanged.

        When no runner is wired (e.g. unit tests that inject a fake chat
        service), fall back to the legacy ``chat_service.stream`` path so the
        plain-chat contract is preserved without a runner dependency.
        """
        if self._runner is None:
            async for token in self._chat.stream(context, model):
                yield token
            return

        from app.chat_service import build_turns

        # Build turns exactly as the legacy plain-chat path did (user content is
        # author-prefixed) so the replay prompt-key normalization is identical.
        messages = build_turns(context)
        async for ev in self._runner.run(
            messages=messages, model=model, skill=None, args={}, ctx=None
        ):
            name = type(ev).__name__
            if name == "StepToken":
                yield ev.delta
            elif name == "RunFinished" and ev.status == "error":
                raise RuntimeError("generation failed")

    async def _run_skill(self, room_id: str, descriptor: dict) -> None:
        from app.runs import run_wire, RunStep
        from app.agent_tools import ToolContext

        room = await self._store.get_room(room_id)
        spec = self._skills.get(descriptor["skillName"])
        run = await self._run_store.create_run(room_id, spec.name, descriptor["args"])
        await self._emit_status(room_id, "generating")
        await self._sio.emit("run_started", {"roomId": room_id, "run": run_wire(run)}, room=room_id)

        async with self._lock(room_id):
            self._active_runs[room_id] = {"runId": run.id}

        history = await self._store.list_messages(room_id)
        messages = [{"role": m.role, "content": m.content} for m in history]
        ctx = ToolContext(room_id, room.game_id, self._asset_store, self._asset_hub)
        status = "completed"
        try:
            async for ev in self._runner.run(
                messages=messages, model=room.model, skill=spec, args=descriptor["args"],
                ctx=ctx, run_id=run.id, on_approval=self._make_approval_cb(room_id, run.id),
            ):
                if type(ev).__name__ == "ApprovalRequired":
                    await self._begin_approval(room_id, run.id, ev.action, ev.index)
                    continue
                await self._project_run_event(room_id, run.id, ev)
                if type(ev).__name__ == "RunFinished":
                    status = ev.status
        except Exception:
            logger.exception("skill run failed")
            status = "error"
        finally:
            async with self._lock(room_id):
                self._active_runs.pop(room_id, None)
            await self._run_store.complete_run(run.id, status)
            await self._sio.emit(
                "run_completed", {"roomId": room_id, "runId": run.id, "status": status}, room=room_id
            )

    async def _begin_approval(self, room_id: str, run_id: str, action: dict, index: int) -> None:
        """Register a pending approval step using the index reserved by the runner."""
        from app.runs import RunStep

        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        # Register BEFORE emitting so resolve_approval arriving concurrently is safe.
        self._pending_approvals[run_id] = {"future": fut, "step_index": index, "action": action}
        await self._run_store.append_step(
            run_id,
            RunStep(index=index, type="approval", content=json.dumps(action), status="running"),
        )
        await self._sio.emit(
            "run_step_started",
            {
                "roomId": room_id,
                "runId": run_id,
                "step": {
                    "index": index,
                    "type": "approval",
                    "toolName": None,
                    "content": json.dumps(action),
                    "status": "running",
                },
            },
            room=room_id,
        )

    def _make_approval_cb(self, room_id: str, run_id: str):
        """Return a coroutine that blocks until the approval is resolved or times out."""

        async def _cb(action: dict) -> str:
            entry = self._pending_approvals.get(run_id)
            if entry is None:
                # Safety: no entry means something went wrong; deny by default.
                return "deny"
            fut = entry["future"]
            try:
                decision = await asyncio.wait_for(asyncio.shield(fut), timeout=self._approval_timeout)
            except asyncio.TimeoutError:
                decision = "deny"
            await self._complete_approval(room_id, run_id, decision)
            return decision

        return _cb

    async def _complete_approval(self, room_id: str, run_id: str, decision: str) -> None:
        """Finalise the approval step: persist + emit run_step_completed."""
        entry = self._pending_approvals.pop(run_id, None)
        if entry is None:
            return
        index = entry["step_index"]
        # Preserve the full action (tool/args/label) alongside the decision.
        content = json.dumps({**entry["action"], "decision": decision})
        await self._run_store.complete_step(run_id, index, "complete", content)
        await self._sio.emit(
            "run_step_completed",
            {
                "roomId": room_id,
                "runId": run_id,
                "stepIndex": index,
                "status": "complete",
                "content": content,
            },
            room=room_id,
        )

    async def resolve_approval(self, room_id: str, run_id: str, decision: str) -> None:
        """Resolve a pending approval future. Idempotent; ignored for unknown/done runs."""
        if decision not in ("approve", "deny"):
            return
        entry = self._pending_approvals.get(run_id)
        if entry is None or entry["future"].done():
            return
        entry["future"].set_result(decision)

    async def _project_run_event(self, room_id: str, run_id: str, ev) -> None:
        from app.runs import RunStep

        name = type(ev).__name__
        if name == "StepStarted":
            await self._run_store.append_step(run_id, RunStep(index=ev.index, type=ev.type, tool_name=ev.tool_name))
            await self._sio.emit(
                "run_step_started",
                {
                    "roomId": room_id,
                    "runId": run_id,
                    "step": {
                        "index": ev.index,
                        "type": ev.type,
                        "toolName": ev.tool_name,
                        "content": "",
                        "status": "running",
                    },
                },
                room=room_id,
            )
        elif name == "StepToken":
            await self._run_store.append_step_token(run_id, ev.index, ev.delta)
            await self._sio.emit(
                "run_step_token",
                {"roomId": room_id, "runId": run_id, "stepIndex": ev.index, "delta": ev.delta},
                room=room_id,
            )
        elif name == "StepCompleted":
            await self._run_store.complete_step(run_id, ev.index, ev.status, ev.content)
            await self._sio.emit(
                "run_step_completed",
                {
                    "roomId": room_id,
                    "runId": run_id,
                    "stepIndex": ev.index,
                    "status": ev.status,
                    "content": ev.content,
                },
                room=room_id,
            )

    async def _emit_status(self, room_id: str, state: str) -> None:
        depth = len(self._queues.get(room_id, []))
        await self._sio.emit(
            "ai_status",
            {"roomId": room_id, "state": state, "queueDepth": depth},
            room=room_id,
        )
