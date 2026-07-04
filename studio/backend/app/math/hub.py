"""MathHub — curation, tuning, and analytics recording over the unified doc.
Merges app/simulator/hub.py (CurationHub), app/tuner/hub.py (TunerHub) and
app/analytics/hub.py (AnalyticsHub). Event names: curation_progress/complete/
failed, tuning_failed, analytics_progress, run_complete. (Task 10 pruned the
pane-only tuning_progress/tuning_complete emissions along with the tune/seed
routes those panes used — request_tune is now silent on success; the
generate pipeline's record_run emits run_complete instead.)"""
import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

from app.math.bounds import build_config, derive_bounds
from app.math.models import (
    CurationResult, MathRunDoc, SectionLocks, TuneResult, TuningParams,
    math_run_wire, sim_wire,
)
from app.math.targets import derive_target, TargetGap

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _drain_task_exception(task: asyncio.Task) -> None:
    """Done-callback for begin_generate's fire-and-forget task. The exception
    (if any) is already logged inside _generate_reserved before it re-raises;
    this callback only retrieves it so asyncio doesn't warn about an
    unretrieved task exception."""
    if task.cancelled():
        return
    task.exception()


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
    async def request_tune(self, game_id: str) -> TuneResult | None:
        """Run one GA tune. Returns the TuneResult (None on target gap).
        Emits tuning_failed on gap/error; success emits nothing terminal — the
        generate pipeline (_generate_reserved) records the run itself
        (record_run → run_complete) so it can attach the verify verdict."""
        doc = await self._store.get_or_seed(game_id)
        model = doc.model or {}
        try:
            target = await self._derive_target(game_id, doc)
        except TargetGap as gap:
            await self._sio.emit("tuning_failed",
                                 {"gameId": game_id, "failure": gap.message},
                                 room=game_id)
            return None

        config = build_config(doc.tuner_params, derive_bounds(model), doc.locks)

        async def on_progress(p):
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

        result = await self._tuner_runner.run(model, target, config,
                                              on_progress=sync_progress)
        if pending:
            await asyncio.gather(*pending)
        await self._store.save_tune_result(game_id, result)

        if result.status not in ("pass", "near_miss"):
            await self._sio.emit("tuning_failed",
                                 {"gameId": game_id,
                                  "failure": result.failure or "tune failed"},
                                 room=game_id)
        return result

    # ── generate pipeline: tune → verify → persist (spec sub-project 1) ──────
    def begin_generate(self, game_id: str) -> bool:
        """Fire-and-forget entry for the REST route. False if already running."""
        if not self._reserve(game_id):
            return False
        task = asyncio.create_task(self._generate_reserved(game_id))
        task.add_done_callback(_drain_task_exception)
        return True

    async def generate(self, game_id: str) -> bool:
        """Run the full pipeline to completion (agent-tool entry).
        False if a run for this game is already in flight."""
        if not self._reserve(game_id):
            return False
        return await self._generate_reserved(game_id)

    def _reserve(self, game_id: str) -> bool:
        if game_id in self._active:
            return False
        self._active.add(game_id)
        return True

    async def _status(self, game_id: str, phase: str) -> None:
        await self._sio.emit("generate_status",
                             {"gameId": game_id, "phase": phase}, room=game_id)

    async def _generate_reserved(self, game_id: str) -> bool:
        try:
            await self._status(game_id, "tuning")
            # Capture the params tuned WITH (from the doc at pipeline start), so
            # a user editing GA params mid-pipeline can't mislabel the run's
            # provenance — matches what request_tune records on its own path.
            doc0 = await self._store.get_or_seed(game_id)
            params = doc0.tuner_params
            locks = doc0.locks
            started = time.monotonic()
            result = await self.request_tune(game_id)
            duration_ms = int((time.monotonic() - started) * 1000)
            if result is None or result.status not in ("pass", "near_miss"):
                await self._status(game_id, "failed")
                return True
            await self._status(game_id, "verifying")
            verify = await self._verify_tuned(game_id, result.tuned_model)
            await self.record_run(game_id, params, result, duration_ms,
                                  verify=verify, locks=locks)
            await self._status(game_id, "done")
            return True
        except Exception:
            # Unexpected failure (subprocess crash, transient DB error, ...) —
            # the caller must not be stranded on "tuning"/"verifying" forever.
            # Log it (this is the only place these exceptions are observed on
            # the begin_generate fire-and-forget path), emit the same terminal
            # generate_status:failed as the known-failure branches above, then
            # re-raise so the awaited generate() path surfaces it to its caller.
            logger.exception("generate pipeline failed for game %s", game_id)
            await self._status(game_id, "failed")
            raise
        finally:
            self._active.discard(game_id)

    async def _verify_tuned(self, game_id: str, tuned_model: dict) -> CurationResult:
        """Independent curate pass on the WINNER (not the stored model). Does not
        touch doc.result and emits no curation_* events — the simulator pane's
        contract stays 'result == last curation of the stored model'."""
        doc = await self._store.get_or_seed(game_id)
        # Target re-derivation uses the STORED doc's params + the STORED model's
        # num_bonuses (the tuned model isn't touched here) — safe because the GA
        # never adds/removes bonuses, so the tuned model has the same bonus count.
        target = await self._derive_target(game_id, doc)

        def _noop(p):
            pass

        return await self._curation_runner.run(tuned_model, target,
                                               on_progress=_noop)

    # ── run recording (was AnalyticsHub.record_run, + verify) ───────────────
    async def record_run(self, game_id: str, params: TuningParams,
                         result: TuneResult, duration_ms: int,
                         verify: CurationResult | None = None,
                         locks: SectionLocks | None = None) -> MathRunDoc | None:
        if result.status not in ("pass", "near_miss"):
            return None
        doc = MathRunDoc(
            id=str(uuid.uuid4()), game_id=game_id, params=params,
            verdict=result.verdict, metrics=result.metrics, trace=result.trace,
            profile=result.profile, verify=verify, locks=locks,
            created_at=_now(), duration_ms=duration_ms,
        )
        saved = await self._runs.append(doc)
        await self._sio.emit("run_complete",
                             {"gameId": game_id, "run": math_run_wire(saved)},
                             room=game_id)
        return saved
