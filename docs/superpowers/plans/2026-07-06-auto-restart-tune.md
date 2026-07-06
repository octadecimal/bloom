# Auto-Restart Tuner Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Generate tune stagnates or fails its fresh-seed verify, the backend automatically restarts the tune (re-seeded from the best model so far, with escalated mutation) up to a user-visible attempts cap, so a terminal FAIL means "likely infeasible" with a diagnosis — never "unlucky seed, click again".

**Architecture:** A pipeline-level restart loop in `MathHub._generate_reserved` (Python only; the Rust `tune_json` binary stays single-shot). An attempt = one tune (+ fresh-seed verify if the tune passed). Restartable outcomes: tune `near_miss`, or tune `pass` + verify `fail`. One folded `MathRunDoc` per Generate click carries the best attempt plus a per-attempt summary. The frontend shows `(attempt 2/4)` live and a restart diagnosis line on the ResultStrip.

**Tech Stack:** Python 3 / FastAPI / pydantic v2 / motor (backend), pytest-asyncio + a real Mongo fixture (`mongo_db`), React + hookstate + vitest (frontend), Playwright (e2e, local-only).

**Spec:** `docs/superpowers/specs/2026-07-06-auto-restart-tune-design.md` (committed on this branch).

## Global Constraints

- Worktree: `C:\code\bloom.wt\auto-restart-tune`, branch `feat/auto-restart-tune`, `BLOOM_PORT_OFFSET=1` (backend :8001, frontend :4201). NEVER use the default ports — another session may hold them.
- Semantic commit format (`feat(math): …`, `test(math): …`) — see AGENTS.md.
- TypeScript interfaces use an `I` prefix (`IAttemptSummary`) — docs/coding-standards.md.
- `TuningParams.max_attempts`: default **4**, `ge=1`, `le=10`. `max_attempts=1` must reproduce today's single-shot behavior exactly.
- Escalation per attempt n (1-based): `master_seed = base + (n-1)`; `mutation_rate = min(0.5, base × 1.5^(n-1))`. All other GA params and the gene **bounds are derived once** from the stored model and never change across attempts.
- `error` results (tune or verify) are environmental: terminal immediately, never retried.
- Early exit after **2 consecutive non-improving attempts** (miss score did not decrease).
- Backend test command (from worktree root): `uv --directory studio/backend run pytest -q`
- Frontend gates (all four, from worktree root; vitest green ≠ types valid):
  `node_modules/.bin/prettier --check .` · `npx nx typecheck frontend` · `npx nx test frontend` · `npx nx build frontend`
  (use the repo-pinned prettier, never `npx prettier`).
- Known-unrelated: in an offset≠0 worktree, `nx run-many -t test` has 3 pre-existing port-hardcoded game-plugin test failures — do not chase them; `npx nx test frontend` for this plugin's specs is the relevant gate.

---

### Task 1: Backend wire models — `max_attempts`, `AttemptSummaryWire`, run-doc fields

**Files:**

- Modify: `studio/backend/app/math/models.py` (TuningParams ~line 72; MathRunDoc ~line 210)
- Modify: `docs/superpowers/specs/2026-07-06-auto-restart-tune-design.md` (two-line amendment)
- Test: `studio/backend/tests/test_restart.py` (new file)

**Interfaces:**

- Consumes: existing `_WireModel`, `TuningParams`, `MathRunDoc`, `math_run_wire`.
- Produces: `TuningParams.max_attempts: int` (default 4, ge=1, le=10); `AttemptSummaryWire(attempt: int, verdict: str | None, stop_reason: str | None, miss_score: float)`; `MathRunDoc.attempts: list[AttemptSummaryWire] | None`; `MathRunDoc.loop_stop: str | None` (`"pass" | "attempts_exhausted" | "not_improving" | "error"`). Wire (camelCase): `maxAttempts`, `attempts[].{attempt,verdict,stopReason,missScore}`, `loopStop`.

- [ ] **Step 1: Write the failing tests**

Create `studio/backend/tests/test_restart.py`:

```python
"""Auto-restart tune: wire models (Task 1) + pure loop helpers (Task 2).
Spec: docs/superpowers/specs/2026-07-06-auto-restart-tune-design.md"""
from app.math.bounds import build_config, derive_bounds
from app.math.models import (
    AttemptSummaryWire, MathRunDoc, TuningParams, default_tuning_params,
    math_run_wire,
)


def test_tuning_params_default_max_attempts_is_4():
    assert default_tuning_params().max_attempts == 4


def test_tuning_params_accepts_legacy_payload_without_max_attempts():
    data = default_tuning_params().model_dump()
    data.pop("max_attempts")
    assert TuningParams.model_validate(data).max_attempts == 4


def test_build_config_omits_max_attempts():
    # Python-only knob: it must never reach the Rust binary's config JSON.
    cfg = build_config(default_tuning_params(), derive_bounds({}))
    assert "max_attempts" not in cfg


def test_math_run_wire_carries_attempts_and_loop_stop():
    run = MathRunDoc(
        id="r1", game_id="g1", params=default_tuning_params(), created_at="t",
        attempts=[AttemptSummaryWire(attempt=1, verdict="near_miss",
                                     stop_reason="stagnated", miss_score=2.5)],
        loop_stop="attempts_exhausted",
    )
    wire = math_run_wire(run)
    assert wire["loopStop"] == "attempts_exhausted"
    assert wire["attempts"][0] == {"attempt": 1, "verdict": "near_miss",
                                   "stopReason": "stagnated", "missScore": 2.5}
    assert wire["params"]["maxAttempts"] == 4


def test_math_run_wire_legacy_run_has_null_attempts():
    run = MathRunDoc(id="r1", game_id="g1", params=default_tuning_params(),
                     created_at="t")
    wire = math_run_wire(run)
    assert wire["attempts"] is None
    assert wire["loopStop"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_restart.py -v`
Expected: FAIL — `ImportError: cannot import name 'AttemptSummaryWire'`.

- [ ] **Step 3: Implement the model changes**

In `studio/backend/app/math/models.py`, add to `TuningParams` (after `weights`):

```python
    weights: TuneWeights
    # Python-only restart knob (spec 2026-07-06-auto-restart-tune-design.md):
    # whole-tune attempts, re-seeded from best-so-far with escalated mutation.
    # Never forwarded to the Rust binary (build_config enumerates its fields).
    max_attempts: int = Field(default=4, ge=1, le=10)
```

Add after `SectionLocks` (before `SlotModelDoc`):

```python
# ── auto-restart loop (spec 2026-07-06-auto-restart-tune-design.md) ──────────
class AttemptSummaryWire(_WireModel):
    """One restart-loop attempt, folded onto the recorded run."""
    attempt: int
    verdict: str | None = None       # "pass" | "near_miss" (None never recorded)
    stop_reason: str | None = None   # the GA's own stop: feasible/stagnated/budget
    miss_score: float = 0.0          # ranking/diagnosis only, never a verdict
```

Add to `MathRunDoc` (after `stop_reason`):

