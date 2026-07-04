import asyncio
import json
import logging

from app.gdd.models import GDD_TOOL_NAMES
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
        gdd_store=None,
        gdd_hub=None,
        scene_store=None,
        scene_hub=None,
        math_store=None,
        math_hub=None,
        scene_critic=None,
        capture_broker=None,
        asset_critic=None,
        scene_art_critic=None,
        region_override_store=None,
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
        self._gdd_store = gdd_store
        self._gdd_hub = gdd_hub
        self._scene_store = scene_store
        self._scene_hub = scene_hub
        self._math_store = math_store
        self._math_hub = math_hub
        self._scene_critic = scene_critic
        self._capture_broker = capture_broker
        self._asset_critic = asset_critic
        self._scene_art_critic = scene_art_critic
        self._region_override_store = region_override_store
        self._router_spec = None
        # queues hold turn descriptors: {"kind": "prompt"} (no-tool plain chat)
        # or {"kind": "skill", "author": …, "skillName": …, "args": …,
        #     "spec": <SkillSpec>?} — "spec" is set for the synthetic design-router
        # turn routed from game-room plain chat; registry-driven skills omit it.
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

        descriptor = await self._prompt_descriptor(room_id, author)

        async with self._lock(room_id):
            self._queues.setdefault(room_id, []).append(descriptor)
            if room_id in self._busy:
                await self._emit_status(room_id, "queued")
                return
            self._busy.add(room_id)

        asyncio.create_task(self._drain(room_id))

    def _can_route_design(self) -> bool:
        """The design-router needs the full agent/run stack plus a GDD hub."""
        return (
            self._gdd_hub is not None
            and self._run_store is not None
            and self._runner is not None
        )

    def _design_router_spec(self):
        from app.gdd.router import build_design_router_spec

        if self._router_spec is None:
            self._router_spec = build_design_router_spec()
        return self._router_spec

    async def _prompt_descriptor(self, room_id: str, author: str) -> dict:
        """Decide how a plain-chat prompt runs.

        In a game room with the agent stack wired, freeform chat runs the
        design-router agent so a design decision can edit the GDD without an
        explicit /design-game. Rooms without a game keep the no-tool path.
        """
        if self._can_route_design():
            room = await self._store.get_room(room_id)
            if room is not None and getattr(room, "game_id", None):
                spec = self._design_router_spec()
                return {
                    "kind": "skill", "author": author,
                    "skillName": spec.name, "args": {}, "spec": spec,
                }
        return {"kind": "prompt"}

    async def handle_skill_run(self, room_id: str, author: str, skill_name: str, args: dict, text: str = "") -> None:
        from app.skills import invocation_text

        spec = self._skills.get(skill_name)
        if spec is None:
            await self._sio.emit("error", {"roomId": room_id, "message": f"unknown skill {skill_name}"}, room=room_id)
            return
        try:
            # Prose path infers required args via the agent, so don't enforce them here.
            clean = self._skills.validate_args(spec, args, enforce_required=not text.strip())
        except Exception as e:
            await self._sio.emit("error", {"roomId": room_id, "message": str(e)}, room=room_id)
            return

        # Persist the invocation as a user message so the agent actually receives
        # the user's intent (history is the agent's only context) and the chat
        # transcript shows what was asked.
        content = invocation_text(spec, text, clean)
        user_msg = await self._store.add_message(room_id, author, "user", content, "complete")
        await self._sio.emit("message_created", {"message": message_wire(user_msg)}, room=room_id)

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
        spec = descriptor.get("spec") or self._skills.get(descriptor["skillName"])

        if (self._gdd_hub is not None and room.game_id
                and set(spec.tools) & GDD_TOOL_NAMES):
            await self._gdd_hub.seed_taxonomy(room.game_id)

        run = await self._run_store.create_run(room_id, spec.name, descriptor["args"])
        await self._emit_status(room_id, "generating")
        await self._sio.emit("run_started", {"roomId": room_id, "run": run_wire(run)}, room=room_id)

        async with self._lock(room_id):
            self._active_runs[room_id] = {"runId": run.id}

        history = await self._store.list_messages(room_id)
        messages = [{"role": m.role, "content": m.content} for m in history]
        ctx = ToolContext(room_id, room.game_id, self._asset_store, self._asset_hub,
                         gdd_store=self._gdd_store, gdd_hub=self._gdd_hub,
                         scene_store=self._scene_store, scene_hub=self._scene_hub,
                         math_store=self._math_store, math_hub=self._math_hub,
                         scene_critic=self._scene_critic,
                         capture_broker=self._capture_broker,
                         asset_critic=self._asset_critic,
                         scene_art_critic=self._scene_art_critic,
                         region_override_store=self._region_override_store)
        status = "completed"
        try:
            async for ev in self._runner.run(
                messages=messages, model=room.model, skill=spec, args=descriptor["args"],
                ctx=ctx, run_id=run.id, on_approval=self._make_approval_cb(room_id, run.id),
            ):
                if type(ev).__name__ == "ApprovalRequired":
                    await self._begin_interrupt(room_id, run.id, ev.action, ev.index)
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
            entry = self._pending_approvals.pop(run.id, None)
            if entry is not None and not entry["future"].done():
                entry["future"].cancel()
            # Surface a failed run as a visible chat error. The runner swallows the
            # model error and reports it via RunFinished(status="error") (no raise),
            # so condition on the final status — not just the except path. The run
            # block alone may have no steps if the model failed on the first call.
            if status == "error":
                await self._sio.emit(
                    "error",
                    {"roomId": room_id, "message": "generation failed"},
                    room=room_id,
                )
            await self._run_store.complete_run(run.id, status)
            await self._sio.emit(
                "run_completed", {"roomId": room_id, "runId": run.id, "status": status}, room=room_id
            )

    async def _begin_interrupt(self, room_id: str, run_id: str, action: dict, index: int) -> None:
        """Dispatch a runner interrupt to the approval or question gate by kind."""
        if action.get("kind") == "question":
            await self._begin_question(room_id, run_id, action, index)
        else:
            await self._begin_approval(room_id, run_id, action, index)

    async def _begin_question(self, room_id: str, run_id: str, action: dict, index: int) -> None:
        """Register a pending question step (no timeout) at the reserved index."""
        from app.runs import RunStep

        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        # Register BEFORE emitting so resolve_question arriving concurrently is safe.
        self._pending_approvals[run_id] = {
            "future": fut, "step_index": index, "action": action, "kind": "question",
        }
        await self._run_store.append_step(
            run_id,
            RunStep(index=index, type="question", content=json.dumps(action), status="running"),
        )
        await self._sio.emit(
            "run_step_started",
            {
                "roomId": room_id,
                "runId": run_id,
                "step": {
                    "index": index,
                    "type": "question",
                    "toolName": None,
                    "content": json.dumps(action),
                    "status": "running",
                },
            },
            room=room_id,
        )

    async def _begin_approval(self, room_id: str, run_id: str, action: dict, index: int) -> None:
        """Register a pending approval step using the index reserved by the runner."""
        from app.runs import RunStep

        loop = asyncio.get_running_loop()
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

        async def _cb(action: dict) -> object:
            entry = self._pending_approvals.get(run_id)
            if entry is None:
                # Safety: no entry means something went wrong; deny by default.
                return "deny"
            fut = entry["future"]
            if entry.get("kind") == "question":
                # Questions park indefinitely until the user answers — no timeout.
                answer = await fut
                await self._complete_question(room_id, run_id, action, answer)
                return answer
            try:
                decision = await asyncio.wait_for(fut, timeout=self._approval_timeout)
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

    async def _complete_question(self, room_id: str, run_id: str, action: dict, answer) -> None:
        """Finalise the question step: persist + emit run_step_completed with the answer."""
        entry = self._pending_approvals.pop(run_id, None)
        if entry is None:
            return
        index = entry["step_index"]
        # Preserve the full action (question/suggestions/aspect) alongside the answer.
        content = json.dumps({**entry["action"], "answer": answer})
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
        # Question and approval entries share _pending_approvals; never let an
        # approval event resolve a parked question future (would corrupt the answer).
        if entry.get("kind") == "question":
            return
        entry["future"].set_result(decision)

    async def resolve_question(self, room_id: str, run_id: str, answer: dict) -> None:
        """Resolve a pending question future with the answer dict.

        Idempotent; ignored for unknown/done runs and for non-question entries
        (so an approval gate can never be driven by resolve_question)."""
        entry = self._pending_approvals.get(run_id)
        if entry is None or entry["future"].done():
            return
        if entry.get("kind") != "question":
            return
        entry["future"].set_result(answer)

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
