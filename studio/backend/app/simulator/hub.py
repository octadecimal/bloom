import asyncio

from app.simulator.models import sim_wire
from app.simulator.targets import derive_target, TargetGap


class CurationHub:
    def __init__(self, sio, store, runner, gdd_store):
        self._sio = sio
        self._store = store
        self._runner = runner
        self._gdd = gdd_store

    async def attach_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._store.get(game_id)
        if doc is not None and doc.result is not None:
            await self._sio.emit(
                "curation_complete",
                {"gameId": game_id, "doc": sim_wire(doc)},
                to=sid,
            )

    async def request_curation(self, game_id: str) -> None:
        doc = await self._store.get_or_seed(game_id)
        model = doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])

        gdd = await self._gdd.get_doc(game_id, "math-model")
        math_model = getattr(gdd, "data", {}) if gdd is not None else {}
        try:
            target = derive_target(math_model, doc.params, num_bonuses)
        except TargetGap as gap:
            await self._sio.emit(
                "curation_failed",
                {"gameId": game_id, "failure": gap.message},
                room=game_id,
            )
            return

        async def on_progress(p):
            await self._sio.emit(
                "curation_progress",
                {"gameId": game_id, "phase": p.phase, "done": p.done, "total": p.total},
                room=game_id,
            )

        loop = asyncio.get_running_loop()

        def sync_progress(p):
            loop.create_task(on_progress(p))

        result = await self._runner.run(model, target, on_progress=sync_progress)
        saved = await self._store.save_result(game_id, result)

        event = "curation_complete" if result.status in ("pass", "fail") else "curation_failed"
        await self._sio.emit(
            event,
            {"gameId": game_id, "doc": sim_wire(saved)},
            room=game_id,
        )