```python
    # Auto-restart telemetry (None on runs that predate the restart loop).
    attempts: list[AttemptSummaryWire] | None = None
    loop_stop: str | None = None  # pass | attempts_exhausted | not_improving | error
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_restart.py -v`
Expected: 5 passed. Also run the full backend suite (`uv --directory studio/backend run pytest -q`) — no regressions (pydantic defaults keep every legacy construction site valid).

- [ ] **Step 5: Amend the spec (two decisions refined during planning)**

In `docs/superpowers/specs/2026-07-06-auto-restart-tune-design.md`:

1. Change the `loop_stop` line to include `'error'`:
   `- `loop_stop: 'pass' | 'attempts_exhausted' | 'not_improving' | 'error'` — facts only;` (`'error'` = a mid-loop verify errored: environmental, loop stopped early with the best so far).
2. Change the socket-event line from "Socket events `generate_status` … and `analytics_progress` gain `attempt` / `maxAttempts`." to: "Socket event `generate_status` (while `phase` is `tuning`/`verifying`) gains `attempt` / `maxAttempts`. `analytics_progress` is unchanged — the frontend already resets frames on every `tuning` status, so each attempt gets a fresh Evolution timeline for free."

- [ ] **Step 6: Commit**

```powershell
& node_modules\.bin\prettier.cmd --write docs/superpowers/specs/2026-07-06-auto-restart-tune-design.md
git add studio/backend/app/math/models.py studio/backend/tests/test_restart.py docs/superpowers/specs/2026-07-06-auto-restart-tune-design.md
git commit -m "feat(math): max_attempts + attempt-summary wire models for auto-restart"
```

---

### Task 2: Pure restart helpers — escalation + miss score

**Files:**

- Create: `studio/backend/app/math/restart.py`
- Test: `studio/backend/tests/test_restart.py` (append)

**Interfaces:**

- Consumes: `MetricsWire` (app.math.models); target dict shape from `derive_target` (app/math/targets.py): `{rtp_target, rtp_tolerance, volatility_min, volatility_max, bonus_hit_rate_bands: [{min,max}], ...}`.
- Produces: `escalate(config: dict, attempt: int) -> dict` (attempt 1 = verbatim copy; n>1 = fresh seed + escalated mutation) and `miss_score(metrics: MetricsWire | None, target: dict) -> float` (0.0 = all gates in band; `inf` for missing metrics). Task 3's hub loop imports both.

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_restart.py`:

```python
import math

import pytest

from app.math.models import MetricsWire
from app.math.restart import escalate, miss_score


def _cfg(seed=2026, mutation=0.25):
    return {"master_seed": seed, "mutation_rate": mutation, "population": 24,
            "bounds": {"payout_max": 20}}


def _m(rtp=0.96, vol=4.0, bonus=None):
    return MetricsWire(rtp=rtp, volatility=vol, hit_frequency=0.3, base_rtp=rtp,
                       feature_rtp=0.0, bonus_hit_rates=bonus or [])


TARGET = {"rtp_target": 0.96, "rtp_tolerance": 0.01,
          "volatility_min": 3.0, "volatility_max": 6.0,
          "bonus_hit_rate_bands": []}


def test_escalate_attempt_1_is_the_config_verbatim_and_a_copy():
    cfg = _cfg()
    out = escalate(cfg, 1)
    assert out == cfg
    assert out is not cfg  # caller's config never mutated


def test_escalate_increments_seed_and_compounds_mutation():
    out2 = escalate(_cfg(), 2)
    assert out2["master_seed"] == 2027
    assert out2["mutation_rate"] == pytest.approx(0.375)   # 0.25 * 1.5
    out3 = escalate(_cfg(), 3)
    assert out3["master_seed"] == 2028
    assert out3["mutation_rate"] == pytest.approx(0.5)     # 0.5625 capped at 0.5
    assert out3["population"] == 24                        # only seed+mutation change
    assert out3["bounds"] == {"payout_max": 20}


def test_miss_score_zero_when_all_gates_in_band():
    assert miss_score(_m(), TARGET) == 0.0


def test_miss_score_normalizes_by_band_width():
    # rtp band (0.95, 0.97), width 0.02; measured 0.90 → (0.95-0.90)/0.02 = 2.5
    assert miss_score(_m(rtp=0.90), TARGET) == pytest.approx(2.5)


def test_miss_score_sums_gates():
    # rtp miss 2.5 + vol 7.0 over (3,6): (7-6)/3 ≈ 0.3333
    assert miss_score(_m(rtp=0.90, vol=7.0), TARGET) == pytest.approx(2.5 + 1.0 / 3.0)


def test_miss_score_open_ended_volatility_band_normalizes_by_its_edge():
    # 'high' volatility → (10, 1e9): width 1e9 would zero-out the miss; use lo.
    target = dict(TARGET, volatility_min=10.0, volatility_max=1e9)
    assert miss_score(_m(vol=5.0), target) == pytest.approx((10.0 - 5.0) / 10.0)


def test_miss_score_includes_bonus_bands():
    target = dict(TARGET, bonus_hit_rate_bands=[{"min": 0.005, "max": 0.007}])
    # measured 0.009 → (0.009-0.007)/0.002 = 1.0
    assert miss_score(_m(bonus=[0.009]), target) == pytest.approx(1.0)


def test_miss_score_missing_metrics_is_infinite():
    assert miss_score(None, TARGET) == math.inf
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_restart.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.math.restart'`.

- [ ] **Step 3: Implement `app/math/restart.py`**

