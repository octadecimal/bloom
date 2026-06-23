# Natural Skill Invocation + Keyboard Autocomplete — Design

**Date:** 2026-06-23
**Status:** Approved (design); ready for implementation plan
**Area:** `studio/frontend` (llm-chat plugin) + `studio/backend` (turn_runner, room_hub)

## Problem

The skill autocomplete in the llm-chat composer is a plain clickable list with
**no keyboard support** — no Tab completion, no arrow-key navigation, no
highlight. Worse, two latent bugs make skills feel broken:

1. **Args never reach the agent.** `TurnRunner.run` builds the agent's context
   from only the room's prior user messages (`turn_runner.py:73`). The `args`
   parameter is accepted but never injected into the prompt, and `run_skill`
   never persists the slash text as a message. So in **live** mode,
   `/generate-sprite description="a knight"` sends the agent *nothing* about a
   knight — it asks "what's the description?" again. Replay only works because
   the cassette is hardcoded. **This is the root cause of "the sprite generator
   asks for a description even after I provided one."**

2. **Picking a skill discards what you typed.** Clicking a match opens a
   *blank* `SkillForm`; any text already in the draft is thrown away.

## Goal

Make slash-invocation natural and keyboard-driven: **type `/`, Tab to complete,
type a description as prose, Enter to run** — and let the skill (agent) infer
its arguments from that prose. The typed form becomes the *optional* explicit
path, used only when no prose is supplied.

## Non-goals

- Skill auto-selection (the agent choosing a skill on its own).
- Durable Mongo checkpointer / always-allow approval editing (tracked
  separately).
- `key="value"` composer syntax — **explicitly dropped** (see Decisions).

## Interaction model (composer)

The autocomplete popup is shown **only while the draft matches `/word` with no
space** — i.e. while the user is still choosing a skill. Once a space exists,
selection is over and the popup hides; trailing text is prose.

| Key      | When                                            | Behavior |
|----------|-------------------------------------------------|----------|
| **↑ / ↓**| popup open                                      | Move the highlighted skill; wraps at both ends. |
| **Tab**  | popup open                                       | Auto-complete: draft becomes `/<name> ` (trailing space), popup closes, focus stays in composer. |
| **Enter**| popup open                                       | Same as Tab — accept the highlight, complete inline. |
| **Esc**  | popup open                                       | Dismiss popup; draft unchanged. |
| **Enter**| popup closed, draft = `/<name> ` **+ prose**     | **Run** the skill; prose is the agent's inference input. |
| **Enter**| popup closed, draft = `/<name> ` **and nothing** | **Open + focus the form** for explicit arg entry. |
| **Click**| popup open                                       | Same as Tab (complete inline) — consistent with Tab/Enter. |

Worked example:
- `/gen` → popup lists `generate-sprite`, `generate-background` (highlight on
  first). `↓` moves highlight. `Tab` → draft = `/generate-sprite ` , popup gone.
- Type `a knight in armor`, press `Enter` → run with prose
  `"a knight in armor"`.
- Or, after Tab, press `Enter` immediately (empty) → the `SkillForm` opens and
  focuses for explicit field entry.

### Highlight default & filtering
- Matches filter by `name.startsWith(prefix)` (unchanged from today).
- Highlight defaults to index 0 whenever the match set changes; clamp on
  filter changes so the index never points past the list.
- If there are zero matches, the popup does not render and Tab/Enter fall back
  to their default composer behavior (Tab inserts nothing special; Enter follows
  the popup-closed rules).

## Backend fix (load-bearing)

When a skill runs, synthesize exactly one **invocation `HumanMessage`** appended
to the agent's message context so the agent actually receives the user's intent:

- **Prose path:** the user's typed text becomes that message verbatim
  (`"a knight in armor"`).
- **Form path:** the structured field values are rendered into a readable
  message — e.g. `description="a knight", style="pixel"` — so the agent uses
  them instead of asking.

Additionally, the typed prose is **persisted as the invoking user's message** in
the room (via the existing message store) so the chat history shows what was
asked and subsequent turns retain context. The form path may persist a concise
synthetic line (e.g. `/generate-sprite (description="a knight", style="pixel")`)
for the same reason.

