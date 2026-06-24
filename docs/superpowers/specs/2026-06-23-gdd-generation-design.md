# GDD Generation & Gap-Driven Elicitation — Design

**Date:** 2026-06-23
**Status:** Approved design, pre-implementation
**Scope:** v1 of the Game Design Document (GDD) feature for Bloom Studio

---

## 1. Purpose

Bloom is a Unity-like application for AI-driven casino game development. A core
part of that work is _designing_ the game — its requirements, mechanics, and
math — before anything is built. This feature lets a user describe a game in
natural language and have the AI collaboratively produce a **Game Design
Document**: a collection of markdown specifications, one per aspect of the game.

The AI does not passively transcribe. It drafts a best-effort GDD from the
user's description, then **grills the user** on the most material ambiguities and
gaps — one question at a time, with concrete suggested options — refining the
docs as answers come in. The user may pick a suggestion, supply their own
answer, or delegate the decision back to the AI ("you decide").

This is the product-embedded analogue of a design interview: human-in-the-loop,
chat-driven, with the AI as a collaborative agent rather than the sole author of
decisions.

## 2. Scope

### In scope (v1)

- A per-game **GDD document model and store** (markdown specs, one per aspect).
- **Draft-all-from-seed**: the AI drafts every taxonomy section from the user's
  initial description.
- **Gap-driven, non-linear interview**: the AI ranks the drafts' ambiguities by
  impact and interviews the user on the biggest gaps until the design is solid.
- **Inline, one-at-a-time, blocking question interrupt** (the new HITL
  primitive): a question + AI-suggested options + free-text answer + "you decide."
- **"You decide" = the AI's own judgment** (it picks the best option and records
  that it was an AI decision).
- **Surgical block editing** of docs (Claude-Code-style `edit`), not whole-doc
  regeneration, as the default refinement path.
- A **read-only GDD viewer pane** that shows the docs and their status, updating
  live as the interview proceeds.

### Deferred (explicitly out of v1)

- External data sources informing "you decide" (the future hook is designed in,
  not built).
