# Noise-aware math verdicts + GA re-centering — design

**Date:** 2026-07-05
**Status:** approved
**Scope:** `bloom-simulator` verify, `bloom-tuner` fitness/stop logic, `curate_json`/`tune_json`
wire, math-pane ResultStrip.

## 1. Problem

`rtp_tolerance` ±0.005 is smaller than the measurement standard error at 200k spins
(SE = vol/√n ≈ 0.0063 at vol 2.8), so the tuner's feasibility confirmation and the
simulator's verify are two independent sub-SE coin flips over the same true value.
Diagnosed live 2026-07-05 (game `856d891b`, reproducible — fixed seeds make the
contradiction identical every Generate):

- Tuner confirm read RTP **0.9694** → in band 0.960–0.970 → instant gen-0 "feasible".
  The GA changed nothing because fitness is a flat 0.0 anywhere in-band.
- Verify read **0.9819** → FAIL. Best-estimate true RTP ≈ **0.9756** — genuinely out
  of band, which the gen-0 stop never tried to fix.
- A perfectly centered model still fails verify ~43% at these settings.

Two defects, one root cause (verdicts ignore measurement noise; fitness ignores
band position):

1. **Inconsistent gates** — pass/fail is a hard band check on a noisy measurement.
2. **No centering pressure** — a borderline in-band seed stops the search untouched,
   so the shipped model's _true_ value can sit at (or past) the band edge.

## 2. Decisions (made during brainstorming)

| Decision      | Choice                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict rule  | Two-tier (Pass / NearMiss), CI-overlap: pass iff every band miss ≤ k·SE. Same rule, same k in **both** gates (tuner confirm and verify).                                                            |
| k             | **2.0** (~95% two-sided). Shared constant `K_SIGMA` in `bloom-simulator`; no config knob.                                                                                                           |
| SE estimation | Analytic, all metrics: `SE_rtp = vol/√n`, `SE_hit[i] = √(p(1−p)/n)`, `SE_vol = vol/√(2n)` (normal approximation, documented; harmless because volatility bands are whole units wide). No bootstrap. |
| Feasible stop | Centered-and-stagnated: the confirm gate fires only when the search stagnates, never instantly on an in-band reading.                                                                               |
| UI exposure   | ResultStrip shows `±2·SE` inline; a pass whose measurement sits outside the band but within the allowance gets a "within noise" chip + tooltip. SE rides the wire as an additive `se` object.       |

Rejected alternatives: tolerance widening and brute-force spins (treat the symptom),
a three-tier verdict (confident / within-noise / fail — more honest but adds a verdict
tier through Rust→Python→wire→UI; the "within noise" chip recovers most of the honesty
at a fraction of the surface), asymmetric strict-confirm/lenient-verify (leaves the
confirm gate flipping coins against itself), bootstrap SE (real compute + seeded
determinism burden, buys nothing over vol/√n for RTP, which is exact).

## 3. Design

### 3.1 Noise-aware verdicts (`studio/simulator`)

`studio/simulator/src/target.rs` gains:

```rust
pub const K_SIGMA: f64 = 2.0;

#[derive(Debug, Clone, PartialEq)]
pub struct MetricSE {
    pub rtp: f64,               // volatility / √n  (exact: SE of a sample mean)
    pub volatility: f64,        // volatility / √(2n)  (normal approximation)
    pub bonus_hit_rates: Vec<f64>, // √(p(1−p)/n) per bonus
}

pub fn standard_errors(m: &Metrics, n: usize) -> MetricSE
```

`bloom_simulator::run::verify` changes signature to `verify(metrics, target, n)` and
passes iff **every** band miss is ≤ `K_SIGMA · SE` for that metric (RTP, volatility,
each bonus hit rate). Every caller already has `n`: `run_curation_streamed` uses
`samples.len()`; the tuner uses its panel sizes. The existing bands-count assertion
stays.

`curate_json` and `tune_json` result lines gain an additive object:

```json
"se": { "rtp": 0.0063, "volatility": 0.0044, "bonusHitRates": [0.0002] }
```

Nothing existing on the wire changes shape or name.

### 3.2 GA fitness re-centering (`studio/tuner/src/fitness.rs`)

