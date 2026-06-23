# Unified chronological chat feed — design

**Date:** 2026-06-23
**Status:** approved (brainstorming) — ready for implementation plan
**Backlog item:** llm-chat #2 — fold tool-call / run-step messages into the actual
chat history, retiring the separate `RunTimeline` so there is one unified,
chronologically-correct chat feed instead of two parallel UIs.

## Problem

The studio chat plugin renders **two parallel UIs**:

- `MessageList` — chat bubbles from `messages[]`
  (`message_created` / `token` / `stream_snapshot` / `message_completed` wire).
- `RunTimeline` — skill-run steps from `runs[]`
  (`run_started` / `run_step_started` / `run_step_token` / `run_step_completed` /
  `run_completed` / `run_snapshot` wire).

`RunTimeline` is a sibling pinned **below** `MessageList`, so a skill run's steps
never sit chronologically between the messages around them. A session of
`prompt → skill run → prompt` shows all chat bubbles, then all run steps at the
bottom — chronologically wrong.

Two further defects compound this:

1. **Reload gap.** Runs are persisted in Mongo (`RunStore`) but there is no REST
   endpoint to fetch them, and `openRoom` only loads `messages`. After a refresh,
   run steps vanish — only the invocation message survives.
2. **Cross-room leak.** `openRoom` / `closeRoom` never reset `runs[]` /
   `activeRunId`, so the previous room's runs linger in state when switching rooms
   (`RunTimeline` renders all of `runs[]` with no room filter).

## Goal

One unified, chronologically-correct chat feed. A skill run renders inline as a
single grouped assistant turn, in its correct position relative to surrounding
chat bubbles, and survives a page reload.

## Decisions (from brainstorming)

1. **Architecture — frontend-fold, keep the run model.** The backend `Run` model
   and the `run_*` socket wire stay as-is (the freshly-landed LangGraph
   interrupt / approval machinery is untouched). The frontend folds run events
   into a single ordered feed; the run model remains the server-side source of
   truth for skill execution.
2. **Reload gap — in scope.** Add a runs-history fetch on room open and merge runs
   into the feed by timestamp, so the feed is correct after a refresh.
3. **Run layout — grouped assistant turn.** A run renders as one assistant-turn
   block (AI avatar + accent rail, mirroring assistant-bubble styling) containing
   its tool-call / result cards, approval card, and final text.
4. **Feed container — reuse `chat-messages`.** The existing
   `<ul data-testid="chat-messages">` becomes the single feed list; no new
   `chat-feed` testid.
5. **Bundle the two latent-bug fixes** (reload gap, cross-room leak) into this work.

## Architecture

### Feed model (frontend)

The feed is **derived, not stored** — no third source of truth. A pure selector
merges the two existing collections:

```ts
type IFeedEntry =
  | { kind: 'message'; id: string; createdAt: string }
  | { kind: 'run'; id: string; createdAt: string };

function buildFeed(messages: IMessage[], runs: IRun[]): IFeedEntry[];
```

- Sorted by `createdAt` (ISO string), stable. A run is created *after* its
  invocation user message, so it naturally sorts immediately after that message.
- Tie-break: stable sort preserves insertion order; when timestamps are equal the
  message precedes the run (messages pushed before runs in the merge input).
- During a live session the natural arrival order already matches chronology; the
  timestamp sort is what makes **reload** correct, where both collections are
  fetched up front.

`messages[]` and `runs[]` remain the two source collections. `RunTimeline.tsx` is
deleted; its `RunStepCard` / `RunStepList` rendering moves into `RunTurnBlock`.

### Rendering

The single feed `<ul data-testid="chat-messages">` renders each entry by kind:

- `message` → `ChatMessageBubble` (unchanged).
- `run` → **new `RunTurnBlock`** — a grouped assistant turn:
  - AI avatar + accent rail mirroring `ChatMessageBubble`'s assistant styling.
  - Body: maps `run.steps` through the existing step rendering —
    `tool_call` / `tool_result` cards, `approval` → `ApprovalCard`, and
    `thinking` / `final` text styled like an assistant bubble.

**Render-count discipline (preserved).** The list component subscribes only to
what defines feed length/order; each entry component reads only its own node
(`ChatMessageBubble` its message node, `RunTurnBlock` its run node). A
`run_step_token` therefore re-renders only the streaming `RunTurnBlock`, never
sibling bubbles or the list shell — matching the current per-bubble subscription
pattern.