- Specialized authoring/workspace panes beyond the read-only viewer.
- Direct human hand-editing of the markdown (v1 is "AI writes, human steers via
  chat"). The editor affordance is left as a clean extension.
- A persisted, first-class **gap board** (see Approach C in §3) — v1 keeps gaps
  implicit in the agent's run context.

## 3. Approach

**Chosen: Approach A — the GDD interview as a built-in _skill_, maximizing reuse
of the existing skill / run / interrupt machinery.**

The feature maps almost entirely onto primitives that already exist:

- An agentic run that drafts artifacts, calls tools, and pauses at an
  `interrupt()` for human input is _exactly_ today's skill/run/approval loop
  (`TurnRunner` → react-agent → `interrupt()` → `ApprovalCard`).
- Generated, per-game content with a live-updating viewer is _exactly_ the
  Asset Board pattern (`AssetStore` + Socket.IO + `plugins/assets`).

So the genuinely new work is small and orthogonal:

1. A new artifact + store (`GddDoc` / `GddStore`).
2. A small family of doc tools, including a **surgical block-edit** tool.
3. **Generalizing the approval interrupt into a question interrupt** — the one
   real new primitive, reusable well beyond GDDs.
4. A built-in `design-game` skill that encodes the gap-driven loop in editable
   markdown.
5. A read-only GDD viewer pane.

**Alternatives considered:**

- **Approach B — dedicated GDD orchestrator (new LangGraph subsystem)** with
  explicit `draft → rank-gaps → interview → finalize` nodes and a structured,
  code-driven gap list. Deterministic and very testable, but it partially
  re-implements `TurnRunner`, puts the interview logic in Python rather than
  editable markdown, and is a heavier first slice. Rejected for v1; its key
  benefit (a structured gap list) is captured as a future upgrade.
- **Approach C — hybrid**: Approach A plus one structured `rank_gaps` tool that
  makes the gap list first-class and _visible_ (an "open gaps" tracker in the
  viewer). A natural **A-now, C-later** progression; the data model is designed
  so promoting to C is additive.

The design deliberately keeps the gap list easy to promote to C later: gaps are
currently implicit in the agent's context, and each doc's `status` is the
durable signal, so adding a persisted `Gap` entity later is additive rather than
a rewrite.

## 4. Architecture & data flow

```
User describes game (chat, room linked to a game)
        │  invokes built-in "design-game" skill (natural prose or /design-game)
        ▼
TurnRunner (existing react-agent)  ──reads skill body──▶ gap-driven orchestration
        │
        ├─ write_gdd_doc ×N ........ best-effort draft every taxonomy doc from the seed
        ├─ edit_gdd_doc ............ surgical block edit; refine a section
        ├─ set_doc_status .......... drafted / needs_input / complete
        ├─ list/read_gdd_doc ....... read current state back (read-before-edit)
        └─ ask_user_question ....... fires generalized interrupt() → run PAUSES
        │                              resumes with {answer | delegated}
        ▼
GddStore (Mongo, per-game)  ──Socket.IO push──▶  GDD viewer pane (read-only, live)
```

### New vs. reused

| Concern       | New                                                                   | Reused                                                           |
| ------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Storage       | `GddStore` (Mongo)                                                    | Mongo client, `_WireModel` camelCase-alias pattern               |
| Agent tools   | `write/edit/list/read_gdd_doc`, `set_doc_status`, `ask_user_question` | `ToolFactory`, `ToolContext`                                     |
| HITL          | Generalized **question interrupt** + `QuestionCard`                   | `interrupt()`, RoomHub pending-approval plumbing, `ApprovalCard` |
| Orchestration | `skills/design-game.md` (built-in)                                    | `TurnRunner`, `SkillRegistry`, runs, sockets                     |
| UI            | `plugins/gdd` viewer pane                                             | plugin host, Dockview, Hookstate, `SocketClient`                 |

**Key reuse insight:** the interview run _is_ a normal run. It appears in the
unified chat feed, emits the same step events, and is gated by the same
interrupt/RoomHub machinery. We are not inventing a parallel execution path; we
are adding a richer _kind_ of interrupt and a new artifact type for tools to
write.

**"Until confident":** gap state lives in the agent's working context (the
LangGraph checkpointer thread) during the run; the drafted docs are the only
persisted artifacts. Each doc carries a `status` so the viewer can show
"needs input" vs. "complete."

## 5. Data model

### `GddDoc`

One Mongo document per `(game, aspect)`, following the existing `_WireModel`
camelCase-alias convention (like `Asset`):

```python
class GddDoc(_WireModel):
    id: str
    game_id: str
    aspect: str                 # taxonomy key, stable — e.g. "math-model"
    title: str                  # human title — e.g. "Math Model"
    order: int                  # display order in the viewer
    body: str                   # the markdown specification (the actual content)
    status: Status
    updated_at: datetime
    created_at: datetime

Status = Literal[
    "empty",        # exists in taxonomy, not yet drafted
    "drafted",      # AI wrote a best-effort draft from the seed
    "needs_input",  # AI flagged a material gap here; awaiting / mid-interview
    "complete",     # AI is confident; gaps resolved
]
```

This is the **only** new persisted entity in v1. There is no separate `Gap`
table — gaps live in the agent's run context and surface as chat questions; a
doc's `status` is the durable signal the viewer reads. (Promoting `Gap` to a
first-class record is the Approach-C upgrade.)

`body` is stored inline in Mongo (these are short text specs, not large
binaries — unlike assets, which need a filesystem `MediaStore`). This keeps the
viewer's live updates trivial.

### `GddStore`

Mirrors `AssetStore`:

- `list_docs(game_id) -> [GddDoc]`
- `get_doc(game_id, aspect) -> GddDoc | None`
- `upsert_doc(...)` — keyed on `(game_id, aspect)` so re-drafting an aspect
  updates in place rather than duplicating.

Each write emits a Socket.IO event the viewer subscribes to (same pattern as
asset generation updates).

### Taxonomy

A fixed, ordered list seeded as a backend config constant (`GDD_TAXONOMY`).
Editing the taxonomy is a code change for v1 — acceptable, given the "fixed
taxonomy" decision. Proposed default for a slot-style casino game:

