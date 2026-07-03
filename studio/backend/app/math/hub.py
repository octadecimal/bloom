"""MathHub — curation, tuning, and analytics recording over the unified doc.
Merges app/simulator/hub.py (CurationHub), app/tuner/hub.py (TunerHub) and
app/analytics/hub.py (AnalyticsHub). Event names are unchanged:
curation_progress/complete/failed, tuning_progress/complete/failed,
analytics_progress, run_complete."""
import asyncio
import time
import uuid
from datetime import datetime, timezone

from app.math.bounds import build_config, derive_bounds
from app.math.models import (
    CurationResult, MathRunDoc, TuneResult, TuningParams,
    math_run_wire, sim_wire, tuner_view,
)
from app.math.targets import derive_target, TargetGap


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MathHub:
    def __init__(self, sio, store, run_store, curation_runner, tuner_runner, gdd_store):
        self._sio = sio
        self._store = store
        self._runs = run_store
        self._curation_runner = curation_runner
        self._tuner_runner = tuner_runner
        self._gdd = gdd_store
        self._active: set[str] = set()  # games with a generate pipeline in flight

    # ── subscriptions (one per legacy pane; event names preserved) ──────────
    async def attach_sim_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._store.get(game_id)
        if doc is not None and doc.result is not None:
            await self._sio.emit("curation_complete",
                                 {"gameId": game_id, "doc": sim_wire(doc)}, to=sid)

    async def attach_tuner_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._store.get(game_id)
        if doc is not None and doc.tune_result is not None:
            await self._sio.emit("tuning_complete",
                                 {"gameId": game_id, "doc": tuner_view(doc)}, to=sid)

    async def attach_analytics_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        latest = await self._runs.list_for_game(game_id, limit=1)
        if latest:
            await self._sio.emit("run_complete",
                                 {"gameId": game_id, "run": math_run_wire(latest[0])},
                                 to=sid)

    # ── target derivation (shared) ───────────────────────────────────────────
    async def _derive_target(self, game_id: str, doc) -> dict:
        model = doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])
        gdd = await self._gdd.get_doc(game_id, "math-model")
        math_model = getattr(gdd, "data", {}) if gdd is not None else {}
        return derive_target(math_model, doc.params, num_bonuses)

    # ── curation (was CurationHub.request_curation) ─────────────────────────
    async def request_curation(self, game_id: str) -> None:
        doc = await self._store.get_or_seed(game_id)
        try:
            target = await self._derive_target(game_id, doc)
        except TargetGap as gap:
            await self._sio.emit("curation_failed",
                                 {"gameId": game_id, "failure": gap.message},
                                 room=game_id)
            return

        async def on_progress(p):
            await self._sio.emit(
                "curation_progress",
                {"gameId": game_id, "phase": p.phase, "done": p.done, "total": p.total},
                room=game_id)

        pending: list[asyncio.Task] = []
        loop = asyncio.get_running_loop()

        def sync_progress(p):
            pending.append(loop.create_task(on_progress(p)))

        result = await self._curation_runner.run(doc.model or {}, target,
                                                 on_progress=sync_progress)
        if pending:
            await asyncio.gather(*pending)
        saved = await self._store.save_result(game_id, result)
        event = "curation_complete" if result.status in ("pass", "fail") else "curation_failed"
        await self._sio.emit(event, {"gameId": game_id, "doc": sim_wire(saved)},
                             room=game_id)

    # ── tuning (was TunerHub.request_tune) ──────────────────────────────────
    async def request_tune(self, game_id: str, *, record: bool = True) -> TuneResult | None:
        """Run one GA tune. Returns the TuneResult (None on target gap). With
        record=False the math_runs append is skipped — the generate pipeline
        (Task 6) records the run itself so it can attach the verify verdict."""
        doc = await self._store.get_or_seed(game_id)
        model = doc.model or {}
        try:
            target = await self._derive_target(game_id, doc)
        except TargetGap as gap:
            await self._sio.emit("tuning_failed",
                                 {"gameId": game_id, "failure": gap.message},
                                 room=game_id)
            return None

        config = build_config(doc.tuner_params, derive_bounds(model))

        async def on_progress(p):
            await self._sio.emit(
                "tuning_progress",
                {"gameId": game_id, "generation": p.generation,
                 "maxGenerations": p.max_generations, "bestFitness": p.best_fitness,
                 "bestRtp": p.best_rtp, "bestVolatility": p.best_volatility},
                room=game_id)
            # Ephemeral enriched frame for the (live) analytics Evolution tab.
            await self._sio.emit(
                "analytics_progress",
                {"gameId": game_id, "generation": p.generation,
                 "maxGenerations": p.max_generations,
                 "best": {"fitness": p.best_fitness, "rtp": p.best_rtp,
                          "volatility": p.best_volatility},
                 "population": p.population.model_dump(by_alias=True, mode="json"),
                 "geneAgreement": p.gene_agreement},
                room=game_id)

        pending: list[asyncio.Task] = []
        loop = asyncio.get_running_loop()

        def sync_progress(p):
            pending.append(loop.create_task(on_progress(p)))

        started = time.monotonic()
        result = await self._tuner_runner.run(model, target, config,
                                              on_progress=sync_progress)
        duration_ms = int((time.monotonic() - started) * 1000)
        if pending:
            await asyncio.gather(*pending)
        saved = await self._store.save_tune_result(game_id, result)

        event = "tuning_complete" if result.status in ("pass", "near_miss") else "tuning_failed"
        await self._sio.emit(event, {"gameId": game_id, "doc": tuner_view(saved)},
                             room=game_id)
        if record and result.status in ("pass", "near_miss"):
            await self.record_run(game_id, doc.tuner_params, result, duration_ms)
        return result

    # ── run recording (was AnalyticsHub.record_run, + verify) ───────────────
    async def record_run(self, game_id: str, params: TuningParams,
                         result: TuneResult, duration_ms: int,
                         verify: CurationResult | None = None) -> MathRunDoc | None:
        if result.status not in ("pass", "near_miss"):
            return None
        doc = MathRunDoc(
            id=str(uuid.uuid4()), game_id=game_id, params=params,
            verdict=result.verdict, metrics=result.metrics, trace=result.trace,
            profile=result.profile, verify=verify,
            created_at=_now(), duration_ms=duration_ms,
        )
        saved = await self._runs.append(doc)
        await self._sio.emit("run_complete",
                             {"gameId": game_id, "run": math_run_wire(saved)},
                             room=game_id)
        return saved
