# Bloom — Math Engine (slots) + Simulator (curation) Design

- **Date:** 2026-06-23
- **Status:** Approved (design); ready for an implementation plan
- **Scope:** Enrich the certified slot **math engine** so a spin resolves to a
  _payout_, and build the studio **simulator** that measures a model's
  characteristics and freezes a faithful, signed seed pool. Decomposes from the
  umbrella architecture §16 build-order items 1 (math engine) and 4 (simulator
  curation slice).
- **Reads first:** [`docs/north-star.md`](../../north-star.md),
  [umbrella architecture](2026-06-18-bloom-platform-architecture-design.md) (esp.
  §3 the law, §4 the seed-pool math, §7 mechanic abstraction, §9 determinism/audit,
  §10 outcome-vs-payout), [`trusted/AGENTS.md`](../../../trusted/AGENTS.md).

---

## 1. What this delivers (and what it deliberately does not)

This effort builds the two innermost layers of the seed-pool pipeline:

1. **Math engine (`trusted/math`) — enrich.** Replace the toy single-row
   `slots::expand` with a full **round evaluation** that turns one seed into one
   round's _symbolic outcome **and** its payout_ (in bet-multiples), including a
   free-spins bonus round.
2. **Simulator (`studio/simulator`) — build (new Rust crate).** Take a structured
   math model, simulate millions of rounds through the math engine, **measure**
   RTP / volatility / hit-rates, **verify** them against targets, **freeze** a
   faithful seed pool, and **build + sign** a game package.

**Out of scope (deferred, by decision):**

- **Layer 3 — tuning toward targets.** Automatically adjusting a model's
  parameters (strips/paytable/feature config) to _hit_ the targets. For now a human
  edits the model and re-runs. A deterministic optimizer and/or the AI
  math-designer agent come later, in `studio/backend`. See §8.
- **The game server** (`runtime/server`) — not built here. But this design keeps
  the math engine as the shared core the server will reuse verbatim (§7).
- **Mechanics other than slots.** Slots only (umbrella §7/§17). We place seams so a
  second mechanic is _additive_, but build **no** machinery for it now.
- **Richer slot features** beyond core + free-spins (expanding/sticky wilds,
  hold-and-spin, ways-to-win, cascades). Append-only, added later (§7 of umbrella).

---

## 2. The two decisions that anchor everything

### 2.1 Approach A — the model defines the characteristics; the pool is a faithful sample

RTP, volatility, and hit-rates are properties of the **math model** (reel strips +
paytable + feature config). The simulator's job is to **measure** the model,
**verify** it against targets, and **freeze a faithful, bit-reproducible sample**
of it — correcting only finite-sample error, never reshaping outcome frequencies.

We explicitly rejected the alternative (let pool _selection_ define the
distribution by over/under-representing outcomes vs their strip odds) because it
detaches pool frequencies from the auditable strips, corrupts game feel
(jackpot cadence, near-misses), and is far harder to certify. The certification
story is the whole reason Bloom exists, and Approach A keeps one auditable artifact
— the model — fully explaining every outcome frequency. This is umbrella §6
("AI-designed, never AI-decided") in microcosm.

> **The predetermined seed pool is a delivery/compliance mechanism, not the tuning
> mechanism.** It is _how_ a tuned game is frozen and served deterministically; it
> is not _where_ RTP is decided. RTP is decided in the model.

**Honesty guardrail:** curation may only nudge _realized_ RTP within a small band
(default ±0.5%) of the model's _measured_ RTP — that is removing finite-sample
noise. A larger gap is a **model** problem (retune the strips), never a curation
problem. This keeps Approach A from quietly sliding into the rejected approach.

### 2.2 The math engine is the shared core; simulator and server are thin shells

Everything outcome-related lives in `trusted/math`: grid → paylines → payout
evaluation → feature resolution. The simulator and the future server call the
**identical compiled kernel** (umbrella §4). That bit-identical sharing is what
makes the curated RTP a _true promise_ about live play, and it maximizes shared
math/server logic by construction.

- **`trusted/math` (shared core):** seed → `RoundOutcome` _with payout_.
- **`studio/simulator` (thin shell):** loop seeds → aggregate → verify → freeze.
- **`runtime/server` (thin shell, later):** draw index → call kernel → audit.

Base-game payout lives in the kernel (it _defines_ RTP). Only **shared-state**
money layers — progressives, operator multipliers — bolt on later in the server
(umbrella §10). The kernel emits payouts in **integer bet-multiples**.

---

## 3. The math model (the structured input)

Authored as JSON for now (by a human; by the AI later), and serialized into the
package's `math_payload`. **The kernel owns the schema** so the simulator and the
server deserialize it identically.