| order | aspect (key)     | title             | covers                                             |
| ----- | ---------------- | ----------------- | -------------------------------------------------- |
| 1     | `theme`          | Theme & Narrative | setting, tone, story hook, target audience         |
| 2     | `math-model`     | Math Model        | RTP target, volatility, hit frequency, max win cap |
| 3     | `symbols-reels`  | Symbols & Reels   | grid size, ways/paylines, symbol set, wild/scatter |
| 4     | `paytable`       | Paytable          | per-symbol payouts, win evaluation rules           |
| 5     | `bonus-features` | Bonus Features    | free spins, bonus rounds, triggers, multipliers    |
| 6     | `ui-ux`          | UI / UX & Layout  | screen layout, controls, key visual moments        |
| 7     | `audio`          | Audio             | music direction, SFX cues, win celebrations        |

The taxonomy seeds the draft-all pass: on kickoff the backend idempotently
ensures one `GddDoc` per aspect exists (`status: empty`), so the viewer
immediately shows the 7-section skeleton and then watches it fill in live.

## 6. Doc-mutation tools

The agent refines docs surgically, the same way Claude Code edits files —
targeted block replacement, not whole-body regeneration (which is wasteful and
causes the model to silently reword untouched sections).

| tool             | purpose                                                    | shape                                            |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `list_gdd_docs`  | read all docs + status into context                        | `(game_id) -> [{aspect, title, body, status}]`   |
| `read_gdd_doc`   | read one doc's exact current text (for precise matching)   | `(aspect) -> {body, status}`                     |
| `write_gdd_doc`  | create / full-write a doc — the **initial draft-all** pass | `(aspect, title, body, status)`                  |
| `edit_gdd_doc`   | **targeted block replacement** — the surgical edit         | `(aspect, old_string, new_string, replace_all?)` |
| `set_doc_status` | flip status without touching body                          | `(aspect, status)`                               |

**`edit_gdd_doc` semantics mirror Claude Code's Edit tool exactly:**

- `old_string` must match the current `body` **exactly and uniquely**. If it is
  missing or appears more than once, the tool returns an error and the agent must
  read and retry. `replace_all` handles intentional multi-occurrence edits.
- **Read-before-edit discipline**: the skill prompt requires the agent to
  `read_gdd_doc` (or rely on a fresh `list_gdd_docs`) before editing, so it
  matches against real current text rather than a stale memory of what it wrote.
- Because `body` is a string in Mongo, replacement is a trivial server-side
  operation; the resulting doc emits the same Socket.IO update and the viewer
  re-renders.

**Lifecycle:** `write` once (draft from seed) → `edit` repeatedly (surgical
refinements as answers arrive) → `set_doc_status` → `complete`. The whole-doc
rewrite path remains available (`write`) for sections that genuinely need
wholesale replacement, but block-edit is the default.

**On grep/search:** at v1 scale (7 short docs per game) `list_gdd_docs` returns
the entire corpus in one call, so the agent already has everything in context to
locate a block; a separate grep tool would be redundant. If GDDs later grow
large or multi-file per aspect, a `search_gdd` tool is the natural addition — a
noted future seam, not v1.

## 7. The question interrupt primitive

The one genuinely new primitive, and it _generalizes_ what already exists. Today
`interrupt()` powers a binary approve/reject gate (`delete_asset` →
`ApprovalRequired` → `ApprovalCard`). We widen the payload so that **approval
becomes a special case of a question.**

**Interrupt payload** (raised by `ask_user_question`):

```
{
  kind:          "question",
  question:      str,
  suggestions:   [{ id, label, detail? }],   # 2–4 concrete, AI-proposed options
  allowFreeText: bool,    # default true — type your own
  allowDelegate: bool,    # default true — "you decide"
  aspect:        str?,    # which GDD doc this relates to (viewer context)
}
```

**Resume payload** (un-pauses the run):

```
{ type: "suggestion" | "freetext" | "delegate", value: str | null }
```

- `type: "delegate"` ("you decide") returns a sentinel to the agent meaning _use
  your best judgment_. The agent then picks an option, applies it, and notes in
  the doc that it was an AI-made decision. (External data sources to inform that
  choice are the explicitly-deferred future hook; v1 is the model's own
  judgment.)
