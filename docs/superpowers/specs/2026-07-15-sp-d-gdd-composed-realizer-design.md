# SP-D — GDD→Composed Realizer — Design

**Date:** 2026-07-15
**Status:** Approved design, pre-implementation
**Parent:** [Tooling convergence umbrella](2026-07-11-tooling-convergence-composed-design.md)
(§6 GDD→composed seam, §7 SP-D). SP-A (#197), SP-B (#203), and SP-C (#211) are
merged: the binaries, backend dispatch, and math pane are family-aware. SP-D
completes the intent-to-verified loop — the GDD declares a composed game and a
realizer seeds its `GameDefinition`, mirroring the slots@1
`realize_slot_model` / game-config split exactly.

## 1. Decisions locked during brainstorming

1. **Composed feature intent extends the existing `bonus-features` table** —
   no new GDD aspect. One features list serves both families; the slots
   realizer ignores the new columns.
2. **3-group merge parity.** The composed realize lifecycle matches slots
   (touched gate, consent interrupt, `shape_stale` escalation) but merge
   granularity is the tuner's three lock groups (reels / paytable / features),
   not slots' five sections.
3. **Family flip = shape change.** Setting `game_family` routes through the
   existing shape-change hook: a touched other-family artifact triggers the
   consent gate, then realize seeds the new family's artifact. The old
   artifact doc stays in its collection, inert — reversible by flipping back.
4. **The realizer reuses the slots helpers.** `realize.py`'s pure helpers
   build the `reels@1` config (shape-identical to a SlotModel's
   strips/symbols/paylines/paytable); a new assembly layer adds only what is
   actually composed-specific (states, transitions, mechanics).

## 2. GDD intent schema (`app/gdd/schemas.py`)

- **`math-model` gains `game_family`**: enum (`slots@1`, `composed@1`), role
  `param`, default `slots@1`. `MathStore.family()` already resolves from this
  exact key (SP-C forward-compat) — SP-D starts writing it.
- **`bonus-features` `features` table gains structured columns**:
  - `kind`: enum `free-spins` | `meter`; blank/absent means `free-spins`
    (legacy rows keep working).
  - `retrigger`: enum `yes` | `no` (free-spins only; ignored for meter).
  - `budget`: number, optional — spins awarded (free-spins) or fill target
    (meter). A seed only: the GA owns the number after realization.
  - Existing `name` / `trigger` / `description` columns unchanged.
- Slots-shaped `math-model` fields (`reels`, `rows`, `payline_mode`,
  `payline_count`, `strip_length`) apply to composed identically — they
  configure the `reels@1` instance.

## 3. Realizer (`app/math/realize_composed.py`)

Pure sibling of `realize.py`, same contract:

```python
realize_game_definition(math_model, symbols_reels, paytable, bonus_features,
                        existing_ids=None) -> RealizeResult
```

Same `RealizeResult` (model is the `GameDefinition` dict; `None` iff hard
structural contradiction), same warnings-not-errors bias, same `slot_ids`
join-key return for the `model_id` write-back.

- **reels@1 config** via the existing helpers: `_realize_symbols` (id
  stability through `existing_ids`), `_realize_reels` (sparse scatters),
  `_realize_paylines`, `_realize_paytable`. These become importable
  (underscore names re-exported or renamed) — no logic changes.
- **Assembly**:
  - one `main_reels` mechanic carrying the realized config;
  - when any feature row exists and a scatter symbol resolves, the config
    gains one emit event (`{symbol, min_count: 3, emit: "scatters:3"}`);
    features with no scatter symbol are skipped with a warning (slots-realizer
    parity);
  - `base` state: bindings for `main_reels` (+ each meter), `steps.budget: 1`,
    script `spin` (+ `accumulate` per meter);
  - per **free-spins** row: state `fs_<n>` with
    `steps: {budget: "awarded", initial: <budget or 8>}`, transition
    `base → fs_<n>` on the scatter event; `retrigger: yes` adds
    `{from: fs_<n>, on: <event>, effect: "steps:add:<initial>"}`;
  - per **meter** row: `meter@1` mechanic
    (`target: <budget or 6>`, `count_symbol: <scatter>`,
    `reset_on_full: true`), bonus state `meter_<n>` (fixed budget, seed 5),
    transition `base → meter_<n>` on `meter:full`;
  - `family: "composed@1"`, `start: "base"`, `caps.max_steps: 1000`.
- No feature rows → a valid single-state base game (composed games without
  bonuses are legal).

## 4. Flow / store / targets wiring

- **`realize_flow.realize_game` dispatches on `family()`.** The composed
  branch realizes via `realize_game_definition` and merges at 3-group
  granularity: the existing `SectionLocks` attrs map to definition parts —
  `reels` → reels-config strips/rows/symbols/paylines (+ per-state strip
  overrides), `paytable` → the reels instance paytable, `bonus` → meter
  targets, awarded budgets, and the states/transitions/mechanics skeleton.
  Touched gate, interrupt consent, and shape_stale escalation behave exactly
  as slots (`agent_tools.set_gdd_fields` and `apply_math_hooks` already route
  here — only the family guards come out).
- **`GameDefinitionDoc` gains `origin` (`template` | `realized`) and
  `shape_stale`.** `MathStore.save_realized` composed branch goes real:
  realized definitions write through **`ComposeStore.put(source="realize")`**
  so the `game_definition_changed` watermark, scene sync, and auto-build fire;
  `verdict_stale` set when results exist (slots parity). `set_stale_flags`
  stops dropping `shape_stale` for composed.
- **`shape.py`**: `SHAPE_FIELDS` gains `("math-model", "game_family")`; the
  new bonus-features columns ride the existing `features` shape key. A
  composed-groups mapping (aspect/field → reels/paytable/features) replaces
  the five-section map on the composed path.
- **`target_flow`**: the composed branch passes `paytable_data` and
  `symbols_data` into `derive_target`, so symbol pay constraints compile via
  the `model_id` join keys the realizer stamps (identical mechanism to slots).
  Bonus-rate bands stay excluded for composed (#160 owns feature bands).
  `_is_composed` becomes public `is_composed` (agent_tools already imports
  it).
- **Guards come out**: `rest.py` realize 409, `store.save_realized`
  RuntimeError, and the generate-pipeline realize gate — the generate flow
  works end-to-end for composed.

## 5. Studio surface

- GDD viewer renders `game_family` and the new feature columns schema-driven —
  no bespoke pane work.
- game-structure sees realized definitions via the existing watermark sync;
  its build action now operates on GDD-seeded definitions.
- SP-C's target chips render composed pay constraints and the max-win band
  with zero new code (they read the compiled target).

## 6. Testing

- TDD throughout (pytest): schema round-trip, realizer (symbols/join keys,
  free-spins + meter assembly, retrigger, no-scatter warning, no-features
  base game, determinism), flow dispatch + 3-group merge + locks, store
  (`origin`/`shape_stale`/write-back path), composed `derive_target` with
  pay constraints, family-flip consent path.
- One Playwright e2e (replay backend): set `game_family: composed@1` + a
  free-spins feature row in the GDD → realize → game-structure shows the
  seeded states → tuner target includes the pay constraint chips → build
  succeeds. Existing slots realize specs stay green.
- `just e2e` before PR.

## 7. Out of scope

- Feature-level tuner bands (#160) — SP-D seeds budgets/targets; bands over
  them stay follow-up.
- Structural GA mutation (states/transitions/thresholds).
- Visual reels/paylines/paytable editing in game-structure (#182).
- Line/shape constraints (#161); richer prose-constraint language (#163).
- Migrating or retiring anything slots@1 — both families stay first-class.