**Preserved `data-testid`s:** `run-step-${index}`, `approval-card`, and the
tool-name text are kept inside `RunTurnBlock` so behavioral assertions survive.
The `run-timeline` testid is removed (its specs are updated to the unified feed).

### State & reducers

- Add `createdAt: string` to `IRun` (the wire already sends `createdAt` via
  `run_wire` camelCasing). `startRun` / `applyRunSnapshot` carry it through.
  All other reducers unchanged.
- **Bug fix:** `openRoom` / `closeRoom` reset `runs: []` and `activeRunId: null`
  alongside the existing `messages` / `members` / `typing` resets.

### Backend — reload gap

- `RunStore.list_runs(room_id)` → runs for the room sorted by `created_at`.
- Expose `fastapi_app.state.run_store = run_store` in `main.py` (created today but
  not attached to app state).
- `GET /rooms/{room_id}/runs` in `rest.py` → `[run_wire(r) …]`, mirroring
  `/rooms/{room_id}/messages` (404 on unknown room).
- `restClient.getRuns(roomId)` mirroring `getMessages`.
- `actions.openRoom` fetches messages **and** runs in parallel and sets both
  (guarding on the latest `activeRoomId`, as the messages fetch already does).

## Data flow

**Live skill run** (unchanged wire): `handle_skill_run` emits `message_created`
(the invocation user message) → `run_started` → `run_step_*` → `run_completed`.
The frontend reduces these into `messages[]` and `runs[]` as today; `buildFeed`
interleaves them so the run block appears right after its invocation message.

**Reload:** `openRoom` → `getMessages` + `getRuns` → `messages[]` + `runs[]` set
→ `buildFeed` orders them by `createdAt` → run blocks reappear inline.

## Testing

TDD is mandatory; the Playwright e2e suite is the authoritative behavioral
contract.

### Unit (RED → GREEN → REFACTOR)

- `buildFeed`: ordering, interleaving (`prompt → run → prompt`), equal-timestamp
  tie-break (message before run), empty inputs.
- `IRun.createdAt` carried through `startRun` / `applyRunSnapshot`.
- `RunTurnBlock`: renders tool-call/result cards, approval card, and final text;
  preserves `run-step-${index}` / `approval-card` testids.
- Render-count: a `run_step_token` re-renders only the target `RunTurnBlock`, not
  sibling `ChatMessageBubble`s or the list shell.
- `openRoom` clears `runs[]` / `activeRunId` on room switch.

### e2e (update the contract — `just e2e`, replay backend)

- `skill-run.spec` + `manage-assets-approval.spec`: assert against the unified
  feed instead of `run-timeline` (tool name, final text, approval flow still
  observable inside the feed).
- **Interleave** spec: `prompt → /generate-sprite … → prompt`, assert DOM order
  of bubbles and the run block in the feed.
- **Reload** spec: after a skill run completes, `page.reload()` and assert the run
  steps reappear inline (covers the reload-gap fix).

## Files touched

**Frontend**
- `studio/frontend/src/plugins/llm-chat/RunTimeline.tsx` — deleted.
- `studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx` — new (grouped turn).
- `studio/frontend/src/plugins/llm-chat/feed.ts` — new (`buildFeed` selector).
- `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx` — `MessageList`
  renders the unified feed; drop the standalone `<RunTimeline />`.
- `studio/frontend/src/plugins/llm-chat/state.ts` — `IRun.createdAt`.
- `studio/frontend/src/plugins/llm-chat/reducers.ts` — carry `createdAt`.
- `studio/frontend/src/plugins/llm-chat/actions.ts` — `openRoom` fetch+reset runs;
  `closeRoom` reset runs.
- `studio/frontend/src/plugins/llm-chat/restClient.ts` — `getRuns`.

**Backend**
- `studio/backend/app/runs.py` — `RunStore.list_runs`.
- `studio/backend/app/rest.py` — `GET /rooms/{room_id}/runs`.
- `studio/backend/app/main.py` — `app.state.run_store = run_store`.

**Tests**
- Unit specs for `feed.ts`, `RunTurnBlock.tsx`, reducers, actions.
- `studio/backend/tests/` — `list_runs` + the new endpoint.
- e2e: update `skill-run.spec` / `manage-assets-approval.spec`; add interleave +
  reload specs.

## Out of scope

- Collapsing the backend run model into the chat-message wire (the "messages-as-
  wire" purist option) — deferred; this design keeps the run model.
- Skill auto-select, durable Mongo checkpointer, always-allow / edit-args
  (later backlog seams).