### Where the change lands
- `room_hub.handle_skill_run` / `_run_skill`: carry an optional `text` (prose)
  alongside `args`; persist the user message; pass `text` through to the runner.
- `TurnRunner.run`: build the invocation message from `text` (if present) else
  from `args`, and append it as the final `HumanMessage` in `lc`.
- `sockets.run_skill`: accept an optional `text` field on the payload.
- Frontend `runSkill(skillName, args, text?)` and `socketClient.runSkill`: thread
  the prose text on the wire.

### Replay/cassette impact
Appending the invocation message **changes the prompt key** the replay model is
keyed on. Cassettes must be re-recorded (`just record-fixtures`) after the
change. This is expected and called out in the plan.

## Decisions

- **Drop `key="value"` composer parsing.** Trailing composer text is always
  prose for the agent to infer from; the **form** is the structured path. This
  collapses two client code paths into one and matches "let the skill infer it."
  `parseSlashCommand`'s arg-parsing is removed; only skill-name extraction
  remains (or it is replaced by a small `splitSlashDraft` helper returning
  `{ skillName, prose }`).
- **Form is optional, reached only via bare-Enter** after completion. It no
  longer auto-opens on selection.
- **Enter-while-popup-open accepts the highlight** (does not run), because the
  user is still selecting; running only happens once the popup is closed.

## Components & data flow

```
composer keydown ──▶ keyboard reducer (pure)
                       │  state: { highlight }
                       │  inputs: key, matches, draft
                       └─▶ action: accept(name) | move(±1) | dismiss
                                   | run(skillName, prose) | openForm(skillName)

accept(name)      ──▶ setDraft(`/${name} `), close popup
run(name, prose)  ──▶ runSkill(name, {}, prose) ─▶ socket run_skill {text}
openForm(name)    ──▶ render SkillForm; submit ─▶ runSkill(name, args)

backend run_skill ──▶ handle_skill_run(text?, args)
                       ├─ persist user message
                       └─ queue skill descriptor {text, args}
                            └─ _run_skill ─▶ TurnRunner.run(text, args)
                                              └─ append invocation HumanMessage
```

### Render-count discipline
The popup (`SkillAutocomplete`) stays an isolated sub-component subscribing to
the `skills` leaf. The highlight index is local UI state. The keyboard reducer
is a pure function (no store reads) so it is unit-testable and does not perturb
the existing render-count guards. Lifting the `matches`/`highlight` so the
composer's `onKeyDown` can act on them must not subscribe `ChatRoomPane` to
`skills` on the no-popup hot path — gate the `.get()` behind "draft starts with
`/` and has no space," mirroring the existing form-open guard.

## Testing

Per AGENTS.md: TDD for pure logic; Playwright e2e is the authoritative behavioral
contract.

**Unit (RED first):**
- Keyboard reducer: highlight move + wrap; accept produces `/<name> `; clamp on
  match-set change; run-vs-form decision from `{ skillName, prose }`.
- `splitSlashDraft` (prose extraction): `/gen` → choosing; `/generate-sprite a
  knight` → `{ skillName, prose: "a knight" }`; `/generate-sprite ` →
  `{ skillName, prose: "" }`.
- Backend invocation-message builder: prose → verbatim; args → rendered
  `k="v"` summary; precedence prose-over-args.

**E2e (authoritative, replay backend):**
- Arrow-navigate the popup changes the highlighted option.
- Tab completes the name into the composer (`/generate-sprite `) and dismisses
  the popup.
- Tab-complete → type prose → Enter → run timeline shows the `generate_asset`
  tool call and the final "Asset Board" text.
- Tab-complete → bare Enter → `skill-form` appears and is focused.
- Esc dismisses the popup.
- Rewrite the existing `description="a knight"` spec to natural prose
  `/generate-sprite a knight`.

**Cassettes:** re-record after the prompt change; `just e2e` against replay
must pass before PR (per repo policy).

## Rollout

Single cohesive feature; one implementation plan. The backend arg-delivery fix
is the highest-value piece and should land with its own unit + e2e coverage even
if the keyboard UX is split into a follow-up task within the same plan.