- **Existing approval = degenerate question**:
  `{ suggestions: [Approve, Reject], allowFreeText: false, allowDelegate: false }`.
  So `delete_asset` keeps working through the same path — valuable for parity
  tests — and `ApprovalCard` is refactored into a `QuestionCard` whose
  approve/reject is just one configuration.

**Plumbing reuse:** RoomHub's pending-approval future/registry generalizes to a
pending-question registry — same attach/resume/snapshot mechanics, so a
reconnecting client still sees the open question. Difference: a destructive-action
approval can sensibly time out, but a design question should not auto-fail at
300s — the run **parks** until answered (timeout configurable, default
generous).

**Run trace:** add a `question` step type (alongside
`thinking / tool_call / tool_result / final / approval`) recording the question,
the options, and the resolved answer, so the unified feed shows the question
_and_ the chosen answer inline, and it persists in run history.

**`QuestionCard` (frontend):** question text → suggestion chips (label + optional
detail) → free-text field (if allowed) → "You decide" button (if allowed). On
submit it sends the resume payload over the existing socket channel, then
collapses to a read-only "asked → answered" record. Supports arrow/Enter/number-
key selection, consistent with the existing autocomplete keyboard affordances.

## 8. The interview skill (`skills/design-game.md`)

A **built-in, shipped** skill. The orchestration lives in editable markdown
(on-brand: visible and tunable in the Skill Editor) and drives the existing
react-agent.

```
name: design-game
description: Draft the game's GDD from your description, then interview you to
             resolve the highest-impact gaps until the design is solid.
args:  [ { name: focus, type: string, required: false } ]   # optionally target one aspect
tools: [ list_gdd_docs, read_gdd_doc, write_gdd_doc, edit_gdd_doc,
         set_doc_status, ask_user_question ]
```

**Kickoff seeding:** when a `design-game` run starts, the backend idempotently
ensures one `empty` `GddDoc` exists per taxonomy aspect. The viewer instantly
shows the 7-section skeleton, then watches it fill in live.

**Body — the gap-driven loop the prompt encodes:**

1. **Draft-all** — for each aspect, `write_gdd_doc` a best-effort draft from the
   user's description. Where information is missing, apply a sensible casino-genre
   default _but_ mark the doc `needs_input` and remember the gap.
2. **Rank gaps** — review the drafts; order the unresolved ambiguities by how
   much they materially shape the game (bonus trigger, RTP target, volatility
   rank high; flavor text low).
3. **Interview (one at a time, blocking)** — for the top gap, `ask_user_question`
   with a crisp question + 2–4 _concrete_ casino-design options + free-text +
   "you decide." Apply the answer with a surgical `edit_gdd_doc` to the relevant
   block (read-before-edit), update status, then **re-rank** and continue.
4. **Finalize** — `set_doc_status` → `complete` for resolved docs; summarize
   decisions made and defaults assumed.