Fitness keeps a **hard-band** in/out split — fitness is a same-fidelity _ordering_
heuristic for candidates measured on common random numbers; SE belongs to verdicts,
not to ranking:

- **Out-of-band:** `−1 − weighted_miss` (today's weighted distance `d`, shifted down
  by 1). Every in-band candidate strictly outranks every out-of-band candidate;
  "closer to band scores higher" is preserved among out-of-band candidates.
- **In-band:** `−center_dist`, where `center_dist ∈ [0, 1]` is the mean of
  `|rtp − rtp_target| / rtp_tolerance` and, per bonus, `|rate − band_center| /
band_half_width`, weighted by the existing `Weights` (`w.rtp` for the RTP
  component, `w.hit_rate` for each bonus component) and divided by the total weight
  used, so it stays in `[0, 1]`. Denominators are clamped with `.max(1e-9)` like the
  existing normalizations. **Volatility contributes no centering term**: its bands
  are semantic ranges ("low" = 0–3, "high" = 10–1e9); a midpoint is meaningless and
  centering toward it would distort models for nothing.

`fitness == 0.0` now means _dead center_, not merely in-band. The pinned
`zero_fitness_iff_verify_passes` test is deliberately retired, replaced by two new
invariants: (a) any in-band candidate outranks any out-of-band candidate; (b) among
in-band candidates, fitness is monotone in distance-to-center.

`band_misses` becomes noise-aware — `band_misses(m, t, n)` lists only misses beyond
the `K_SIGMA · SE` allowance — so `Verdict::NearMiss { missed }` stays exactly
consistent with `verify`.

### 3.3 Tuner stop rework (`studio/tuner/src/genetic.rs`)

The instant `scored[0].1 >= 0.0` feasibility check is removed (with centering it
would only fire at a measured dead-center — effectively never). New loop tail, in
order per generation:

1. Score, track best/improved/stagnation as today.
2. When `stagnation >= stagnation_window`:
   - **Prefilter:** noise-aware `verify` of the current generation top's
     search-fidelity measurement (`bm`, `n = search_candidate_count`). Search SE is
     large, so this is a lenient sanity gate: a centered model ~always passes; an
     unreachable target (miss ≫ 2·SE) fails → `StopReason::Stagnated`, break. This
     keeps hopeless runs ending early and keeps "Stagnated" meaning "gave up
     out-of-band".
   - **Confirm:** fresh-panel confirmation at final fidelity — the existing
     per-generation `confirmation_seeds` machinery from #152, unchanged — judged by
     noise-aware `verify` with `n = final_candidate_count`. Pass →
     `StopReason::Feasible`, break. Fail → reset `stagnation` to 0 and keep
     searching (bounded: ≤ `max_generations / stagnation_window` confirm attempts
     per run, same order as today's per-in-band-generation attempts).
3. Budget path unchanged (`max_generations` exhausted → `StopReason::Budget`).

Winner selection is structurally unchanged, including the **never-worse-than-seed
head-to-head** from #148 (base final panel, common random numbers, raw seed model as
its own candidate). It now compares with the centering-aware fitness, which is
aligned with the new objective: among in-band candidates, closer to center wins. The
final verdict is the noise-aware `verify` on the returned model's final-fidelity
measurement (confirmation panel on a Feasible stop, base final panel otherwise —
same panels as today).

`StopReason` names and meanings survive: **Feasible** = confirmed in-band at final
fidelity, **Stagnated** = gave up out-of-band, **Budget** = generations exhausted.
What changes is _when_ they fire: the live borderline case (seed measured 0.9694,
band 0.960–0.970) now evolves for ~a stagnation window toward 0.965 before
confirming, instead of stopping at gen 0 untouched.

### 3.4 Backend, wire, UI

- **Backend (`app/math`):** no logic change. `derive_target` and `_verify_tuned` are
  untouched — pass/fail arrives from the binaries. The `se` object rides through the
  schemaless metrics dicts into `MathRunDoc`, the analytics `math_runs` store, and
  the socket wire.
