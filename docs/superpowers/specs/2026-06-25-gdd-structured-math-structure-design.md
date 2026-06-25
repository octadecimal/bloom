# Structured math-structure schema in the GDD (SP1)

**Status:** Design — approved, pending implementation plan
**Date:** 2026-06-25
**Branch:** `feat/gdd-math-structure`

## 1. Context — why this exists

Bloom's intended pipeline is **design intent (the GDD "spec") → executable slot math
(the realization) → reconciliation (simulate/tune/verify)**. An investigation of the
current code (authoritative over the prose specs) found that **structural design intent
never reaches the tunable math**. The concrete trigger: in game-room chat, asking for
"longer reel strips" has no effect — it silently no-ops.

### The intent → math propagation map (the dead-ends)

The pipeline has two arrows out of the GDD, and the structural gap lives in the missing one:

```
                 ┌─────────────────────────────────────────────┐
   GDD intent ───┤ derive_target() ─► TargetSpec (verify side)  │  ✅ exists
   (the "spec")  │ GDD→SlotModel realizer ─► SlotModel (realize)│  ❌ DOES NOT EXIST
                 └─────────────────────────────────────────────┘
   SlotModel is hand-authored JSON (textarea) ─► tuner mutates a SUBSET ─► reconcile vs TargetSpec
```

| GDD math-relevant field   | Structured?   | → TargetSpec?            | → executable SlotModel? | Tunable?                  | Verdict |
| ------------------------- | ------------- | ------------------------ | ----------------------- | ------------------------- | ------- |
| `rtp`                     | yes (percent) | yes (`targets.py:64`)    | no realizer             | indirect                  | partial |
| `volatility`              | yes (enum)    | yes (`targets.py:66-69`) | no                      | indirect                  | partial |
| `bonus_hit_rate`          | yes (ratio)   | yes (`targets.py:72-76`) | no                      | indirect                  | partial |
| `reels` (count)           | yes (number)  | no                       | no realizer             | fixed (`genome.rs:89-94`) | **no**  |
| `rows`                    | yes (number)  | no                       | no                      | fixed (`genome.rs:131`)   | **no**  |
| `paylines`                | free text     | no                       | no                      | fixed (`genome.rs:132`)   | **no**  |
| reel strip **length**     | not a field   | no                       | no                      | fixed (`genome.rs:157`)   | **no**  |
| `reel_strips.composition` | free text     | no                       | no                      | n/a                       | **no**  |
| `symbols` (set/roles)     | table (loose) | no                       | no                      | fixed identity            | **no**  |

**Root cause of "longer reel strips" doing nothing — it fails three times over:**

1. Reel strip **length** is not a structured GDD field at all (only `reels`/`rows`
   counts plus free-text `paylines` and `reel_strips.composition`).
2. There is **no GDD→SlotModel realizer** — the executable model is hand-pasted JSON
   (`SimulatorPane.tsx:25-26`); the GDD only feeds the _verify_ side (`derive_target`),
   never the _build_ side.
3. The tuner **deliberately fixes game identity** — reel count, strip length, rows,
   paylines, and symbol set are never mutated (`studio/tuner/src/genome.rs`); it only
   redistributes symbol counts within existing strips and tunes payouts/bonus.

### The chosen end-state and decomposition

The product decision is **full auto-realize**: the GDD becomes the single source of
truth and a realizer compiles it into executable math. That is too large for one spec,
so it is decomposed into three sub-projects in dependency order:

- **SP1 (this spec):** make the structural identity of the math addressable as **typed
  GDD fields**. Nothing can be realized that cannot first be expressed.
- **SP2:** the **GDD→SlotModel realizer** — a pure, deterministic compiler from the
  structured GDD to a valid `SlotModel`, with golden-vector tests.
- **SP3:** **realize→tune reconciliation + studio/chat integration** — wire realize into
  the studio and hand off to the existing tuner; human-gated apply.

**Key architectural insight that shapes all three:** the tuner already _fixes game
identity and optimizes the numbers within it_. That is the perfect second half of a
realize→tune pipeline — the realizer **defines** the identity the tuner holds fixed,
and the tuner does what it already does (optimize distribution + payouts to hit the
RTP/volatility/bonus targets).

## 2. SP1 scope and boundary

SP1 makes the **structural identity of the slot math addressable as typed GDD fields**
so that (a) chat requests like "longer reel strips" have a real field to land in, and
(b) SP2's realizer has a deterministic, machine-readable input.

**In scope:** schema fields, normalization, render, the design-router/chat surface, and
unit/e2e tests.