**Prompt guardrails** (what makes it "grill us" rather than nag): one question at
a time; only ask about _material_ gaps; never re-ask something already answered;
questions must offer real, opinionated options (not open-ended "what do you
want?"); prefer block-edits over whole-doc rewrites.

Because this is Approach A, the loop is prompt-driven and tunable in the Skill
Editor, and the gap list is currently implicit in the agent's context — leaving
the door open to promote it to a persisted/visible gap board later (Approach C).

## 9. GDD viewer pane (`plugins/gdd`)

A new read-only plugin, structured like `plugins/assets` (its own state slice,
REST load, live Socket.IO updates), tied to the **active room's game** — empty
state if no game is linked.

**Layout** (within the design language — 4 surfaces / 2 hairlines / 3 text
tiers / 1 rationed accent; no raw colors, enforced by the guard test):

```
┌─ GDD ──────────────────────────────────────────┐
│  Theme & Narrative        ✓ complete   │        │   ← TOC rail: the 7 aspects,
│  Math Model               ● needs input│  ##  M │     each with a status marker.
│  Symbols & Reels          ✓ complete   │   atham│   Selecting one shows its
│  Paytable                 — drafted    │  rkdown│     rendered markdown in the
│  Bonus Features           ● needs input│  reader│     reader on the right.
│  UI / UX & Layout         ○ empty      │        │
│  Audio                    ○ empty      │        │
└────────────────────────────────────────┴────────┘
```

- **Status markers** map to `GddDoc.status` (`empty / drafted / needs_input /
complete`). The rationed accent is spent on the single most important signal —
  `needs_input` (where the interview still wants the user) — keeping everything
  else in the neutral text tiers.
- **Live behavior:** as the run seeds, drafts, and block-edits docs, the pane
  updates in place over the existing socket channel; the changed section gets a
  brief `hairline-strong` pulse (no new color) so the user can watch the GDD fill
  in during the interview.
- **State:** `gddSlice()` holding docs keyed by `aspect` plus the selected
  aspect; `GET /games/:gameId/gdd/docs` for the initial load; socket subscription
  for updates — same shape as the Asset Board.
- Read-only in v1 (matches "AI writes, human edits via chat"); a markdown editor
  is a clean future extension.

## 10. Testing strategy

Following the repo mandate — TDD at the unit level (RED-GREEN-REFACTOR),
**Playwright e2e as the authoritative behavioral contract** (local, replay
backend, not in CI), and the cheaper suites CI-affordable.

### Backend unit (pytest, test-first per task)

- `GddStore` — upsert keyed on `(game_id, aspect)` (re-draft updates in place),
  list/get, status transitions.
- Doc tools — `write` creates; **`edit` exact + unique match**, errors on
  missing/ambiguous, `replace_all`, read-before-edit discipline; `set_doc_status`.
- `ask_user_question` — raises the interrupt with the correct payload; resume
  handles `suggestion` / `freetext` / `delegate`; delegate returns the "use your
  judgment" sentinel.
- Generalized interrupt / RoomHub — pending-**question** registration, snapshot
  to a reconnecting subscriber, resume resolves the parked run; **approval-as-
  degenerate-question parity** (`delete_asset` still gated).
- Kickoff taxonomy seeding is idempotent (7 `empty` docs).

### Backend service e2e (non-browser, CI-affordable, `PROVIDER_MODE=replay`)

- A full `design-game` run against **recorded-real cassettes** (test/real
  parity — no degenerate fakes): kickoff seeds 7 docs → draft-all writes drafts →
  hits a question interrupt → resume answer → surgical edit applied → finalize
  sets `complete`. Refresh via `just record-fixtures`.

### Frontend unit (vitest)

- Feed includes the new `question` step; `QuestionCard` renders suggestions /
  free-text / delegate, supports keyboard selection, emits the correct resume
  payload, collapses to the answered state, and renders the approve/reject config
  (parity).
- `gdd` slice/selectors; viewer renders sections + statuses, updates on socket
  event, renders markdown; design-language guard (no raw colors).

### Playwright e2e (authoritative, local, run before every PR)

- End-to-end: link game → describe it in chat → invoke `design-game` → viewer
  shows the 7-section skeleton seeding → drafts appear live → `QuestionCard`
  appears in chat → pick a suggestion → doc updates in viewer → exercise "you
  decide" → run completes, docs `complete`.
- Parity case: existing `delete_asset` approval still works through the
  generalized `QuestionCard`.
- Run `just e2e` against the replay backend before the PR (the careful :8000
  live → replay swap, then restore).

## 11. Future seams (designed-in, not built)

- **External data sources for "you decide"** — the delegate path is structured so
  the AI's decision can later be informed by real data (e.g. comparable-game math
  models) rather than judgment alone.
- **Persisted, visible gap board (Approach C)** — promote the implicit gap list
  to a first-class `Gap` entity with an "open gaps" tracker in the viewer.
- **Editable GDD docs** — turn the read-only viewer into a markdown editor; the
  surgical `edit_gdd_doc` primitive and read-before-edit discipline already make
  AI/human co-editing tractable.
- **`search_gdd` tool** — for when GDDs grow large or multi-file per aspect.
- **Per-game / git-backed taxonomy** — if the fixed config constant proves too
  rigid.
- **Specialized authoring panes** — domain-specific editors (e.g. a paytable
  grid, a math-model calculator) beyond the generic markdown viewer.