- **Frontend wire types:** metrics gain an optional `se` field (additive).
- **ResultStrip:** metric values render with their allowance — `rtp 0.9819 ±0.013` —
  and when a metric is measured outside its band while the overall verdict is a
  pass, a small "within noise" chip appears with a tooltip stating the band, the SE,
  and the rule (`pass = miss ≤ 2·SE`). Old runs without `se` render exactly as
  today (field optional, chip logic short-circuits).
- Verdict strings (`pass` / `near_miss`), `outcomeVerdict`, and the reducers are
  untouched.

## 4. Blast radius

- **Frozen templates** (`studio/backend/tools/freeze_template.py`): the verify rule
  only _widens_, so every stored pass stays a pass. No re-freeze. The JSON contract
  change is additive.
- **Rust unit tests:** `stop_reason_feasible_when_target_reached`,
  `stop_reason_stagnated_when_no_improvement`, and the #148/#152 protection tests
  (`tuned_model_never_worse_than_seed_at_final_fidelity`,
  `feasible_stop_is_confirmed_at_final_fidelity`,
  `confirmation_panels_differ_per_generation_and_from_the_selection_panel`,
  `feasible_verdict_is_measured_on_the_confirmation_panel`) keep their intent and
  adapt their mechanics (feasible now arrives via the stagnation path; the
  confirmation-panel identity assertion re-derives the stop generation the same
  way). `converges_a_detuned_model_back_into_band` still passes — the toy has exact
  0.9 solutions and centering pulls toward them. `zero_fitness_iff_verify_passes`
  is retired per §3.2.
- **E2e** (`math-plugin.spec.ts`, `tuner-chat.spec.ts`; local-only per repo CI
  policy): PASS assertions hold. Two known touch-points:
  1. The "deterministically runs 5 generations" comment/timing window changes —
     runs now go to stagnation, so the RUNNING-badge window gets _wider_ (safer for
     the existing polls).
  2. The `measuredRtp` within `0.9 ± rtpTolerance` assertion is at genuine risk:
     FAST params are 20k spins and the toy's SD ≈ 1.45, so 2·SE ≈ 0.0205 ≈ the 0.02
     tolerance — a legitimate noise-pass can land outside it. Seeds are fixed, so
     the plan re-runs the suite once and, only if the deterministic value actually
     lands outside, widens that assertion to `tolerance + 2·SE`.
- **Cassettes:** replay cassettes cover LLM/provider calls only; the Rust binaries
  run for real in e2e. No cassette invalidation.
- **Analytics:** run docs gain `se` inside metrics (additive); charts unchanged this
  slice.

## 5. Testing (TDD, mandatory)

All work in the `noise-aware-verdicts` worktree (`BLOOM_PORT_OFFSET=1` — backend
:8001, frontend :4201; never the primary checkout's default ports). RED-GREEN per
unit:

- **Simulator:** SE formulas against hand-computed values; verify boundary cases —
  miss exactly at `2·SE` passes, `2·SE + ε` fails, per metric; `n` plumbed from
  `samples.len()`; `curate_json` result line carries `se`.
- **Tuner:** fitness ordering invariants (§3.2); borderline-in-band seed no longer
  stops at gen 0 and returns a model measurably closer to center; unreachable
  target still ends `Stagnated` early via the prefilter; confirm-fail resets
  stagnation and the run remains bounded by budget; determinism (same master seed →
  identical outcome) and the adapted #148/#152 protections.
- **Backend:** `se` pass-through into `MathRunDoc` and the wire (existing
  fixture-based service tests).
- **Frontend:** vitest for the ResultStrip `±SE` rendering and the "within noise"
  chip (present only when outside-band-but-pass; absent for old runs without `se`).
- **E2e:** full math suite (`just e2e` against the replay backend on the worktree
  ports) before the PR.

## 6. Out of scope

- Homing the target band / deriving `rtp_tolerance` from spin count (the residual
  "tolerance smaller than SE" tension is now _reported honestly_ rather than
  resolved; raising `candidate_count` remains the designer's lever).
- Bootstrap/heavy-tail-exact SE, per-band pass probabilities, CI bars in analytics
  charts (deferred "full confidence readout").
- Any change to package format, curation/freeze guardrails, or the runtime server.
