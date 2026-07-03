import asyncio
import time

from app.simulator.targets import derive_target, TargetGap
from app.tuner.bounds import build_config, derive_bounds
from app.tuner.models import tuner_wire


class TunerHub:
    def __init__(self, sio, tuner_store, slot_model_store, runner, gdd_store, analytics_hub):
        self._sio = sio
        self._tuner = tuner_store
        self._slot = slot_model_store
        self._runner = runner
        self._gdd = gdd_store
        self._analytics = analytics_hub

    async def attach_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._tuner.get(game_id)
        if doc is not None and doc.result is not None:
            await self._sio.emit(
                "tuning_complete",
                {"gameId": game_id, "doc": tuner_wire(doc)},
                to=sid,
            )

    async def request_tune(self, game_id: str) -> None:
        sim_doc = await self._slot.get_or_seed(game_id)
        model = sim_doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])

        gdd = await self._gdd.get_doc(game_id, "math-model")
        math_model = getattr(gdd, "data", {}) if gdd is not None else {}
        try:
            # Reuse the simulator's target derivation + the SAME curation params,
            # so the tuner aims at exactly the bands the simulator will verify.
            target = derive_target(math_model, sim_doc.params, num_bonuses)
        except TargetGap as gap:
            await self._sio.emit(
                "tuning_failed",
                {"gameId": game_id, "failure": gap.message},
                room=game_id,
            )
            return

        tuner_doc = await self._tuner.get_or_seed(game_id)
        config = build_config(tuner_doc.params, derive_bounds(model))

        async def on_progress(p):
            await self._sio.emit(
                "tuning_progress",
                {"gameId": game_id, "generation": p.generation,
                 "maxGenerations": p.max_generations, "bestFitness": p.best_fitness,
                 "bestRtp": p.best_rtp, "bestVolatility": p.best_volatility},
                room=game_id,
            )
            # Ephemeral enriched frame for the (live) analytics Evolution tab.
            # Not persisted — the durable run doc still lands via record_run
            # at completion. Same room/sio as tuning_progress, just a richer shape.
            await self._sio.emit(
                "analytics_progress",
                {"gameId": game_id, "generation": p.generation,
                 "maxGenerations": p.max_generations,
                 "best": {"fitness": p.best_fitness, "rtp": p.best_rtp,
                          "volatility": p.best_volatility},
                 "population": p.population.model_dump(by_alias=True, mode="json"),
                 "geneAgreement": p.gene_agreement},
                room=game_id,
            )

        pending: list[asyncio.Task] = []
        loop = asyncio.get_running_loop()

        def sync_progress(p):
            pending.append(loop.create_task(on_progress(p)))

        started = time.monotonic()
        result = await self._runner.run(model, target, config, on_progress=sync_progress)
        duration_ms = int((time.monotonic() - started) * 1000)
        if pending:
            await asyncio.gather(*pending)
        saved = await self._tuner.save_result(game_id, result)

        event = "tuning_complete" if result.status in ("pass", "near_miss") else "tuning_failed"
        await self._sio.emit(
            event,
            {"gameId": game_id, "doc": tuner_wire(saved)},
            room=game_id,
        )
        if result.status in ("pass", "near_miss"):
            await self._analytics.record_run(game_id, tuner_doc.params, result, duration_ms)
