# GDD Structured Content & Design-Intent Routing

**Status:** Draft for review
**Date:** 2026-06-24
**Supersedes parts of:** `2026-06-23-gdd-generation-design.md` (the free-text body model)

## 1. Context & problem

The Game Design Document (GDD) feature (PR #54) generates 7 fixed aspects
(theme, math-model, symbols-reels, paytable, bonus-features, ui-ux, audio) by
running the `design-game` skill through the react-agent, which writes a free-text
markdown `body` per aspect via `write_gdd_doc`.

Two problems surfaced in real use:

- **Problem B — hollow content.** The generated subsections describe themselves
  instead of containing real design. Example, observed in `paytable`:

  > "The paytable will outline the payout values for each symbol and winning
  > combination. High-value symbols will have higher payouts... Specific values
  > will still need to be determined."

  The root cause is **a missing contract**, not weak prompting. `write_gdd_doc`
  accepts any markdown; nothing defines what a _good_ paytable section contains.
  With no target to fill, the agent retreats to safe meta-prose. No amount of
  "be more concrete" prompt-nagging reliably fixes a missing spec.

- **Problem A — no intent routing.** A freeform chat message such as
  _"I want the bonus hit rate to be 1:200"_ cannot reach the GDD. Plain chat runs
  the **no-tool path** (`turn_runner.py:55–65`): the model streams text with no
  tools bound. Updating a single parameter requires explicitly invoking
  `/design-game` and navigating the interview.

Both share one root: **the GDD must hold concrete, parameterized content, and
chat must be able to address that content precisely.** A per-aspect typed schema
solves B at the source and makes A tractable.

## 2. Goals & non-goals

**Goals**

- Every aspect is backed by a **typed schema** of named fields; structured data
  is the source of truth, rendered markdown is a projection.
- A `param` field cannot be satisfied by hollow prose — it is a typed value or a
  flagged gap. Hollow content becomes structurally impossible.
- The content is **machine read/write/understand-first**: agents read fields by
  name and edit them by name.
- Freeform chat in a game room can apply a concrete design decision to the right
  aspect/field without an explicit skill invocation.

**Non-goals (now)**

- **Mathematical reconciliation.** The schema forces _concreteness_ (a filled
  paytable, a stated rate), not _correctness_ (that the numbers reconcile to a
  96% RTP). A reconciliation/simulation layer is future work (§11) and the schema
  is designed to plug it in without restructuring.
- A user-editable schema. The 7 schemas are backend-defined constants this round.
- Migrating legacy free-text docs (see §10 — clean cutover).

## 3. Architecture overview

```
            chat message
                 │
     ┌───────────┴───────────┐
     │ /design-game (skill)  │  plain chat (game room)
     │ draft all 7 + interview│  design-router turn
     └───────────┬───────────┘   │
                 ▼                ▼
            set_gdd_fields(aspect, {field: value})   ← single write path
                 │
   normalize/validate (advisory) → patch data → recompute status
                 │                                → re-render body
                 ▼
            GddStore (data canonical, body cached)
                 │  emit gdd_doc_updated (body markdown)
                 ▼
            frontend viewer (unchanged)
```

Everything funnels through one structured write tool. The frontend viewer and the
`gdd_doc_updated` payload keep carrying `body` markdown, so **no frontend change
is required** — the flip is entirely backend.

## 4. The data model

### 4.1 Doc shape

```python
class GddDoc(_WireModel):
    id: str
    game_id: str
    aspect: str
    title: str
    order: int
    data: dict          # CANONICAL — typed fields keyed by schema field key
    body: str = ""       # DERIVED cache — render(schema, data); refreshed on write
    status: Status       # DERIVED — computed from required-field completeness
    created_at: datetime
    updated_at: datetime
```

`data` is canonical. `body` is a rendered cache. `status` is computed, no longer
set by hand.

### 4.2 Schema & fields

Each aspect schema (new module `gdd/schemas.py`) is an **ordered list of fields**:

```python
@dataclass(frozen=True)
class Field:
    key: str                 # e.g. "bonus_hit_rate"
    label: str               # e.g. "Bonus hit rate"
    type: FieldType          # number | percent | ratio | enum | text | table | list
    role: Literal["param", "narrative"]
    required: bool = False
    default: object | None = None
    enum: tuple[str, ...] | None = None      # for type=enum
    columns: tuple[Column, ...] | None = None  # for type=table
    help: str = ""           # guidance injected into agent context
```

- **`param`** fields are machine-critical typed values (a percent, a ratio, a
  table of numbers). They drive `status` and intent-routing.
- **`narrative`** fields are rich authored prose (design intent, art direction).
  Premium narrative still lives in the doc — it is just held in designated fields
  rather than being the entire body.
- A **`table`** field declares typed `columns`; its value is a list of row dicts.

### 4.3 The 7 aspect schemas (initial contract)

These field sets are the starting contract; they are extensible without
restructuring. Types in parentheses; **(req)** = required `param`.

- **theme** — `name` (req, text), `setting` (text), `tone` (enum:
  epic/playful/dark/luxe/mythic), `target_audience` (text), `narrative_hook`
  (narrative), `art_direction` (narrative).
- **math-model** — `rtp` (req, percent), `volatility` (req, enum:
  low/medium/medium-high/high), `reels` (number, default 5), `rows` (number,
  default 3), `paylines` (text, e.g. "20 lines" / "243 ways"), `max_win`
  (number ×, e.g. 5000), `hit_frequency` (percent), `bonus_hit_rate` (req,
  ratio, e.g. "1:200"), `bet_range` (text).
- **symbols-reels** — `symbols` (req, table: name,
  kind[high/low/wild/scatter/bonus], art_desc), `reel_strips` (table: reel,
  composition), `wild_behavior` (narrative), `scatter_behavior` (narrative).
- **paytable** — `payouts` (req, table: symbol, 3oak, 4oak, 5oak),
  `special_pays` (table: name, award), `notes` (narrative).
- **bonus-features** — `features` (req, table: name, trigger, description),
  `free_spins` (table: trigger, count, retrigger, multiplier), `bonus_buy`
  (text, e.g. "100× bet" or "disabled").
- **ui-ux** — `layout` (narrative), `key_screens` (list), `controls` (narrative),
  `quick_spin` (text), `autoplay` (text).
- **audio** — `music_style` (text), `sfx` (list), `dynamic_audio` (narrative).

### 4.4 Status derivation

`status` is computed, never set by the agent:

- any required `param` field missing/empty → `needs_input`
- all required present, doc touched → `drafted`
- explicitly finalized (all required present + author/agent marks done) →
  `complete`
- untouched seed → `empty`

The hollow-content failure mode is now impossible: a `needs_input` doc names
exactly which typed fields are unfilled.

## 5. Rendering

`render(schema, data) -> markdown` is a deterministic, pure function (new
`gdd/render.py`). It walks the schema in field order and emits the rich,
structured markdown the viewer shows:

- a **Parameters** block for scalar `param` fields,
- markdown **tables** for `table` fields (header from `columns`),
- **lists** for `list` fields,
- **prose sections** (heading + body) for `narrative` fields,
- missing required fields rendered as an explicit _"⚠ needs input"_ marker.

It runs on every write and refreshes `body`. Pure + deterministic → directly
unit-testable.

## 6. The tool surface

The free-text tools (`write_gdd_doc` full-body, `edit_gdd_doc` string-replace)
are removed — string-replacing into rendered markdown is exactly the fragility we
are eliminating. Replaced by:

- **`read_gdd_doc(aspect) -> view`** — returns the typed `data`, the `status`,
  and an explicit **list of missing required fields** (key, label, type, help).
  The agent sees _"`paytable.payouts` empty, `bonus_hit_rate` missing"_ rather
  than inferring gaps from prose. Drives the interview loop.

- **`set_gdd_fields(aspect, fields: {key: value, ...})`** — the single workhorse
  for drafting, refining, and intent-routing. It:
  1. **normalizes + validates advisorily** — coerces `"1:200"` → ratio,
     `"96%"` / `0.96` → percent, validates enums, parses table rows; an unknown
     key or bad value returns a helpful message but **never blocks the rest of
     the patch** (no mid-loop stalls);
  2. **patches `data`** — untouched fields are left alone (surgical by
     construction; no whole-doc rewrites);
  3. **recomputes `status`, re-renders `body`, emits `gdd_doc_updated`**.

  Because a `narrative` field is just a `text`-typed field, the same tool writes
  rich prose. `table` fields take a list-of-rows. The whole surface collapses to
  two tools plus the existing overview.

- **`list_gdd_docs()`** — unchanged; the status board the skill uses to rank gaps.

`set_doc_status` is retained only for the explicit `empty→complete` finalize
transition; routine status is derived.

## 7. Generation flow (Problem B) — `design-game` skill changes

The skill body stops saying "write a best-effort draft" (which invited prose) and
becomes a typed-form fill:

1. **For each aspect**: `read_gdd_doc` to see the field list → `set_gdd_fields`
   to fill **every `param` field** with a concrete value or sensible
   casino-genre default. A `paytable.payouts` table demands rows of numbers; it
   cannot be satisfied by "values to be determined".
2. **Rank gaps** by material impact using `list_gdd_docs` + the missing-field
   lists (RTP, volatility, bonus trigger rank high; flavor low).
3. **Interview** the high-impact gaps one at a time via `ask_user_question`
   (unchanged elicitation discipline) → apply answers with `set_gdd_fields`.
4. **Finalize**: derive/confirm `complete` and summarize decisions.

The discipline ("one question at a time", "surgical edits") is preserved; the
difference is that every step lands on a typed field instead of free text. The
skill's declared `tools:` list updates to
`[list_gdd_docs, read_gdd_doc, set_gdd_fields, set_doc_status, ask_user_question]`.

## 8. Intent routing (Problem A) — design-router on plain chat

In a room with a game/GDD context, the plain-chat turn no longer uses the no-tool
path. It runs the react-agent with the GDD toolset bound and a **design-router
system prompt** seeded with the **field catalog** (every aspect's fields + types,
derived from the schemas) so the router knows the addressable surface. Behavior:

- message expresses a concrete design decision/parameter → resolve aspect+field,
  call `set_gdd_fields`, and **confirm** ("Set Math Model → bonus hit rate =
  1:200");
- target ambiguous (e.g. "hit rate" — base or bonus?) → `ask_user_question` to
  disambiguate;
- not a design edit → respond as normal chat.

`/design-game` remains the heavyweight "draft all 7 + interview" flow; plain chat
now covers incremental single-parameter edits — both landing on `set_gdd_fields`.
The viewer updates live via the existing `gdd_doc_updated` path. Rooms without a
game context keep the no-tool path.

**Implementation note:** routing is decided in `room_hub` when building the turn —
if the room has a game/GDD context, construct a synthetic "design-router" skill
spec (system prompt + GDD tool allowlist) and run it through the existing
`TurnRunner` skill path, instead of the no-tool branch. No new executor; reuses
the react-agent machinery.

## 9. Backend module changes

- `gdd/schemas.py` (new) — `Field`, `Column`, `FieldType`, the 7 schemas,
  `field_catalog()` helper.
- `gdd/render.py` (new) — `render(schema, data) -> markdown`.
- `gdd/normalize.py` (new) — type coercion/validation (ratio, percent, enum,
  table rows) returning `(value, warning|None)`.
- `gdd/models.py` — `GddDoc` gains `data: dict`; `seed_taxonomy` seeds empty
  `data` per schema; `Status` derivation helper.
- `gdd/store.py` — `upsert_doc`/`edit_doc` replaced by `set_fields(game_id,
aspect, fields) -> GddDoc` that patches `data`, recomputes status, re-renders
  body. `set_status` retained for finalize.
- `gdd/hub.py` — emit path unchanged (still ships `body`).
- `agent_tools.py` — drop `write_gdd_doc`/`edit_gdd_doc` builders; add
  `read_gdd_doc` (structured) and `set_gdd_fields`; keep `list_gdd_docs`,
  `set_doc_status`, `ask_user_question`.
- `room_hub.py` — game-room plain-chat builds the design-router turn.
- `skills/design-game.md` — rewritten body + updated `tools:`.

## 10. Migration

The GDD feature is new and docs are regenerated per game, so a **clean schema
cutover**: drop existing `gdd_docs`; `seed_taxonomy` reseeds empty structured
docs from the schemas. No legacy free-text migration.

## 11. Future work (out of scope)

- **Math reconciliation engine** consuming `math-model` + `symbols-reels` +
  `paytable` structured data to simulate RTP/volatility and flag inconsistency —
  the schema is the substrate it plugs into.
- User-extensible / per-game schema overrides.
- Schema-aware diff/changelog of design decisions.

## 12. Testing strategy

Following repo TDD + e2e-as-source-of-truth policy.

**Unit (CI-affordable):**

- `normalize.py`: `"1:200"`→ratio, `"96%"`/`0.96`→percent, enum validation, bad
  value → warning not crash, table-row parsing.
- `render.py`: deterministic markdown for a fully-filled doc; `needs_input`
  markers for missing required fields; table formatting.
- `status` derivation across empty / partial / complete.
- `store.set_fields`: surgical patch leaves untouched fields; recomputes status;
  refreshes body.
- `field_catalog()` shape for the router prompt.

**E2e (Playwright, local — authoritative):**

- `design-game` on a seed description produces a `paytable` with **real numeric
  rows** and **no "to be determined" prose** (assert table cells, assert absence
  of placeholder phrases).
- Plain chat _"set the bonus hit rate to 1:200"_ in a game room updates
  `math-model.bonus_hit_rate` and the viewer reflects it live.
- Ambiguous _"set the hit rate to 1:200"_ triggers a disambiguation question.
- Replay cassettes re-recorded for the new tool-bearing plain-chat turn and the
  rewritten `design-game` flow.

## 13. Open questions

- Exact field list per aspect is a starting contract — expect refinement during
  implementation as real generations expose gaps.
- Whether `bonus-features.free_spins` is better modeled as one structured entry
  vs a table when multiple bonus modes exist (start: table).