```python
"""Pure helpers for the auto-restart tune loop (spec
2026-07-06-auto-restart-tune-design.md): per-attempt config escalation and the
miss score that ranks attempts and feeds the FAIL diagnosis. No IO."""
from app.math.models import MetricsWire

MUTATION_CAP = 0.5
MUTATION_ESCALATION = 1.5
# A band wider than this is open-ended (volatility 'high' → hi=1e9); normalize
# such gates by the finite edge instead, or their misses would score ~0.
_OPEN_BAND = 1e8
_EPS = 1e-9


def escalate(config: dict, attempt: int) -> dict:
    """Config for attempt n (1-based). Attempt 1 is the user's config verbatim;
    each restart gets a fresh deterministic seed and more mutation (diversity)."""
    out = dict(config)
    if attempt > 1:
        out["master_seed"] = config["master_seed"] + (attempt - 1)
        out["mutation_rate"] = min(
            MUTATION_CAP,
            config["mutation_rate"] * MUTATION_ESCALATION ** (attempt - 1))
    return out


def _gate(measured: float, lo: float, hi: float) -> float:
    if lo <= measured <= hi:
        return 0.0
    width = hi - lo
    if width > _OPEN_BAND:
        width = abs(lo)
    width = max(width, _EPS)
    return (lo - measured) / width if measured < lo else (measured - hi) / width


def miss_score(metrics: MetricsWire | None, target: dict) -> float:
    """Sum of per-gate distance-to-band, each normalized by its band width.
    0.0 = every gate in band. Ranking + diagnosis only — never a verdict (the
    noise-aware 2·SE verdicts stay with the Rust tuner / simulator)."""
    if metrics is None:
        return float("inf")
    score = _gate(metrics.rtp,
                  target["rtp_target"] - target["rtp_tolerance"],
                  target["rtp_target"] + target["rtp_tolerance"])
    score += _gate(metrics.volatility,
                   target["volatility_min"], target["volatility_max"])
    for band, rate in zip(target["bonus_hit_rate_bands"],
                          metrics.bonus_hit_rates):
        score += _gate(rate, band["min"], band["max"])
    return score
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_restart.py -v`
Expected: all pass (13 total with Task 1's).

- [ ] **Step 5: Commit**

```powershell
git add studio/backend/app/math/restart.py studio/backend/tests/test_restart.py
git commit -m "feat(math): pure escalation + miss-score helpers for auto-restart"
```

---

### Task 3: The hub restart loop

**Files:**

- Modify: `studio/backend/app/math/hub.py` (replace `request_tune` lines 113–169 and `_generate_reserved` lines 216–259; extend `_status` line 212 and `record_run` lines 282–299)
- Test: `studio/backend/tests/test_math_generate.py` (new tests + 2 updated tests)

**Interfaces:**

- Consumes: `escalate`, `miss_score` (Task 2); `AttemptSummaryWire` (Task 1); existing `build_config`, `derive_bounds`, `derive_target`, `TunerRunner`/`CurationRunner` protocols, `_register_kill`/`_cancelled` plumbing.
- Produces: `request_tune` is **removed** (its only caller was the pipeline); new private `_tune_attempt(game_id, seed_model, target, config) -> TuneResult`. `_status(game_id, phase, *, attempt=None, max_attempts=None)` adds `attempt`/`maxAttempts` keys to the `generate_status` payload when given. `record_run(..., attempts: list[AttemptSummaryWire] | None = None, loop_stop: str | None = None)`. Behavior contract (what the frontend and Task 7's e2e rely on): per-attempt `generate_status` `tuning`/`verifying` events carry `attempt`/`maxAttempts`; the final catch-up verify's `verifying` carries neither; one folded run with `attempts` + `loop_stop`; `save_tune_result` holds the best-so-far model at all times.

- [ ] **Step 1: Write the first failing test (core restart)**

Add to `studio/backend/tests/test_math_generate.py` (after the existing fixtures, ~line 92):

```python
class SequencedTunerRunner:
    """Queued per-call results; records the (seed_model, config) of each call."""
    def __init__(self, results):
        self._results = list(results)
        self.calls: list[tuple[dict, dict]] = []

    async def run(self, seed_model, target, config, on_progress, on_spawn=None):
        self.calls.append((dict(seed_model), dict(config)))
        return self._results.pop(0)


class SequencedCurationRunner:
    def __init__(self, results):
        self._results = list(results)
        self.models: list[dict] = []

    async def run(self, model, target, on_progress, on_spawn=None):
        self.models.append(dict(model))
        return self._results.pop(0)


def _near_miss_tune(rtp, model=None):
    """A stagnated near-miss whose miss score falls as rtp approaches the
    0.96±0.01 target band (FakeGdd intent + default curation params)."""
    return TuneResult(
        status="near_miss", verdict="near_miss",
        tuned_model=model or {"rows": 5},
        metrics=MetricsWire(rtp=rtp, volatility=4.0, hit_frequency=0.3,
                            base_rtp=rtp, feature_rtp=0.0, bonus_hit_rates=[]),
        ran_at="t1", stop_reason="stagnated")
```

Then the test:

```python
@pytest.mark.asyncio
async def test_near_miss_restarts_seeded_from_best_with_escalation(mongo_db):
    sio = FakeSio()
    tuner = SequencedTunerRunner([_near_miss_tune(0.90, model={"a": 1}),
                                  _pass_tune()])
    recorder = RecordingCurationRunner(_pass_curation())
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                            curation_runner=recorder)
    assert await hub.generate("g1") is True

    # Attempt 2 re-seeded from attempt 1's best model, escalated + reseeded.
    assert len(tuner.calls) == 2
    seed2, cfg2 = tuner.calls[1]
    cfg1 = tuner.calls[0][1]
    assert seed2 == {"a": 1}
    assert cfg2["master_seed"] == cfg1["master_seed"] + 1
    assert cfg2["mutation_rate"] == pytest.approx(min(0.5, cfg1["mutation_rate"] * 1.5))
    assert cfg2["bounds"] == cfg1["bounds"]  # derived once, never from the tuned model

    # Mid-loop verify only for passing tunes: the near-miss was never curated.
    assert recorder.models == [{"rows": 7}]

    # One folded run: best attempt's data + per-attempt telemetry.
    docs = await runs.list_for_game("g1")
    assert len(docs) == 1
    assert docs[0].verdict == "pass"
    assert docs[0].loop_stop == "pass"
    assert [a.attempt for a in docs[0].attempts] == [1, 2]
    assert docs[0].attempts[0].miss_score > 0
    assert docs[0].attempts[1].miss_score == 0.0
    assert docs[0].params.max_attempts == 4  # provenance

    assert sio.phases() == ["tuning", "tuning", "verifying", "done"]
    tuning_payloads = [p for e, p in sio.emits
                       if e == "generate_status" and p["phase"] == "tuning"]
    assert [(p["attempt"], p["maxAttempts"]) for p in tuning_payloads] == [(1, 4), (2, 4)]
    assert sio.count("run_complete") == 1
    assert (await store.get("g1")).tune_result.tuned_model == {"rows": 7}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_math_generate.py::test_near_miss_restarts_seeded_from_best_with_escalation -v`
Expected: FAIL — today a near-miss attempt runs verify immediately and never restarts (`len(tuner.calls) == 1`).

- [ ] **Step 3: Rewrite the hub**

In `studio/backend/app/math/hub.py`:

Add imports:

```python
from app.math.models import (
    AttemptSummaryWire, CurationResult, MathRunDoc, SectionLocks, TuneResult,
    TuningParams, math_run_wire, sim_wire,
)
from app.math.restart import escalate, miss_score
```

**Replace** `request_tune` (lines 113–169) with the per-attempt helper (no save, no terminal emit — the loop owns those):

```python
    # ── one tune attempt (the loop-refactored body of the old request_tune) ──
    async def _tune_attempt(self, game_id: str, seed_model: dict, target: dict,
                            config: dict) -> TuneResult:
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

        result = await self._tuner_runner.run(seed_model, target, config,
                                              on_progress=sync_progress,
                                              on_spawn=self._register_kill(game_id))
        if pending:
            await asyncio.gather(*pending)
        # ponytail: a cancel can land here, between the tuner-runner await
        # returning and the caller's cancelled check — the subprocess already
        # finished, so this is cancel racing natural completion (spec-accepted).
        self._cancels.pop(game_id, None)
        return result
```

**Replace** `_status` (line 212) with:

```python
    async def _status(self, game_id: str, phase: str, *,
                      attempt: int | None = None,
                      max_attempts: int | None = None) -> None:
        payload: dict = {"gameId": game_id, "phase": phase}
        if attempt is not None:
            payload["attempt"] = attempt
            payload["maxAttempts"] = max_attempts
        await self._sio.emit("generate_status", payload, room=game_id)
```

**Replace** the body of `_generate_reserved`'s `try:` block (keep the `except`/`finally` exactly as they are) with the restart loop:

```python
    async def _generate_reserved(self, game_id: str) -> bool:
        try:
            # Capture the params tuned WITH (from the doc at pipeline start), so
            # a user editing GA params mid-pipeline can't mislabel the run's
            # provenance.
            doc0 = await self._store.get_or_seed(game_id)
            params = doc0.tuner_params
            locks = doc0.locks
            model = doc0.model or {}
            max_attempts = params.max_attempts
            await self._status(game_id, "tuning",
                               attempt=1, max_attempts=max_attempts)
            try:
                target = await self._derive_target(game_id, doc0)
            except TargetGap as gap:
                await self._sio.emit("tuning_failed",
                                     {"gameId": game_id, "failure": gap.message},
                                     room=game_id)
                await self._status(game_id, "failed")
                return True
            # Bounds derive from the STORED model once — the search space must
            # not drift as restarts re-seed from tuned (payout-raised) models.
            base_config = build_config(params, derive_bounds(model), locks)
            started = time.monotonic()

            best: TuneResult | None = None
            best_verify: CurationResult | None = None
            best_score = float("inf")
            attempts: list[AttemptSummaryWire] = []
            loop_stop = "attempts_exhausted"
            no_improve = 0

            for attempt in range(1, max_attempts + 1):
                if attempt > 1:
                    await self._status(game_id, "tuning",
                                       attempt=attempt, max_attempts=max_attempts)
                seed = (best.tuned_model
                        if best is not None and best.tuned_model else model)
                result = await self._tune_attempt(
                    game_id, seed, target, escalate(base_config, attempt))
                if game_id in self._cancelled:
                    await self._status(game_id, "cancelled")
                    return True
                if result.status not in ("pass", "near_miss"):
                    # Environmental (crash/watchdog/bad input): terminal, no
                    # retry. An earlier best stays on the doc for Apply; with
                    # no best yet, save the error so the pane can show it.
                    if best is None:
                        await self._store.save_tune_result(game_id, result)
                    await self._sio.emit(
                        "tuning_failed",
                        {"gameId": game_id,
                         "failure": result.failure or "tune failed"},
                        room=game_id)
                    await self._status(game_id, "failed")
                    return True
                verify: CurationResult | None = None
                if result.verdict == "pass":
                    await self._status(game_id, "verifying",
                                       attempt=attempt, max_attempts=max_attempts)
                    verify = await self._verify_tuned(game_id, result.tuned_model)
                    if game_id in self._cancelled:
                        await self._status(game_id, "cancelled")
                        return True
                joint_pass = (result.verdict == "pass"
                              and verify is not None and verify.status == "pass")
                measured = (verify.metrics
                            if verify is not None and verify.status != "error"
                            else result.metrics)
                score = 0.0 if joint_pass else miss_score(measured, target)
                attempts.append(AttemptSummaryWire(
                    attempt=attempt, verdict=result.verdict,
                    stop_reason=result.stop_reason, miss_score=score))
                # A joint pass always wins outright (its raw miss can tie a
                # failed attempt's — e.g. a fail that's in-band on raw distance
                # but outside the verdict's noise-aware gates).
                if joint_pass or best is None or score < best_score:
                    best, best_verify, best_score = result, verify, score
                    await self._store.save_tune_result(game_id, result)
                    no_improve = 0
                else:
                    no_improve += 1
                if joint_pass:
                    loop_stop = "pass"
                    break
                if verify is not None and verify.status == "error":
                    loop_stop = "error"  # environmental — stop with best so far
                    break
                if no_improve >= 2:
                    loop_stop = "not_improving"
                    break

            # Recorded-run contract: verify is always attached. A best whose
            # tune never passed was never verified mid-loop — curate it now.
            if best_verify is None and best.tuned_model:
                await self._status(game_id, "verifying")
                best_verify = await self._verify_tuned(game_id, best.tuned_model)
                if game_id in self._cancelled:
                    await self._status(game_id, "cancelled")
                    return True
            duration_ms = int((time.monotonic() - started) * 1000)
            await self.record_run(game_id, params, best, duration_ms,
                                  verify=best_verify, locks=locks,
                                  attempts=attempts, loop_stop=loop_stop)
            await self._status(game_id, "done")
            return True
        except Exception:
            # (unchanged except/finally — keep the existing comment + logging)
```

**Extend** `record_run`'s signature and doc construction:

```python
    async def record_run(self, game_id: str, params: TuningParams,
                         result: TuneResult, duration_ms: int,
                         verify: CurationResult | None = None,
                         locks: SectionLocks | None = None,
                         attempts: list[AttemptSummaryWire] | None = None,
                         loop_stop: str | None = None) -> MathRunDoc | None:
```

and add `attempts=attempts, loop_stop=loop_stop,` to the `MathRunDoc(...)` kwargs.

Also update the module docstring's mention of `request_tune` (it no longer exists — the generate pipeline's restart loop is the only tune path).

- [ ] **Step 4: Run the new test + the whole generate suite**

Run: `uv --directory studio/backend run pytest tests/test_math_generate.py -v`
Expected: the new test passes. **Two pre-existing tests fail — fix them as designed in Step 5.** Everything else stays green (notably: `test_generate_runs_tune_then_verify_and_persists_one_run` — a joint pass on attempt 1 keeps phases `["tuning","verifying","done"]`; all four cancel tests; the target-gap and tune-error tests).

- [ ] **Step 5: Update the two tests the loop legitimately changes**

1. `test_generate_failed_verify_still_persists_run_with_done_phase` — a pass+verify-fail now restarts by design. Pin it to single-shot to keep testing its actual point (verify-fail is recorded, not a pipeline failure):

```python
@pytest.mark.asyncio
async def test_generate_failed_verify_still_persists_run_with_done_phase(mongo_db):
    """Verify failing is not a pipeline failure: with restarts pinned OFF
    (max_attempts=1 — restart-on-verify-fail has its own test), the pipeline
    finishes 'done' and the run persists with the failing verify attached."""
    from app.math.models import default_tuning_params
    sio = FakeSio()
    hub, store, runs = _hub(mongo_db, sio,
                            tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                            curation_runner=FakeCurationRunner(progress=[], result=_failing_curation()))
    params = default_tuning_params()
    params.max_attempts = 1
    await store.put("g1", tuner_params=params)
    assert await hub.generate("g1") is True
    docs = await runs.list_for_game("g1")
    assert len(docs) == 1
    assert docs[0].verdict == "pass"
    assert docs[0].verify.status == "fail"
    assert docs[0].loop_stop == "attempts_exhausted"
    assert sio.phases() == ["tuning", "verifying", "done"]
```

(assertions unchanged, except `loop_stop`: with `max_attempts=1` the loop ends `attempts_exhausted` — add `assert docs[0].loop_stop == "attempts_exhausted"`.)

2. `test_generate_records_the_tuners_stop_reason` — unchanged behavior, but add the folded-run assertions while here: `assert docs[0].attempts is not None and docs[0].loop_stop == "pass"`.

- [ ] **Step 6: Add the remaining loop tests**

Append to `studio/backend/tests/test_math_generate.py`:

```python
@pytest.mark.asyncio
async def test_pass_with_failing_verify_restarts_and_records_the_passing_attempt(mongo_db):
    sio = FakeSio()
    tuner = SequencedTunerRunner([_pass_tune(), _pass_tune()])
    curation = SequencedCurationRunner([_failing_curation(), _pass_curation()])
    hub, _, runs = _hub(mongo_db, sio, tuner_runner=tuner, curation_runner=curation)
    assert await hub.generate("g1") is True
    assert len(tuner.calls) == 2
    docs = await runs.list_for_game("g1")
    assert len(docs) == 1
    assert docs[0].loop_stop == "pass"
    assert docs[0].verify.status == "pass"   # the joint-pass attempt won
    assert len(docs[0].attempts) == 2
    assert sio.phases() == ["tuning", "verifying", "tuning", "verifying", "done"]


@pytest.mark.asyncio
async def test_error_mid_loop_is_terminal_but_keeps_best_for_apply(mongo_db):
    sio = FakeSio()
    tuner = SequencedTunerRunner([
        _near_miss_tune(0.90, model={"best": 1}),
        TuneResult(status="error", failure="boom", ran_at="t1"),
    ])
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    assert await hub.generate("g1") is True
    assert len(tuner.calls) == 2                       # no third attempt
    assert sio.phases() == ["tuning", "tuning", "failed"]
    assert sio.count("tuning_failed") == 1
    assert await runs.list_for_game("g1") == []        # error → no run recorded
    # ...but Apply still has the best-so-far model.
    assert (await store.get("g1")).tune_result.tuned_model == {"best": 1}


@pytest.mark.asyncio
async def test_static_misses_exit_early_with_not_improving(mongo_db):
    sio = FakeSio()
    tuner = SequencedTunerRunner([_near_miss_tune(0.90, {"m": 1}),
                                  _near_miss_tune(0.90, {"m": 2}),
                                  _near_miss_tune(0.90, {"m": 3})])
    recorder = RecordingCurationRunner(_pass_curation())
    hub, _, runs = _hub(mongo_db, sio, tuner_runner=tuner, curation_runner=recorder)
    assert await hub.generate("g1") is True
    assert len(tuner.calls) == 3                       # stopped before the cap (4)
    docs = await runs.list_for_game("g1")
    assert docs[0].loop_stop == "not_improving"
    assert len(docs[0].attempts) == 3
    assert docs[0].verdict == "near_miss"
    # Final catch-up verify ran once, on the BEST (first) attempt's model.
    assert recorder.models == [{"m": 1}]
    assert sio.phases() == ["tuning", "tuning", "tuning", "verifying", "done"]


@pytest.mark.asyncio
async def test_improving_misses_run_to_the_cap(mongo_db):
    from app.math.models import default_tuning_params
    sio = FakeSio()
    tuner = SequencedTunerRunner([_near_miss_tune(0.90, {"m": 1}),
                                  _near_miss_tune(0.92, {"m": 2}),
                                  _near_miss_tune(0.94, {"m": 3})])
    recorder = RecordingCurationRunner(_pass_curation())
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner, curation_runner=recorder)
    params = default_tuning_params()
    params.max_attempts = 3
    await store.put("g1", tuner_params=params)
    assert await hub.generate("g1") is True
    docs = await runs.list_for_game("g1")
    assert docs[0].loop_stop == "attempts_exhausted"
    scores = [a.miss_score for a in docs[0].attempts]
    assert scores == sorted(scores, reverse=True)      # strictly shrinking misses
    assert recorder.models == [{"m": 3}]               # best = last (closest) attempt
    assert (await store.get("g1")).tune_result.tuned_model == {"m": 3}
    assert docs[0].metrics.rtp == pytest.approx(0.94)  # run carries the best metrics


@pytest.mark.asyncio
async def test_max_attempts_one_is_todays_single_shot(mongo_db):
    from app.math.models import default_tuning_params
    sio = FakeSio()
    tuner = SequencedTunerRunner([_near_miss_tune(0.90)])
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    params = default_tuning_params()
    params.max_attempts = 1
    await store.put("g1", tuner_params=params)
    assert await hub.generate("g1") is True
    assert len(tuner.calls) == 1
    assert sio.phases() == ["tuning", "verifying", "done"]
    assert (await runs.list_for_game("g1"))[0].loop_stop == "attempts_exhausted"


@pytest.mark.asyncio
async def test_cancel_landing_after_an_attempt_stops_the_loop(mongo_db):
    sio = FakeSio()
    holder = {}

    class CancelOnReturnRunner:
        def __init__(self):
            self.calls = 0

        async def run(self, seed_model, target, config, on_progress, on_spawn=None):
            self.calls += 1
            holder["hub"].cancel_generate("g1")   # cancel lands as the attempt ends
            return _near_miss_tune(0.90)

    tuner = CancelOnReturnRunner()
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    holder["hub"] = hub
    assert await hub.generate("g1") is True
    assert tuner.calls == 1                            # no restart after cancel
    assert sio.phases() == ["tuning", "cancelled"]
    assert await runs.list_for_game("g1") == []
    # Cancel is checked BEFORE scoring/saving: nothing was persisted.
    assert (await store.get("g1")).tune_result is None
```

- [ ] **Step 7: Run the full backend suite**

Run: `uv --directory studio/backend run pytest -q`
Expected: all green (including the untouched cancel/error/gap tests).

- [ ] **Step 8: Commit**

```powershell
git add studio/backend/app/math/hub.py studio/backend/tests/test_math_generate.py
git commit -m "feat(math): auto-restart tune loop with best-kept folding and early exit"
```

---

### Task 4: Frontend wire types, socket, and the live attempt indicator

**Files:**

- Modify: `studio/frontend/src/plugins/math/state.ts` (ITuningParams ~line 18; IMathRun ~line 168; IMathState ~line 184; makeInitialState ~line 227)
- Modify: `studio/frontend/src/plugins/math/socketClient.ts` (`generate_status` handler ~line 57)
- Modify: `studio/frontend/src/plugins/math/components/GenerateBar.tsx` (statusText ~line 23)
- Modify (fixture sweep): every spec constructing an `ITuningParams` or `IMathRun` literal — find them with `grep -rn "stagnationWindow:" studio/frontend/src` and `grep -rn "stopReason:" studio/frontend/src` (at least `paramFields.spec.ts`, `ResultStrip.spec.tsx`; possibly `MathPane.spec.tsx`, `actions.spec.ts`, `exportReport.spec.ts`, tab specs).
- Test: `studio/frontend/src/plugins/math/components/GenerateBar.spec.tsx`

**Interfaces:**

- Consumes: backend `generate_status` payload with optional `attempt`/`maxAttempts` (Task 3); `MathRunDoc` wire fields `attempts`/`loopStop`/`params.maxAttempts` (Task 1).
- Produces: `ITuningParams.maxAttempts: number`; `IAttemptSummary { attempt: number; verdict: 'pass' | 'near_miss' | null; stopReason: string | null; missScore: number }`; `IMathRun.attempts: IAttemptSummary[] | null`; `IMathRun.loopStop: 'pass' | 'attempts_exhausted' | 'not_improving' | 'error' | null`; `IMathState.genAttempt: { attempt: number; maxAttempts: number } | null` (init `null`). Tasks 5–7 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `GenerateBar.spec.tsx`'s describe block:

```tsx
it('appends the attempt counter while tuning when the loop can restart', () => {
  mathSlice().genStatus.set('tuning');
  mathSlice().genProgress.set({ generation: 3, maxGenerations: 40 });
  mathSlice().genAttempt.set({ attempt: 2, maxAttempts: 4 });
  render(<GenerateBar />);
  expect(screen.getByTestId('generate-status').textContent).toBe('tuning gen 3/40 (attempt 2/4)');
});

it('appends the attempt counter to verifying and to tuning without progress yet', () => {
  mathSlice().genStatus.set('verifying');
  mathSlice().genAttempt.set({ attempt: 2, maxAttempts: 4 });
  render(<GenerateBar />);
  expect(screen.getByTestId('generate-status').textContent).toBe('verifying… (attempt 2/4)');
});

it('omits the attempt counter for a single-shot run (maxAttempts 1)', () => {
  mathSlice().genStatus.set('tuning');
  mathSlice().genProgress.set({ generation: 3, maxGenerations: 40 });
  mathSlice().genAttempt.set({ attempt: 1, maxAttempts: 1 });
  render(<GenerateBar />);
  expect(screen.getByTestId('generate-status').textContent).toBe('tuning gen 3/40');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx nx test frontend -- GenerateBar`
Expected: FAIL — `genAttempt` doesn't exist on the state (type + runtime).

- [ ] **Step 3: Implement state + socket + GenerateBar**

`state.ts` — add `maxAttempts: number;` to `ITuningParams` (after `stagnationWindow`); add after `IBandMiss`:

```ts
/** One restart-loop attempt folded onto a recorded run (wire: MathRunDoc.attempts). */
export interface IAttemptSummary {
  attempt: number;
  verdict: 'pass' | 'near_miss' | null;
  stopReason: string | null;
  missScore: number;
}
```

`IMathRun` — after `stopReason`:

```ts
  /** Auto-restart telemetry (null on runs that predate the restart loop). */
  attempts: IAttemptSummary[] | null;
  loopStop: 'pass' | 'attempts_exhausted' | 'not_improving' | 'error' | null;
```

`IMathState` — after `genProgress`:

```ts
  /** Live restart-loop position from generate_status (null when single-shot info absent). */
  genAttempt: { attempt: number; maxAttempts: number } | null;
```

and `genAttempt: null,` in `makeInitialState()`.

`socketClient.ts` — extend the `generate_status` handler:

```ts
sock.on('generate_status', (p: { gameId: string; phase: 'tuning' | 'verifying' | 'done' | 'failed' | 'cancelled'; attempt?: number; maxAttempts?: number }) => {
  if (!isActive(p.gameId)) return;
  const s = mathSlice();
  s.genStatus.set(p.phase);
  if (p.phase === 'tuning' || p.phase === 'verifying') {
    s.genAttempt.set(p.attempt != null && p.maxAttempts != null ? { attempt: p.attempt, maxAttempts: p.maxAttempts } : null);
  } else {
    s.genAttempt.set(null);
  }
  if (p.phase === 'tuning') {
    // A fresh attempt: clear the previous artifacts so Evolution streams live.
    // (This also resets frames per RESTART — each attempt is its own evolution.)
    s.genFailure.set(null);
    s.genProgress.set(null);
    s.applied.set(false);
    s.frames.set([]);
    s.selectedGeneration.set('live');
  }
  if (p.phase === 'cancelled') s.genProgress.set(null);
  if (p.phase === 'done') void refreshTuneResult(p.gameId);
});
```

`GenerateBar.tsx` — read the state and build the suffix:

```tsx
const attempt = s.genAttempt.get();
const attemptSuffix = attempt && attempt.maxAttempts > 1 ? ` (attempt ${attempt.attempt}/${attempt.maxAttempts})` : '';
const statusText =
  genStatus === 'tuning'
    ? progress
      ? `tuning gen ${progress.generation}/${progress.maxGenerations}${attemptSuffix}`
      : `tuning…${attemptSuffix}`
    : genStatus === 'verifying'
      ? `verifying…${attemptSuffix}`
      : genStatus === 'done'
        ? 'done'
        : genStatus === 'failed'
          ? 'failed'
          : genStatus === 'cancelled'
            ? 'run cancelled'
            : '';
```

- [ ] **Step 4: Fixture sweep**

`ITuningParams` gained a required field and `IMathRun` two — typecheck now names every literal that must change. Run `npx nx typecheck frontend` and fix each reported fixture: add `maxAttempts: 4` to `ITuningParams` literals (e.g. `paramFields.spec.ts`'s `tunerParams`, `ResultStrip.spec.tsx`'s `baseRun().params`), and `attempts: null, loopStop: null` to `IMathRun` literals (e.g. `baseRun()`). Also update the e2e seed object `FAST_TUNER_PARAMS` in `studio/frontend/e2e/math-plugin.spec.ts` with `maxAttempts: 1` — the existing timing-sensitive tests (1, 2, 5) must stay single-shot so their deterministic windows and "persists nothing" assertions are unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx nx typecheck frontend` then `npx nx test frontend`
Expected: clean typecheck; all vitest suites green including the 3 new GenerateBar cases.

- [ ] **Step 6: Commit**

```powershell
git add studio/frontend/src studio/frontend/e2e/math-plugin.spec.ts
git commit -m "feat(math): live attempt indicator + restart wire types in the studio"
```

---

### Task 5: ResultStrip restart diagnosis

**Files:**

- Modify: `studio/frontend/src/plugins/math/reducers.ts` (add `worstMiss`)
- Modify: `studio/frontend/src/plugins/math/components/ResultStrip.tsx` (~line 57, next to `stopLabel`)
- Test: `studio/frontend/src/plugins/math/reducers.spec.ts`, `studio/frontend/src/plugins/math/components/ResultStrip.spec.tsx`

**Interfaces:**

- Consumes: `IMathRun.attempts`/`loopStop`, `IAttemptSummary`, `IMetrics`, `ITargetSpec` (Task 4); existing `latestOutcome`/`outcomeVerdict`.
- Produces: `worstMiss(metrics: IMetrics, target: ITargetSpec): { metric: string; distance: number; side: 'below' | 'above' } | null` in reducers.ts; a `data-testid="restart-diagnosis"` span in ResultStrip.

- [ ] **Step 1: Write the failing reducer tests**

Append to `reducers.spec.ts` (follow its existing import style; add `worstMiss` to the reducers import and `IMetrics`/`ITargetSpec` types as needed):

```ts
describe('worstMiss', () => {
  const target = { rtp_target: 0.96, rtp_tolerance: 0.01, volatility_min: 3, volatility_max: 6, bonus_hit_rate_bands: [] };
  const metrics = (rtp: number, vol: number) => ({ rtp, volatility: vol, hitFrequency: 0.3, baseRtp: rtp, featureRtp: 0, bonusHitRates: [] });

  it('returns null when every gate is in band', () => {
    expect(worstMiss(metrics(0.96, 4), target)).toBeNull();
  });

  it('reports the below-band rtp distance', () => {
    expect(worstMiss(metrics(0.9, 4), target)).toEqual({ metric: 'rtp', distance: expect.closeTo(0.05, 10), side: 'below' });
  });

  it('picks the RELATIVELY worse gate when several miss', () => {
    // rtp miss 0.05/0.02 = 2.5 band-widths; vol miss 1/3 band-widths → rtp wins.
    expect(worstMiss(metrics(0.9, 7), target)!.metric).toBe('rtp');
  });

  it('normalizes an open-ended volatility band by its finite edge', () => {
    const high = { ...target, volatility_min: 10, volatility_max: 1e9 };
    // vol 5 → miss 5, rel 5/10 = 0.5; rtp in band → vol is the (only) miss.
    expect(worstMiss(metrics(0.96, 5), high)).toEqual({ metric: 'volatility', distance: 5, side: 'below' });
  });
});
```

- [ ] **Step 2: Write the failing ResultStrip tests**

Append to `ResultStrip.spec.tsx`'s describe (note: `baseRun` gained `attempts: null, loopStop: null` in Task 4; `target` must be set for the miss fragment):

```tsx
const failedVerify = () => ({
  status: 'fail' as const,
  metrics: { ...baseRun().metrics!, rtp: 0.9 },
  realizedRtp: 0.9,
  poolSize: 100,
  failure: 'out of band',
  ranAt: '2026-01-02T00:00:00Z',
});
const target = { rtp_target: 0.96, rtp_tolerance: 0.01, volatility_min: 3, volatility_max: 6, bonus_hit_rate_bands: [] };
const attempts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ attempt: i + 1, verdict: 'near_miss' as const, stopReason: 'stagnated', missScore: 2.5 }));