**Out of scope (explicit handoff):** the realizer (SP2) and any tuner/genome change
(SP3). SP1 ships no realizer and changes no Rust.

**Division of labor (locked during brainstorming):**

- **The GDD owns _identity_** (reel count, rows, strip-length guardrail, payline
  topology, symbol set + roles).
- **The tuner owns the _counts_** (per-reel symbol distribution, payouts). The GDD does
  **not** hand-specify the distribution; it gives RTP/volatility intent and the tuner
  derives the counts.
- **Strip length is the one identity field that becomes a _tunable range_:** the GDD
  expresses a single global `min/max` guardrail, and the tuner (in SP3) searches for the
  ideal length — potentially per reel — within that shared range.

**Approach:** extend the **existing** aspects (`math-model`, `symbols-reels`) rather than
add a new aspect. The 7-aspect taxonomy is fixed; the fields have natural homes already;
adding an aspect would ripple into seeding, the viewer, status derivation, and every
skill/test that loads the skills/GDD dir. This is the lowest-blast-radius path.

## 3. Schema changes (`studio/backend/app/gdd/schemas.py`)

### 3.1 `math-model` — structured payline topology

Replace the single free-text `paylines` field with structured topology, placed next to
the existing `reels`/`rows` (which are unchanged):

| field                 | type                       | role  | notes                                                                                                                                                |
| --------------------- | -------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`paylines` (text)~~ | **removed**                |       | superseded by the three below                                                                                                                        |
| `payline_mode`        | **enum** {`lines`, `ways`} | param | `ways` → realizer enumerates all-adjacent paylines; `lines` → N standard patterns                                                                    |
| `payline_count`       | number                     | param | the N for `lines`; informational for `ways` (e.g. 243)                                                                                               |
| `payline_overrides`   | list                       | param | optional power-user path: each item is a row-per-reel pattern string, e.g. `"0,1,2,1,0"`. If present, the realizer uses these instead of generating. |

### 3.2 `symbols-reels` — tightened symbols, dropped composition, strip-length range

| field                           | change                                                                      | notes                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `symbols` table                 | the `kind` column gains an **enum** {`high`,`low`,`wild`,`scatter`,`bonus`} | makes role machine-readable; SP2 maps `kind` → kernel `SymbolRole` (wild→Wild, scatter/bonus→Scatter, high/low→Normal) |
| ~~`reel_strips` (composition)~~ | **removed**                                                                 | distribution is tuner-owned now; the free text was never consumed                                                      |
| `strip_length`                  | **new `range`** field                                                       | global `min/max` guardrail; the "longer reel strips" lever; the tuner optimizes within it (SP3)                        |

`wild_behavior` and `scatter_behavior` (narrative) are unchanged.

### 3.3 Required vs optional

**All new fields are optional** (no `required=True`). This keeps existing GDD docs from
flipping to `needs_input` and leaves `derive_status` (`models.py:49-57`) unaffected — it
only inspects `required` params. SP2 defines fallbacks when a field is absent.

## 4. Two schema-system primitives

These are the only additions to the schema machinery; both are small and reusable.

### 4.1 The `range` field type

- Add `"range"` to `FieldType` (`schemas.py:4`).
- Canonical value shape: `{"min": <number>, "max": <number>}`.
- This is the one genuinely new type. Future structural ranges (if reel count ever
  becomes tunable) reuse it.

### 4.2 `Column.enum`

- `Column` (`schemas.py:8-12`) gains an optional `enum: tuple[str, ...] | None = None`.
- Lets a **table column** (the `kind` column) validate against an enum — today columns
  carry only `key`/`label` and `_table` coerces every cell to a string.

## 5. Normalization (`studio/backend/app/gdd/normalize.py`)

Consistent with the existing philosophy: **coerce and warn, never raise.**

- **`_range(raw)`** — accepts a `{"min", "max"}` dict, or a string `"8-20"` / `"8–20"`
  / `"8 to 20"`, and returns `{"min": 8, "max": 20}`. Enforces `min ≤ max` (swap and warn
  if reversed). Unparseable input returns `raw` plus an advisory warning. Wired into
  `normalize_value` for `field.type == "range"`.
- **`_table` extended** — for columns carrying `.enum`, validate each cell against the
  enum and emit an advisory warning on mismatch (mirrors `_enum`). Still coerces to a
  string and never raises.

## 6. Render (`studio/backend/app/gdd/render.py`)

- `_fmt` (`render.py:51-62`) handles `range` → `"8–20"`. A `range` is a scalar param, so
  it renders inside the existing **Parameters** block.
