# SP-C — Backend + Studio Family Dispatch — Design

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation
**Parent:** [Tooling convergence umbrella](2026-07-11-tooling-convergence-composed-design.md)
(§4 backend, §5 studio, §7 SP-C). SP-A (#197) and SP-B (#203) are merged: the
Rust binaries are already family-aware and emit `family` / `maxWin` /
`stateRtp` / `stateVisitFreq` / `verdict`. SP-C makes them reachable from the
studio. Ride-alongs: **#189**, **#190**, and surfacing the #160 evidence
(dead-feature visibility).

## 1. Math descriptor

One backend function answers "what family is this game":

```python
resolve_family(game_id) -> "slots@1" | "composed@1"
```

Resolution order: GDD structured content `game_family` if present
(forward-compatible — SP-D starts writing it) → `game_definitions` doc exists
→ `slot_models` doc exists → default `slots@1` (legacy). Exposed as
`GET /games/{id}/math/descriptor` → `{family}`; every `app/math` endpoint
dispatches off the same function internally.

## 2. Storage fold — no third collection

`GameDefinitionDoc` gains the folded math fields `SlotModelDoc` carries today:
`params`, `tuner_params`, `locks`, `result`, `tune_result`, staleness flags.
`MathStore` grows a family-dispatching load/save layer over the two
collections.

**Composed apply write-back goes through `ComposeStore.put(source="tuner")`**
so the existing `game_definition_changed` watermark, scene sync, and
auto-build all fire — applying a tuned definition correctly triggers a package
rebuild.

## 3. Endpoints + runners

- Routes keep their paths and stay `game_id`-keyed; each resolves the family
  and loads the right artifact.
- Runners need almost nothing: `family` rides **inside the artifact JSON**
  (the Rust `MathArtifact::from_json_value` sniffs the top-level key), so for
  composed games the runner writes the `GameDefinition` as the artifact file.
  No job-wrapper changes.
- The Python parsers catch up to the Rust wire: `parse_result_line` /
  `parse_tune_result_line` (and the progress parse) gain `family`, `maxWin`,
  `stateRtp`, `stateVisitFreq`. `math_runs` rows gain `family` (state fields
  ride the metrics they already store).
- **`derive_target` is wired for composed** (the SP-B handoff item):
  curate/tune and the `compose_json` build hook pass the GDD-derived
  family-agnostic bands (RTP / vol / hit-frequency / max-win) when a GDD
  exists, falling back to `compose::self_target` otherwise — the verdict
  already flags `selfDerived`. Symbol pay constraints for composed arrive with
  SP-D's realizer.
- The generate pipeline works for composed except the realize step, which
  stays slots-only until SP-D — gated by the descriptor with a clear error.

## 4. Math pane — family-aware

- The pane fetches the descriptor, then loads the artifact via the existing
  per-family GETs: `GET /games/{id}/slot-model` (slots) or
  `GET /games/{id}/game-definition` (composed). No new artifact routes.
- `TargetStrip` goes family-aware: the bonus-rate input is slots-only
  (composed targets reject `bonus_hit_rate_bands`).
- `ResultStrip` gains per-state RTP share and state-visit frequency rows.
  **A zero-visit state renders as an explicit dead-feature warning** — the
  #160 evidence (a tuned composed game passing RTP verify with both features
  dead) made visible at a glance. Feature-level _bands_ stay out of scope
  (#160 proper).
- Analytics charts gain state-visit frequency for composed runs.
- **#190:** the target-chips row renders the compiled pay constraints
  (`pay_floor`/`pay_ceiling`/`top_paying`) and the max-win band. Slots-only in
  practice today; composed constraints arrive with SP-D and render through the
  same chips.

## 5. game-structure verdict strip

The bare `gs-metrics` span (rtp / hit% / maxWinX / `stateVisits` counted over
the 2× candidate population — misleading) is **replaced by the real verify
verdict**. The backend build endpoint already returns `verdict`; it is
currently dropped on the frontend. Thread it through `IBuildResponse` → build
state → a verdict strip showing status, realized RTP, and failure reason.

## 6. Agent tools — #189 + full rename

- **Full family-neutral rename:** `tune_slot_model` → `tune_math`,
  `apply_tuned_model` → `apply_tuned_math`; `read_tuner_setup` /
  `set_tuner_params` keep their names but get neutral report/description text.
  `read_tuner_setup` reports the composed shape (bindings / paytable / meter
  targets / budgets) for composed games.
- **#189:** `set_tuner_params` gains `weight_hit_frequency` — the wire
  (`TuneWeights.hit_frequency`, `build_config`, Rust `WeightsJson`) already
  carries it end to end.
- Apply for composed routes through the ComposeStore write-back (§2), keeping
  the human-gated `interrupt`.
- The `tune-math` skill file and the hand-written tuner-chat e2e cassettes are
  updated for the new names in the same task.

## 7. Testing

- TDD throughout: pytest for descriptor / store fold / parsers / endpoints;
  vitest for pane components and game-structure strip.
- New Playwright e2e for the composed math-pane flow: descriptor → tune →
  dead-feature warning visible → apply → game-structure shows the verify
  verdict. Replay backend, existing tuner e2e patterns. Existing slots specs
  must stay green (legacy wire asserted unchanged in SP-A/SP-B carries over).
- `just e2e` green before PR.

## 8. Out of scope

- Feature-level tuner bands (#160 proper) — this slice only surfaces the
  measurements.
- GDD composed intent schema, `realize_game_definition`, composed pay
  constraints (SP-D).
- Visual reels/paylines/paytable editing in game-structure (#182).
- Line/shape constraints (#161); prose-constraint language (#163).