| Field             | Meaning                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| **symbols**       | symbol ids + **role**: `normal` / `wild` / `scatter`. Art/name live in presentation, never here.       |
| **reel strips**   | per-reel `Vec<Symbol>`; multiplicity encodes base-game probability (today's convention).               |
| **grid**          | reels × rows (e.g. 5×3): the visible window. A spin picks a stop per reel and shows `rows` cells.       |
| **paylines**      | list of row-index-per-reel patterns. Left-aligned matching runs; wild substitutes.                     |
| **paytable**      | `(symbol, count) → payout` in bet-multiples. Scatters pay by count, anywhere on the grid.              |
| **free-spins**    | trigger (scatter count → spins awarded), retrigger rule, in-feature win multiplier, optional separate feature strips. |

Integer-only throughout the outcome path (no floats), per `trusted/AGENTS.md`.

**Mechanic versioning:** this is the `slots@1` mechanic. Any future behavior change
is a new mechanic _version_, never an edit (umbrella §7, `trusted/AGENTS.md`).

---

## 4. The enriched kernel: `evaluate(model, seed) → RoundOutcome`

1. Seed a deterministic PRNG (`SplitMix64`, already present) from `seed`.
2. **Base spin** — pick a stop per reel; build the grid window (`rows` consecutive
   strip cells per reel, wrapping).
3. Evaluate **line wins** (left-aligned runs, wild substitution) **+ scatter pays**
   → base payout (integer bet-multiples).
4. If the scatter trigger is met → **free-spins sub-loop**: each free spin draws
   from the _same_ PRNG stream, applies the in-feature multiplier, and handles
   retriggers → feature payout.
5. Return `RoundOutcome`:
   - the base grid and any feature spins (the **symbolic outcome** — "what happened"),
   - **total payout** in integer bet-multiples ("what it paid"),
   - feature flags: `triggered`, `free_spins_played`, base-vs-feature payout split.

**Determinism contract (sacred):** one seed drives the _entire_ round, including a
variable-length bonus — fine, because the PRNG stream is deterministic. The same
`(model, seed)` yields a bit-identical `RoundOutcome` forever, cross-platform. This
is precisely what the future server replays from the audit log. **Bit-reproducibility
is the headline test** (§6).

---

## 5. The simulator: measure → verify → freeze (Approach A)

A new Rust crate `studio/simulator`, added to the Cargo workspace, depending on
`trusted/math` and `trusted/package`. Nothing depends on it (umbrella dependency
rule).

**Input:** a math model + a **target spec** + a **master seed**.

```
TargetSpec {
  rtp_target, rtp_tolerance,
  volatility_band,            // e.g. an acceptable std-dev / volatility-index range
  bonus_hit_rate_band,
  pool_size P,                // a real design parameter (umbrella §4)
  candidate_count M,          // rounds simulated to measure + draw the pool from
  realized_correction_band,   // the ±0.5% honesty guardrail (§2.1)
}
```

The **master seed** makes a curation run itself 100% reproducible — same model +
targets + master seed → identical curated pool.

**Pipeline:**

1. **Generate** M candidate seeds deterministically from the master seed.
2. **Simulate** `evaluate(model, seedᵢ)` for `i in 0..M`, in parallel (rayon).
   Collect each round's payout + feature flags.
3. **Measure** the model's realized characteristics:
   - **RTP** = mean payout / bet
   - **Volatility** = std-dev of per-round payout (report as a volatility index)
   - **Hit frequency** = % of rounds paying > 0
   - **Bonus hit rate** = % of rounds triggering free spins
   - **Base-vs-feature RTP split**
4. **Verify vs targets.** If the model's measured characteristics fall outside the
   target bands, the run **FAILS with a report**. The simulator **never reshapes**
   to force targets. A failed run is the signal to retune the model (layer 3, §8).
5. **Freeze the pool** — select P seeds that are a **faithful sample** of the model:
   - **Default (A2):** minimal stratified selection / greedy swaps so _realized_
     RTP lands on target within `rtp_tolerance`, while outcome proportions stay
     essentially the model's true proportions (we remove finite-sample error only).
   - **Fallback (A1):** pool = first P seeds as-is; realized RTP is whatever
     faithful sampling gives and must already be within tolerance or the run fails.
   - **Guardrail:** correction may only move realized RTP within
     `realized_correction_band` of the _measured_ model RTP (§2.1).
6. **Build + sign** the package via `trusted/package`:
   - model → `math_payload`, curated seeds → the pool,
   - a **provenance report** (measured RTP/vol/hit-rates, P, M, master seed,
     tolerances, achieved realized RTP) — exactly the metadata the umbrella §9
     sign-off gate wants.

**Output:** a signed game package + a human-readable sim report.

Pool size, candidate count, and tolerances are **inputs in the target spec**, not
hardcoded (umbrella §4 calls pool size a real design parameter; §18 defers exact
values). First-cut defaults are proposed in §9.

---

## 6. Testing strategy (Rust / Cargo, TDD)

This is pure Rust; there is no Playwright surface here. TDD per repo policy
(`AGENTS.md`): a failing test first, then the minimal code.

- **Bit-reproducibility (headline)** — same `(model, seed)` → identical
  `RoundOutcome` across many repeats, plus a **stored golden vector** to catch
  cross-version drift.
- **Payout correctness** — tiny hand-built models with known line wins, scatter
  pays, and free-spins math → assert exact payouts.
- **RTP convergence** — a model with an analytically known RTP (e.g. the
  0.70 / 0.28 / 0.02 → 96% toy) → the simulator measures within tolerance of the
  closed-form value.
- **Curation faithfulness** — realized pool proportions stay within ε of the
  measured model proportions (A2 does not reshape); realized RTP within tolerance.
- **Reproducible curation** — same master seed + model + targets → identical
  curated pool.
- **Freeze-boundary determinism** — re-expanding pooled seeds (server-style)
  reproduces the simulated outcomes, proving the determinism contract survives the
  freeze (this is the contract the runtime later depends on).
- **Verify-fails-loudly** — a model whose measured characteristics miss the target
  bands produces a failing run with a report, and never a silently reshaped pool.

---

## 7. Mechanic-agnostic seams (labels, not machinery)

We build slots only, but place these so a second mechanic / the server are
additive (umbrella §7 — _labels and placement, not machinery_):

- **`RoundOutcome`** is the seam between "what happened" and "what it paid"
  (umbrella §10). Slot-specific fields are named and located so a future mechanic's
  outcome is a sibling, not a rewrite.
- **The kernel entry point** (`evaluate(model, seed)`) is the single call both the
  simulator and the future server make — the shared-core seam.
- **The model schema ↔ `math_payload`** boundary: the kernel owns
  serialize/deserialize; the package stays mechanic-agnostic (opaque bytes), as it
  already is.
- **`Tuner` seam (deferred, §8):** a labeled place where layer-3 model tuning will
  plug in — never built now.

---

## 8. Deferred: layer-3 tuning (incl. genetic algorithms)

Tuning a model's parameters to _hit_ targets is deferred. When built, it lives in
the **studio plane** behind a swappable **`Tuner`** seam (matches "proven libraries
behind thin seams" + "labels, not machinery"). Candidate implementations: a simple
hill-climb, a metaheuristic (**genetic algorithm**, simulated annealing, CMA-ES),
or the AI math-designer agent.

**Critical constraint — a tuner optimizes _model parameters_, never the seed
selection.** Using a GA (or any optimizer) to evolve "the ideal list of seeds" is
the rejected reshaping approach (§2.1) in disguise: it detaches pool frequencies
from the strips and produces an opaque, hard-to-certify pool. Faithful sampling
(§5) already lands the realized target deterministically and transparently.

A parameter-tuner is certification-safe because it runs in authoring, its **output
is an interpretable model** (the regulator audits the final strips, not the search),
and the pool stays a faithful frozen sample — determinism untouched. Each candidate
costs a full M-round simulation to score, so a tuner is evaluation-expensive; that
shapes (but does not belong to) this effort.

---

## 9. First-cut defaults & open parameters

Proposed starting values (all are target-spec inputs, tunable per game; umbrella
§18 defers final numbers to this and the package/server sub-specs):

- **Candidate count M:** ~1–10M rounds simulated per measurement.
- **Pool size P:** large enough that draw-with-replacement recurrence is rare and
  unpredictable (umbrella §4). Starting point ~100k–1M seeds; revisit against
  package size + recurrence analysis.
- **RTP tolerance:** realized within ±0.1% of target.
- **Realized-correction band (guardrail):** ±0.5% of measured model RTP.
- **PRNG:** `SplitMix64` for seed→outcome expansion (kernel). The server's
  index-draw CSPRNG and the simulator's seed-generation PRNG are distinct RNG roles;
  only the kernel's expansion PRNG is in scope here.

---

## 10. Build order within this effort

1. **Math engine enrichment** (`trusted/math`): model schema → grid → line/scatter
   payout → free-spins round → `RoundOutcome`; bit-reproducibility + payout tests.
2. **Simulator crate** (`studio/simulator`): generate → simulate (parallel) →
   measure → verify → freeze (A2) → build+sign; convergence, faithfulness,
   reproducibility, freeze-boundary tests.
3. **Wire the workspace**: add `studio/simulator` to the Cargo workspace; a
   `just`-level entry point to run a curation from a model + target spec.