- **No frontend change.** The viewer consumes the `body` markdown that `render()`
  produces; this is the only render edit. `payline_overrides` renders as the existing
  list block; the enum-constrained `kind` column renders as today's table.

## 7. Chat / router wiring

- **`field_catalog()`** (`schemas.py:102-121`) already seeds the design-router prompt, so
  the new fields appear automatically. Extend the catalog to also emit **column enums**
  (so the router knows the valid `kind` values) and the new `range` type.
- **`set_gdd_fields`** (the tool in `app/agent_tools.py`) is **unchanged** — values flow
  through the extended `normalize_value`. No tool code changes beyond `normalize`
  supporting `range`.
- **`skills/design-game.md`** updated to fill the new structural fields.
- **"make the reel strips longer"** now routes to `symbols-reels.strip_length` (e.g.
  raise `max`) instead of dead-ending. SP1's win is that the intent **lands** in a typed
  field; the actual re-realize + re-tune is SP2/SP3.

## 8. Validation boundary

- **SP1 (here):** field-level advisory normalization only — `min ≤ max`,
  `payline_count > 0`, `kind ∈ enum`, override-pattern parse warnings.
- **SP2 (realizer):** deep cross-consistency — payline pattern length `== reel count`,
  override rows `< rows`, `strip_length.min ≥ distinct symbol count`, etc. The realizer
  is where structural coherence is enforced, because that is where the `SlotModel` is
  built.

## 9. Migration / back-compat

The app is dev-stage. This is a **schema-only change**: the removed fields (`paylines`
text, `reel_strips`) simply leave the schema, so `render()` ignores any orphaned stored
values and they disappear from the rendered `body` on the next `set_fields`. **No
data-migration script** — orphaned keys linger harmlessly in the Mongo `data` dict and
are never read again. (Deliberate call; a best-effort migrator that parses old
`"243 ways"` → `{mode: ways}` was considered and rejected as unnecessary at this stage.)

## 10. Testing (TDD)

Unit tests (the authoritative pure-logic layer):

- `_range` parsing: dict input, string forms (`"8-20"`, `"8–20"`, `"8 to 20"`), reversed
  (`min > max` swaps + warns), and garbage (returns raw + warning).
- `_table` enum-column validation: a valid `kind` passes; an out-of-enum `kind` coerces
  and warns.
- `render`: a `range` renders as `"8–20"` in the Parameters block; an enum-`kind` symbols
  table renders unchanged.
- `field_catalog` emits the `range` type and the column enums.
- `derive_status` is unaffected by the new optional fields (a doc with only the legacy
  required fields filled stays `drafted`).

e2e (replay, the behavioral source of truth):

- A keyed run cassette where game-room chat sets `strip_length` and `payline_mode`,
  asserting the typed values land in `data` and render in `body`. (New game-room e2e
  prompts must add their own keyed `tests/fixtures/replay/run/*.json` per the router's
  prompt-keyed cassette contract.)

## 11. Explicit handoff to SP2 / SP3 (out of scope here)

- **SP2 — the GDD→SlotModel realizer:** a pure compiler consuming these fields — maps
  `kind` → `SymbolRole`, expands `payline_mode`/`payline_count`/`payline_overrides` into
  `paylines: Vec<Vec<usize>>`, seeds a concrete strip length within `strip_length`,
  enforces the deep cross-consistency from §8, and emits a structurally-valid (if
  numerically rough) `SlotModel`. Golden-vector pinned.
- **SP3 — realize→tune + studio/chat integration:** wire realize into the studio (a
  "Realize" action + chat tool), then hand off to the existing tuner; human-gated apply
  ("AI-designed, never AI-decided"). **Requires expanding the tuner genome**
  (`studio/tuner/src/genome.rs`) to encode per-reel strip length as a gene bounded by the
  `strip_length` range, and reworking `repair` (today per-symbol counts sum to a fixed
  length; with variable length that coupling changes). This relaxes the "fixed game
  identity" invariant **for strip length only**.

## 12. Files touched (SP1)

- `studio/backend/app/gdd/schemas.py` — `range` type, `Column.enum`, the field changes
  in `math-model` and `symbols-reels`, `field_catalog` emitting range + column enums.
- `studio/backend/app/gdd/normalize.py` — `_range`, enum-column validation in `_table`.
- `studio/backend/app/gdd/render.py` — `range` formatting in `_fmt`.
- `studio/backend/skills/design-game.md` — fill the new structural fields.
- `studio/backend/tests/...` — unit tests for the above.
- `studio/frontend/e2e/...` + `studio/backend/tests/fixtures/replay/run/*.json` — the
  keyed structural-edit e2e.
