# slots@1 → composed@1 Tooling Convergence — Design

**Date:** 2026-07-11
**Status:** Approved design, pre-implementation
**Scope:** Converge the math toolchain (simulator/curation, tuner, analytics,
targets/GDD seam, math pane) onto `composed@1` Game Definitions behind a family
seam — decomposed into four sub-projects (§7). Closes issue #164; folds in #172.

## 1. Problem

The math toolchain is `SlotModel`-typed end to end: `curate_json`/`tune_json`
deserialize a `SlotModel`, the GA genome encodes its reels/paytable/bonuses,
`derive_target` and the pay-constraint contract key on its symbols,
`app/math` stores and shells out around it, and the math pane fetches
`/games/{id}/slot-model`. `composed@1` games (PRs #170/#174/#175/#181/#185)
have authoring and runtime but no math tooling: `compose_json` builds a `.pkg`
from an **uncurated** seed pool with a bare `measure_pool` readout — no verify,
no curation gate, no tuner, no analytics (issue #172).

The runtime server already dispatches on the package family
(`state.rs::LoadedGame`). Everything upstream of it does not.

## 2. Decisions locked during brainstorming

1. **One toolchain, family seam.** Generalize the existing curate/tune/target/
   store/pane stack behind `slots@1 | composed@1` dispatch, the way the runtime
   server does. No parallel composed-native stack, no slots-bridge conversion.
2. **Enum dispatch, not a trait framework.** Two families, append-only per the
   composed doctrine — a `match` at each seam point beats a registry.
3. **Genome tunes numbers, not structure.** Per-binding reels strips, reels
   paytable, meter targets, awarded budgets. States, transitions, event
   thresholds, scripts, and paylines are never mutated.
4. **Full GDD→composed seam, at intent + skeleton-realizer depth.** GDD grows
   composed feature intent and a realizer seeds the initial `GameDefinition`;
   game-structure remains the realization editor. Mirrors the slots@1 split
   (`realize_slot_model` / game-config) exactly.
5. **The math pane goes family-aware.** One math surface for all games;
   game-structure keeps structural authoring and its build action.

## 3. Rust layer — simulator + tuner

### 3.1 Family seam

`MathArtifact { Slots(SlotModel), Composed(GameDefinition) }` in
`bloom-simulator`, mirroring the runtime server's `LoadedGame`. Dispatch points:
artifact load/parse, per-seed evaluation, and (in the tuner) genome
encode/decode. `curate_json` and `tune_json` job JSON gains an explicit
`family` field; the artifact payload is parsed per family. Composed evaluation
is `compile(&GameDefinition)` once, then `composed::evaluate(&CompiledGame,
seed)` per seed.

### 3.2 Shared metrics over `RoundSample`

Both families reduce a round to a common sample:

```rust
struct RoundSample {
    total_payout: u64,            // bet-multiples, as today
    state_payouts: Vec<(StateId, u64)>, // slots: base/feature; composed: per state
}
```

- slots maps `RoundOutcome`'s base/feature split onto two pseudo-states;
- composed derives it by walking the trace (`state_enter` / `trigger` entries
  carry per-step payouts).

All metrics — RTP, volatility, hit rate, max win, payout-distribution buckets —
compute from samples: one implementation, both families. Composed additionally
gets what the trace makes free: **per-state RTP share** and **state-visit
frequency** (feature trigger frequency). These are the groundwork for
feature-level tuner bands (issue #160), which stays a follow-up.

### 3.3 Curate / verify / freeze

- `verify` checks the same family-agnostic bands for both families: RTP,
  volatility, hit-frequency band, max-win band (2·SE noise-aware gates as
  today).
- Pay-constraint static checks (`static_violations`) apply to composed against
  the `reels@1` instance's paytable/strips — same math, different location in
  the artifact.
- `freeze_pool` needs only payout-per-seed, so it operates on samples
  unchanged.
- **The composed `.pkg` build switches from `measure_pool` to the full
  curate → verify → freeze pipeline** — a composed package ships a curated,
  signed seed pool exactly like a slots package. This closes **#172**.
  `measure_pool` is retired; the verify verdict replaces its readout.

### 3.4 Tuner genome

`Genome` becomes a two-variant enum. The composed variant's genes:

- **reels**: per-reels-binding strip counts — the instance base config plus
  each per-state override that defines strips (feature strips tune
  independently of base strips, which is how base-vs-feature RTP trade-off
  tuning works);
- **paytable**: the reels instance's paytable payouts (instance-level, shared
  across states);
- **features**: `meter@1` targets and `"awarded"` state initial budgets.

Everything else is copied verbatim from the template definition at decode.
Section locks keep the three-group shape (reels / paytable / features).
Mutation, crossover, `repair()`, and the pay-constraint clamps reuse today's
operators — strip and paytable math is identical on both sides. Bounds for
meter targets and budgets ride `GeneBounds` like today's bonus genes.

Tune telemetry (NDJSON) gains `family` and the per-state-share fields so
analytics comes along for free.

## 4. Backend — `app/math`

- **Family declaration.** The GDD carries `game_family: "slots@1" |
"composed@1"` (intent decides the shape). Games without a GDD infer family
  from which artifact doc exists (`slot_models` vs `game_definitions`),
  defaulting slots for legacy. One backend function answers "what family is
  this game" — the **math descriptor** — and everything dispatches off it.
- **Endpoints** stay `game_id`-keyed. curate/tune/target/params/apply resolve
  the family, load the right artifact, and pass `family` + artifact through
  the existing runner seam (`runners/curate.py`, `runners/tune.py`) to the
  family-aware binaries. Same watchdog, same NDJSON streaming.
- **Storage: no third collection.** Params, locks, curation results, and tune
  results ride the family's artifact doc — `game_definitions` gains the same
  folded fields `MathStore` keeps on `slot_models` today. `MathStore` grows a
  family-dispatching load/save layer over the two collections.
- **Apply write-back** for a composed tune writes the tuned `GameDefinition`
  through `ComposeStore`'s change path so game-structure's watermark sync
  picks it up (same pattern as `slot_model_changed`).
- `derive_target`'s family-agnostic bands (RTP/vol/hit-frequency/max-win) work
  for composed from day one; symbol pay constraints arrive with the realizer
  (§6). `math_runs` rows gain `family`.

## 5. Studio surface

- The **math pane** opens for any game: it fetches the math descriptor, then
  renders the same simulator / tuner / analytics tabs against either artifact.
  Composed extras are additive — per-state RTP share in results, state-visit
  frequencies in analytics charts.
- **game-structure** keeps structural authoring and its build action (now
  building from the curated pool); its bare metrics strip is replaced by the
  real verify verdict. Visual reels/paylines/paytable editing inside
  game-structure stays issue #182 — orthogonal.
- **Chat/agent tuner tools** (`read_tuner_setup`, `set_tuner_params`,
  `tune_slot_model`, `apply_tuned_model`, tune-math skill) converge for free by
  calling the family-dispatched endpoints; naming that says "slot model" gets a
  family-neutral pass while we're in there. #189 (hit-frequency weight missing
  from `set_tuner_params`) and #190 (target chips in the math pane) are natural
  ride-alongs for SP-C.

## 6. GDD → composed seam

- **Intent schema.** The GDD's structured content grows `game_family` and a
  composed **features list**: e.g. a free-spins state (trigger event,
  retrigger allowed, budget band) and a meter bonus (source event, fill-rate
  intent), alongside the existing bands and pay constraints.
- **Skeleton realizer.** `realize_game_definition` (sibling of
  `realize_slot_model`) generates the initial `GameDefinition`: states,
  transitions, bindings, mechanic instances — with symbol ids stamped with the
  `model_id` join key, which makes symbol-level pay constraints and
  `derive_target` work identically for composed.
- **SoT doctrine (per PR #171).** GDD owns intent: which features exist,
  trigger semantics, bands, constraints. The definition owns realization
  numbers: strips, paytable values, meter targets, budgets. game-structure is
  the realization editor; the realizer seeds, never clobbers (same
  watermark/ownership rules as the slots realizer).

## 7. Sub-project decomposition

Each is its own plan → build cycle; this document is the umbrella.

1. **SP-A — simulator convergence**: `MathArtifact` seam, `RoundSample`
   metrics with per-state attribution, family-aware `curate_json`,
   verify/curate/freeze for composed, curated composed `.pkg` builds.
   Closes **#172**. Pure Rust + the `app/compose` build hook.
2. **SP-B — tuner convergence**: composed genome variant, family-aware
   `tune_json`, GA operators + repair + constraint clamps over composed genes,
   telemetry with `family` + per-state shares.
3. **SP-C — backend + studio**: math descriptor + family dispatch in
   `app/math`, storage fold onto `game_definitions`, math pane family-aware,
   analytics wired, composed apply write-back, agent-tool pass (#189, #190).
4. **SP-D — GDD→composed**: intent schema, skeleton realizer, composed
   `derive_target` with pay constraints, SoT doctrine application.

Order: A → B → C → D. A and B are Rust-only and independently verifiable by
golden runs; C makes them reachable from the studio; D completes the
intent-to-verified loop.

## 8. Out of scope (explicit)

- Feature-level tuner bands — bonus RTP share / trigger-frequency **targets**
  (issue #160). This project only produces the per-state measurements they
  will consume.
- Line/shape constraints (issue #161) — unchanged by convergence.
- Visual reels/paylines/paytable editing in game-structure (issue #182).
- Mutating game structure (states, transitions, thresholds) in the GA.
- Migrating or retiring `slots@1` anything — both families stay first-class.
- Richer prose-constraint language (issue #163).