it('shows the not-improving diagnosis with the worst gate miss', () => {
  mathSlice().derivedTarget.set(target);
  mathSlice().runs.set([baseRun({ verdict: 'near_miss', verify: failedVerify(), attempts: attempts(3), loopStop: 'not_improving' })]);
  render(<ResultStrip />);
  const text = screen.getByTestId('restart-diagnosis').textContent!;
  expect(text).toContain('3 attempts');
  expect(text).toContain('best miss: rtp 0.05 below band');
  expect(text).toContain('misses not shrinking — target likely infeasible');
});

it('shows the attempts-exhausted diagnosis', () => {
  mathSlice().derivedTarget.set(target);
  mathSlice().runs.set([baseRun({ verdict: 'near_miss', verify: failedVerify(), attempts: attempts(4), loopStop: 'attempts_exhausted' })]);
  render(<ResultStrip />);
  expect(screen.getByTestId('restart-diagnosis').textContent).toContain('attempt budget exhausted');
});

it('a pass after restarts reads target reached on attempt n/max', () => {
  mathSlice().runs.set([
    baseRun({
      params: { ...baseRun().params, maxAttempts: 4 },
      attempts: [...attempts(1), { attempt: 2, verdict: 'pass', stopReason: 'feasible', missScore: 0 }],
      loopStop: 'pass',
    }),
  ]);
  render(<ResultStrip />);
  expect(screen.getByTestId('restart-diagnosis').textContent).toBe('target reached on attempt 2/4');
});

