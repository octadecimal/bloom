# Auto-restart tuner runs — design

**Date:** 2026-07-06
**Status:** approved for planning
**Depends on:** noise-aware verdicts (#156), generate-cancel (#150), fresh-final-seed verify (#152)

## Problem

A tune run that stagnates or exhausts its generation budget surfaces FAIL and the
user must click Generate again. Principle: **never make the human do the
retrying** — the machine exhausts the search budget itself. A terminal FAIL
should only mean "likely infeasible", with a diagnosis (closest achieved
metrics, per-gate miss distance, a note when misses aren't shrinking across
restarts) — never "unlucky seed, try again".

Post-#156, borderline-noise FAILs are gone; remaining FAILs are mostly
unlucky-search stagnation (automatable) or genuinely infeasible targets (must
stay a bounded, well-explained FAIL).

## Decision summary

- **Pipeline-level restart loop** in `MathHub._generate_reserved`
  (`studio/backend/app/math/hub.py`). Python-only; the Rust binary stays
  single-shot. Restarts inside `genetic.rs` (warm restarts, population reuse)
  are the deferred upgrade if hit-rate disappoints — it can never cover the
  verify-FAIL case, so this loop stays regardless.
- **Restartable outcomes:** tune verdict `near_miss`, OR tune `pass` + fresh-seed
  verify `fail`. Both are "unlucky search" per the principle.
- **Terminal outcomes:** joint pass; `error` (environmental — crash/watchdog —
  never retried); cancel; attempts cap; early exit when misses stop shrinking.
- **Attempts cap** is a user-visible `TuningParams.max_attempts` (default 4,
  min 1 = today's single-shot behavior), shown in the param sidebar and
  recorded in run provenance. Not passed to the binary.
- **One folded run per Generate click**: a single `MathRunDoc` carrying the
  best attempt's model/metrics/trace/profile plus a per-attempt summary array.
- A `RestartingTunerRunner` wrapper around the `TunerRunner` seam was
  **rejected**: it cannot see the verify step, cannot distinguish a cancel-kill
  from a crash (it would restart a run the user just cancelled), and cannot
  check the hub's cancelled-set.

## Loop & attempt semantics

`request_tune`'s body is refactored into a per-attempt helper (the pipeline is
its only caller). The pipeline derives the target and gene bounds **once** per
click from the stored model — bounds must not drift as payouts get tuned.

Per attempt `n` (1-based):

- **Seed model:** stored model on attempt 1; best-so-far tuned model after.
- **Master seed:** `base_master_seed + (n - 1)` — deterministic, reproducible.
- **Mutation escalation:** `mutation_rate = min(0.5, base × 1.5^(n-1))` —
  diversity via the existing knob. All other GA params unchanged.
- **Verify** (fresh-seed curation, #152) runs only when the attempt's tune
  verdict is `pass` — verifying a known near-miss mid-loop wastes a full
  curation pass.
- **Miss score** (Python-side; ranking + diagnosis only, not a verdict): sum
  over gates (rtp, volatility, bonus hit-rates) of distance-to-band normalized
  by band width, computed from verify metrics when verify ran, else tune
  metrics. Joint pass scores 0. Guard zero/degenerate band widths with an
  epsilon.
- **Best-so-far:** the attempt with the lowest miss score. On each improvement
  the best result is persisted via `save_tune_result`, so Apply always
  hydrates the best model, even mid-loop or after a cancel.
- **Early exit:** after 2 consecutive restarts with no miss-score improvement
  (despite escalated mutation), stop before the cap — the target is likely
  infeasible; more restarts won't help.
- **Final verify contract:** if the loop ends with a best attempt that was
  never verified (a near_miss), run one verify on it so the recorded run keeps
  the existing verify-attached contract of `record_run`.
- `tuning_failed` is emitted only for terminal errors/target gaps, never per
  attempt.

Worst-case wall clock ≈ `max_attempts × tuner_timeout_s` + verifies (~10 min at
defaults) — acceptable because cancel (#150) stays live throughout and each
attempt keeps its own subprocess watchdog.

## Data & wire changes

- `TuningParams.max_attempts: int` (default 4, `ge=1`, `le=10`). Excluded from `build_config`'s binary payload. Flows to the TS
  `ITuningParams` and the param sidebar's search group with a tooltip.
- `MathRunDoc` gains:
  - `attempts: [{attempt, verdict, stopReason, missScore}]` — one entry per
    attempt, in order.
  - `loop_stop: 'pass' | 'attempts_exhausted' | 'not_improving' | 'error'` — facts only; (`'error'` = a mid-loop verify errored: environmental, loop stopped early with the best so far).
- Socket event `generate_status` (while `phase` is `tuning`/`verifying`) gains `attempt` / `maxAttempts`. `analytics_progress` is unchanged — the frontend already resets frames on every `tuning` status, so each attempt gets a fresh Evolution timeline for free.
- No Rust/NDJSON protocol changes.

## UI (`studio/frontend/src/plugins/math/`)

- Status line while running: `tuning (attempt 2/4)`.
- Evolution frames reset when the incoming `attempt` advances (reducer keys off
  the event field) — each attempt is its own evolution.
- ResultStrip terminal non-pass extends the existing stop-reason line with the
  restart diagnosis, e.g.
  `4 attempts · best miss: rtp 0.0031 below band · misses not shrinking — target likely infeasible`.
  The per-gate `missed` table it already renders is the rest of the diagnosis.
  A pass after restarts reads `target reached on attempt 2/4`.
- Runs recorded before this feature have `attempts == null` — render exactly as
  today.

## Cancel & error composition

- The cancelled-set is checked at every attempt boundary and **before**
  classifying a killed subprocess's `error` result, so a cancel-kill can never
  trigger a restart.
- `error` results (bad input, crash, watchdog memory/timeout kill) are
  environmental, not unlucky search: terminal immediately, no retry.
- The `_register_kill` / `_cancels` plumbing is re-armed per attempt (each
  attempt spawns a fresh subprocess).

## Testing

TDD unit coverage (backend, `test_math_generate.py` style) driven by a
sequenced fake runner returning per-call results:

- near_miss → restarts with escalated mutation + incremented seed + best-model
  seeding (assert on the actual config/seed passed to the runner).
- pass + verify-fail → restarts; joint pass → stops.
- error → terminal, no retry; cancel between attempts → no further attempts.
- Best-kept ranking across attempts (later worse attempt doesn't clobber best);
  `save_tune_result` holds the best model.
- Bounds derived once (identical across attempts despite tuned payouts).
- Early exit after 2 non-improving restarts; `max_attempts=1` ≡ today's
  behavior.
- Folded `MathRunDoc` shape: attempts array, `loop_stop`, best attempt's
  trace/metrics/profile, final-verify-on-near-miss contract.

Frontend vitest: reducers (attempt in status payload, frame reset on attempt
advance) and ResultStrip diagnosis rendering (all three `loop_stop` phrasings +
legacy runs without `attempts`).

Playwright e2e (authoritative, run locally via `just e2e`): extend the math
generate spec so a replay run exercises at least one restart and asserts the
attempt indicator and the final verdict + diagnosis line.

## Out of scope / deferred

- Rust-side warm restarts (population reuse) in `genetic.rs`.
- Restarting the Verify-only path (it doesn't tune; nothing to restart).
- Wall-clock cap (attempts cap + per-attempt watchdog suffice).