it('renders no diagnosis for legacy runs or single-attempt passes', () => {
  mathSlice().runs.set([baseRun()]); // attempts: null (legacy)
  render(<ResultStrip />);
  expect(screen.queryByTestId('restart-diagnosis')).toBeNull();
  mathSlice().runs.set([baseRun({ attempts: [{ attempt: 1, verdict: 'pass', stopReason: 'feasible', missScore: 0 }], loopStop: 'pass' })]);
  render(<ResultStrip />);
  expect(screen.queryByTestId('restart-diagnosis')).toBeNull();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx nx test frontend -- reducers` and `npx nx test frontend -- ResultStrip`
Expected: FAIL — `worstMiss` not exported; `restart-diagnosis` testid absent.

- [ ] **Step 4: Implement**

`reducers.ts` — extend the state import with `IMetrics`, `ITargetSpec`, then add:

```ts
/** The single worst out-of-band gate (by band-width-relative distance) — the
 * headline of the ResultStrip's restart diagnosis. Distance is RAW (display
 * units); relative distance only picks the winner. Null = every gate in band. */
export function worstMiss(metrics: IMetrics, target: ITargetSpec): { metric: string; distance: number; side: 'below' | 'above' } | null {
  const OPEN = 1e8; // volatility 'high' → hi=1e9: normalize by the finite edge
  const gates = [
    { metric: 'rtp', measured: metrics.rtp, lo: target.rtp_target - target.rtp_tolerance, hi: target.rtp_target + target.rtp_tolerance },
    { metric: 'volatility', measured: metrics.volatility, lo: target.volatility_min, hi: target.volatility_max },
    ...target.bonus_hit_rate_bands.map((b, i) => ({ metric: `bonus[${i}]`, measured: metrics.bonusHitRates[i] ?? 0, lo: b.min, hi: b.max })),
  ];
  let worst: { metric: string; distance: number; side: 'below' | 'above'; rel: number } | null = null;
  for (const g of gates) {
    if (g.measured >= g.lo && g.measured <= g.hi) continue;
    const width = Math.max(g.hi - g.lo > OPEN ? Math.abs(g.lo) : g.hi - g.lo, 1e-9);
    const distance = g.measured < g.lo ? g.lo - g.measured : g.measured - g.hi;
    const rel = distance / width;
    if (!worst || rel > worst.rel) worst = { metric: g.metric, distance, side: g.measured < g.lo ? 'below' : 'above', rel };
  }
  return worst ? { metric: worst.metric, distance: worst.distance, side: worst.side } : null;
}
```

`ResultStrip.tsx` — import `worstMiss`, compute below `stopLabel`:

```tsx
const attempts = outcome?.kind === 'run' ? outcome.run.attempts : null;
const loopStop = outcome?.kind === 'run' ? outcome.run.loopStop : null;
const runMaxAttempts = outcome?.kind === 'run' ? outcome.run.params.maxAttempts : 0;
const miss = !running && verdict !== 'pass' && metrics && target ? worstMiss(metrics, target) : null;
const restartDiagnosis =
  running || !attempts || attempts.length === 0
    ? null
    : verdict === 'pass'
      ? attempts.length > 1
        ? `target reached on attempt ${attempts[attempts.length - 1].attempt}/${runMaxAttempts}`
        : null
      : [
          `${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`,
          miss ? `best miss: ${miss.metric} ${Number(miss.distance.toPrecision(2))} ${miss.side} band` : null,
          loopStop === 'not_improving'
            ? 'misses not shrinking — target likely infeasible'
            : loopStop === 'attempts_exhausted'
              ? 'attempt budget exhausted'
              : loopStop === 'error'
                ? 'verification errored'
                : null,
        ]
          .filter(Boolean)
          .join(' · ');
```

and render next to the stop-reason span (inside the same flex row):

```tsx
{
  restartDiagnosis && (
    <span data-testid="restart-diagnosis" className="text-text-3">
      {restartDiagnosis}
    </span>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx nx test frontend` and `npx nx typecheck frontend`
Expected: all green.

- [ ] **Step 6: Commit**

```powershell
git add studio/frontend/src/plugins/math
git commit -m "feat(math): restart diagnosis line on the ResultStrip"
```

---

### Task 6: Param sidebar — the Attempts knob

**Files:**

- Modify: `studio/frontend/src/plugins/math/components/paramFields.ts` (insert after the `stagnation` field, ~line 127)
- Test: `studio/frontend/src/plugins/math/components/paramFields.spec.ts`

**Interfaces:**

- Consumes: `ITuningParams.maxAttempts` (Task 4).
- Produces: field def key `'attempts'` in group `'search'` (testid `param-attempts` via ParamField's existing rendering) — no other component changes; ParamSidebar renders the registry.

- [ ] **Step 1: Update the registry spec (failing first)**

In `paramFields.spec.ts`: add `maxAttempts: 4,` to the `tunerParams` fixture (done in Task 4 if typecheck flagged it — verify); bump the two `18`s to `19` in the unique-keys test; add `attempts: 4,` to the defaults `toMatchObject`; and in the group-order test change the search line to:

```ts
expect(byGroup('search')).toEqual(['population', 'generations', 'search-spins', 'final-spins', 'stagnation', 'attempts']);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx nx test frontend -- paramFields`
Expected: FAIL — 18 ≠ 19 and the group-order mismatch.

- [ ] **Step 3: Add the field def**

Insert into `PARAM_FIELDS` directly after the `stagnation` entry:

```ts
  {
    key: 'attempts',
    label: 'Attempts',
    group: 'search',
    tooltip: {
      title: 'Max attempts',
      body: 'Automatic whole-tune restarts when the search stagnates or fails verification; each restart re-seeds from the best model so far with a higher mutation rate and a fresh seed.',
      effect: 'Higher = more chances to escape an unlucky search; 1 = single shot.',
    },
    min: 1,
    max: 10,
    step: 1,
    integer: true,
    defaultValue: 4,
    get: (s) => s.tunerParams.ornull?.maxAttempts.get() ?? null,
    set: (s, v) => s.tunerParams.ornull?.maxAttempts.set(v),
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend -- paramFields` (the generic tooltip/step/round-trip/resetGroup tests pick the new field up automatically), then `npx nx typecheck frontend`.
Expected: all green.

- [ ] **Step 5: Commit**

```powershell
git add studio/frontend/src/plugins/math/components
git commit -m "feat(math): Attempts knob in the param sidebar search group"
```

---

### Task 7: E2e restart coverage + full gates

**Files:**

- Modify: `studio/frontend/e2e/math-plugin.spec.ts` (append Test 8)
- Run: full backend + frontend gates and the math e2e spec

**Interfaces:**

- Consumes: everything above end-to-end: `maxAttempts` via `PUT /games/{id}/tuner`, live `(attempt 2/2)` in `generate-status`, `restart-diagnosis` testid, `attempts`/`loopStop` on `GET /analytics/runs`.
- Produces: the authoritative behavioral contract for auto-restart (AGENTS.md: Playwright is the source of truth).

- [ ] **Step 1: Append the e2e test**

```ts
// ---------------------------------------------------------------------------
// Test 8 — auto-restart: an infeasible target exhausts the attempt budget and
// FAILs with a diagnosis (spec 2026-07-06-auto-restart-tune-design.md). The
// 5000% RTP intent is unreachable by construction, so every attempt near-misses
// deterministically; maxAttempts 2 keeps the run short.
// ---------------------------------------------------------------------------

const RESTART_TUNER_PARAMS = {
  ...FAST_TUNER_PARAMS,
  population: 8,
  maxGenerations: 6,
  stagnationWindow: 4,
  searchCandidateCount: 20000,
  finalCandidateCount: 20000,
  maxAttempts: 2,
};

test('auto-restart: infeasible target exhausts attempts and fails with a diagnosis', async ({ page, request }) => {
  test.setTimeout(180_000);
  const gameId = await setupGame(page, request, 'frank', `restart ${Date.now()}`, {
    model: DETUNED,
    simParams: FAST_SIM_PARAMS,
    tunerParams: RESTART_TUNER_PARAMS,
    intent: { rtp: '5000%', volatility: 'low' }, // 50x RTP: unreachable by construction
  });
  await openMath(page);
  await page.getByTestId('generate-button').click();

  // The restart itself is observable live in the status line.
  await expect.poll(() => page.getByTestId('generate-status').innerText(), { intervals: [50], timeout: 120_000 }).toContain('attempt 2/2');

  await expect(page.getByTestId('generate-status')).toContainText('done', { timeout: 120_000 });

  // Terminal non-pass with the machine's diagnosis, not "try again".
  await expect(page.getByTestId('result-verdict')).toContainText(/FAIL|ERROR|NEAR-MISS/);
  const diagnosis = await page.getByTestId('restart-diagnosis').innerText();
  expect(diagnosis).toContain('2 attempts');
  expect(diagnosis).toContain('best miss');

  // One folded run with per-attempt telemetry.
  const r = await request.get(`${BACKEND}/analytics/runs?game_id=${gameId}`);
  const runs = (await r.json()) as { attempts: { attempt: number }[] | null; loopStop: string | null }[];
  expect(runs).toHaveLength(1);
  expect(runs[0].attempts).toHaveLength(2);
  expect(runs[0].loopStop).toBe('attempts_exhausted');
});
```

- [ ] **Step 2: Run all cheap gates first**

From the worktree root:

```powershell
uv --directory studio/backend run pytest -q
& node_modules\.bin\prettier.cmd --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
```

Expected: all green. (If `node_modules` is missing in the fresh worktree, run `npm install` and `uv --directory studio/backend sync` first — `just bootstrap`.)

- [ ] **Step 3: Run the math e2e spec against a replay backend on THIS worktree's ports**

Terminal 1 (background), from the worktree root: `just backend-serve-replay` (serves :8001 via the worktree's `.env` `BLOOM_PORT_OFFSET=1`; uses `bloom_studio_wt1` data on the shared mongod — start mongo first with `just mongo-up` if it isn't running). If `just` fails with "could not find the shell sh", prepend Git's tools: `$env:Path = "C:\Program Files\Git\usr\bin;$env:Path"` and retry.

Then:

```powershell
$env:BLOOM_PORT_OFFSET = '1'
npx playwright test --config=studio/frontend/playwright.config.ts e2e/math-plugin.spec.ts
```

Expected: all 8 tests pass (the 7 pre-existing ones prove no regression — tests 1/2/5 were pinned to `maxAttempts: 1` in Task 4; the new Test 8 proves the restart). The tuner binary must be built first: `cargo build --release -p bloom-simulator -p bloom-tuner`.

- [ ] **Step 4: Commit**

```powershell
git add studio/frontend/e2e/math-plugin.spec.ts
git commit -m "test(math): e2e auto-restart coverage (infeasible target diagnosis)"
```

---

## Out of scope (recorded so nobody "helpfully" adds them)

- Rust-side warm restarts in `genetic.rs` (deferred upgrade per spec).
- A `max_attempts` argument on the `set_tuner_params` agent tool — the tool's partial-merge (`model_dump` → validate) already round-trips the field untouched; exposing it to the agent is a later slice if asked for.
- Restarting Verify-only; wall-clock caps; `analytics_progress` attempt fields (frame reset rides the per-attempt `tuning` status).
