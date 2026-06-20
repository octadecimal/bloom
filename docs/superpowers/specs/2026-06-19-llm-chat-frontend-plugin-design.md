# LLM Chat — frontend plugin (Plan B, subsystem 2) design

- **Date:** 2026-06-19
- **Status:** Design approved (brainstorming complete). Ready for implementation planning.
- **Scope:** The `studio/frontend` `llm-chat` plugin + one small shell-level
  notifications service. **Frontend-only** — the backend (Plan A + subsystem 1) is
  built, merged, and unchanged.
- **Parent spec:** [`2026-06-19-llm-chat-design.md`](./2026-06-19-llm-chat-design.md)
  (esp. §9 and §13 — the Plan-B decisions this design refines).

## 1. Summary

Subsystem 2 builds the user-facing `llm-chat` plugin: a **Room List** splash, a
**single active-room Chat Room** pane (strict singleton, bound to
`slice.activeRoomId`), and a **Settings** pane. It connects to the existing backend
over one Socket.IO connection (live tokens, presence, typing, AI status, in-flight
resume) plus REST (room CRUD, history, model catalogue), feeding a hookstate slice.

This document records the **frontend-specific** decisions the parent spec left open.
It supersedes nothing in the parent spec; it refines §9 / §13.1 for implementation.

## 2. Locked context (from the parent spec §13)

- **Single active-room Chat Room pane** — all panes are strict singletons; opening a
  room re-points the one Chat Room pane via `slice.activeRoomId`. Multi-room view is
  deferred. No core `host/` changes for the pane model.
- **Room List pane** is the splash/home; **Settings pane** holds the model picker.
- **`GET /models`** is the server-authoritative model catalogue.
- **In-flight resume** via `stream_snapshot` on `join_room`.

## 3. Decisions resolved in this brainstorming

1. **Persistence boundary.** The chat slice is **`persist: false`**. Only two durable
   prefs — `displayName` and `activeRoomId` — are saved, explicitly, under their own
   localStorage key via the existing persistence helpers. Rationale: the slice is
   almost entirely transient server-owned state (rooms, messages, streaming buffers,
   presence, typing, AI status) that is always re-fetched; the host's whole-slice
   `persist: true` would serialize message arrays on every streamed token and reload
   stale data at boot. Keeping the plugin's two real prefs self-managed needs **zero
   host changes**; a general field-selective persistence mechanism is deferred until a
   second plugin needs it (YAGNI).
2. **Socket lifecycle: eager.** Open the single Socket.IO connection on plugin
   `init()` using the saved display name. Presence/typing/streaming are ready the
   instant a room opens; socket.io auto-reconnects on backend restart and the client
   re-joins the active room.
3. **Display name: auto-generated default.** On first run assign `guest-NNNN` so the
   app is usable with zero friction; the Settings pane exposes an editable field, and
   changing it reconnects the socket with the new name. No modal gate.
4. **Notifications: a reusable toast system, built shell-level.** Generation `error`
   events, socket reconnect transitions, and REST failures surface as toasts. Built as
   shell chrome (kept **out** of the `IPlugin` contract, consistent with the §13.4
   `layoutPresets` philosophy), using the proven `sonner` library behind a thin
   `notify` seam — never hand-rolled.

> Working principle (applies repo-wide): **prefer proven libraries over hand-rolling**
> where a well-maintained option exists (here: `sonner` for toasts, `socket.io-client`
> for the transport).

## 4. Backend contract consumed (already built — verified against source)

**Base URL** `http://localhost:8000` (CORS `*`; Socket.IO at the default `/socket.io`
path; REST at root). Frontend dev server runs on `:4200`.

**REST (native `fetch`):**

- `GET /models` → `[{ id, label, free }]`
- `GET /rooms` → `Room[]`
- `POST /rooms { name, model? }` → `Room` (201)
- `GET /rooms/{roomId}/messages` → `Message[]`

**Socket.IO — connect** with `auth: { displayName }`.

**Client → server:** `join_room {roomId}`, `leave_room {roomId}`,
`send_prompt {roomId, text}`, `typing {roomId, isTyping}`.

**Server → client:** `message_created {message}`, `token {roomId, messageId, delta}`,
`message_completed {roomId, messageId}`,
`stream_snapshot {roomId, messageId, content, state}`,
`typing {roomId, author, isTyping}` (server skips echo to sender),
`presence {roomId, members[]}` (member display names),
`ai_status {roomId, state, queueDepth}`, `error {roomId, message}`.

Wire shapes are camelCase. `Room = {id,name,model,gameId,createdAt}`,
`Message = {id,roomId,author,role,content,status,createdAt}` where
`role ∈ {user,assistant}` and `status ∈ {streaming,complete}`.

## 5. Module structure

```
src/plugins/llm-chat/
  index.ts            IPlugin manifest: panes, commands, init()/dispose()
  config.ts           backend base URL (VITE_BLOOM_BACKEND_URL ?? http://localhost:8000)
  state.ts            ILlmChatState, makePluginHooks, selector hooks
  reducers.ts         PURE slice mutations (token append, snapshot, …) — unit-tested
  prefs.ts            load/save { displayName, activeRoomId } via persistence helpers
  restClient.ts       fetch wrappers: getModels, getRooms, createRoom, getMessages
  socketClient.ts     module-scoped socket.io singleton; wires socket events -> reducers
  actions.ts          orchestration (loadRooms, openRoom, createRoom, sendPrompt, …)
  RoomListPane.tsx
  ChatRoomPane.tsx
  SettingsPane.tsx
```

REST uses native `fetch` (no axios). The socket + REST clients are module-scoped
singletons created in `init()`; components stay thin and call `actions`.

## 6. State slice & persistence boundary

```ts
type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface ILlmChatState {
  // durable prefs — saved separately under 'bloom.studio.llm-chat.prefs',
  // NOT via persist:true
  displayName: string;
  activeRoomId: string | null;

  connection: ConnState;

  rooms: IRoom[];
  roomsStatus: 'idle' | 'loading' | 'error';

  // the ACTIVE room's live view; every socket event is guarded by
  // roomId === activeRoomId (stray events ignored)
  messages: IMessage[];
  members: string[]; // presence (display names)
  typing: string[]; // who's typing (server already excludes me)
  aiStatus: { state: 'idle' | 'generating' | 'queued'; queueDepth: number };
  roomLoadStatus: 'idle' | 'loading' | 'error'; // history fetch
}
```

The plugin is **`persist: false`**. On `init()`, `prefs.ts` seeds `displayName`
(generating `guest-NNNN` on first run) and `activeRoomId` from the localStorage key
`bloom.studio.llm-chat.prefs` (using the existing `savePersisted`/`loadPersisted`
envelope helpers), and writes back only when those two fields change. All other state
is transient and never persisted.

Only the **active** room's live state is kept (flat fields, not a per-room map): the
single pane joins exactly one room at a time. A future multi-room view is where a
`byRoom` map would be introduced.

`IRoom` / `IMessage` mirror the backend camelCase wire exactly.

## 7. Client lifecycle (orchestration)

- **`init()`**: create REST + socket singletons; `socketClient.connect(displayName)`
  with `auth:{displayName}`; `loadRooms()`. If a saved `activeRoomId` exists, open it
  once connected.
- **connect** → `connection='connected'`; if `activeRoomId`, emit `join_room`.
- **disconnect** → `'reconnecting'` (socket.io auto-reconnects) + toast; **reconnect**
  → re-`join_room(activeRoomId)`.
- **`openRoom(id)`**: noop if same; else `leave_room(prev)` (if connected) → set
  `activeRoomId` → clear messages/members/typing/aiStatus → `roomLoadStatus='loading'`
  → `GET /rooms/{id}/messages` → `join_room(id)` → persist `activeRoomId`. History is
  fetched **before** join so the server's `stream_snapshot` lands after history and
  corrects the in-flight assistant message.
- **`createRoom(name, model?)`**: `POST /rooms` → append/refetch → `openRoom(newId)`.
- **`setDisplayName(name)`**: update slice + prefs → `socketClient.reconnectWith(name)`
  (disconnect + reconnect with new `auth`, then re-join the active room).
- **`sendPrompt(text)`** / **`setTyping(bool)`**: emit on the socket for `activeRoomId`.

## 8. Event application (streaming core)

All handlers are guarded by `roomId === activeRoomId` (stray events ignored). Reducers
in `reducers.ts` are pure and unit-tested.

| Event                                         | Reducer                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `message_created {message}`                   | upsert by `id` (idempotent; creates the streaming assistant placeholder)         |
| `token {messageId, delta}`                    | **find-or-create** assistant message, append `delta` to `content`                |
| `stream_snapshot {messageId, content, state}` | **find-or-create**, **set** `content` to the snapshot (join mid-stream catch-up) |
| `message_completed {messageId}`               | set that message's `status='complete'`                                           |
| `presence {members}`                          | set `members`                                                                    |
| `typing {author, isTyping}`                   | add/remove `author` in `typing`                                                  |
| `ai_status {state, queueDepth}`               | set `aiStatus`                                                                   |
| `error {message}`                             | `notify.error(message)`                                                          |

find-or-create on both `token` and `stream_snapshot` is the safety net for either
arriving before its `message_created`. This mirrors the backend's proven invariant:
`snapshot.content + subsequent tokens == full message`.

## 9. Panes, commands, discoverability

- **RoomListPane** — subscribes to `rooms`/`roomsStatus` only; lists rooms, a "New
  room" input, click opens via `openRoom`. Inline retry text on load error.
- **ChatRoomPane** — bound to `activeRoomId`; renders the message list, streaming
  assistant output, composer, typing line, presence, AI status, and a connection
  indicator (● connected / ○ reconnecting…). Empty state when `activeRoomId == null`.
  **Each message bubble is its own child component subscribed to that message node**,
  so a token append re-renders only the streaming bubble — not the whole list, not the
  Room List. Respects the repo's scoped-subscription / render-count discipline.
- **SettingsPane** — editable display-name field (commit → `setDisplayName`); per-room
  model picker for the active room, options from `GET /models`.
- **Commands** (command palette + auto-listed in the View menu): `Open Room List`,
  `Open Chat Room`, `Open Chat Settings`.
- **Default layout** — add `llm-chat/rooms` (Room List) to `DEFAULT_LAYOUT` so the
  feature is visible on boot. The demo panes (`demo-counter`, `demo-scratch`) are left
  in place for now; retiring them is a separate cleanup, not this subsystem.

## 10. Notifications — shell-level service

Built as reusable chrome, kept **out** of the `IPlugin` contract (consistent with the
§13.4 `layoutPresets` decision):

- Add **`sonner`** (proven, accessible, auto-stacking, auto-dismiss toast).
- `src/components/ui/sonner.tsx` — the shadcn `<Toaster/>`, mounted **once** in
  `Workbench.tsx`.
- `src/lib/notify.ts` — a thin seam: `notify.error(msg)`, `notify.info(msg)` wrapping
  sonner's `toast`. **Plugins import `notify`, never `sonner`** — so the toast library
  is swappable and trivially mockable in vitest.

Chat uses it for generation `error` events, socket reconnecting/reconnected
transitions, and REST failures.

## 11. Testing

Per repo policy: TDD at the unit level; e2e is the authoritative behavioral contract;
browser e2e (Playwright) stays out of CI (cost) and runs locally.

- **vitest (unit, CI):**
  - `reducers` — token append / find-or-create, snapshot set, `message_created`
    upsert idempotency, `message_completed`, typing add/remove, presence, aiStatus.
  - `actions` (mocked clients) — the `openRoom` leave→clear→fetch→join sequence;
    `createRoom`; `setDisplayName` reconnect.
  - `prefs` — load/save + first-run `guest-NNNN` generation.
  - `socketClient` — event-wiring against a mock socket.
  - `notify` seam.
  - **Render-count discipline** — a token append re-renders only the streaming bubble.
- **Playwright (local-only, against the live backend with `llm_backend=fake`):**
  set name in Settings → create room → open → send prompt → see streamed tokens; **two
  browser contexts** (two names) in one room both see the stream and each other in
  presence; typing indicator; **in-flight resume** — a second context joins mid-stream
  and catches up. Mirrors the authoritative backend e2e through the real UI.

## 12. Dependencies & configuration

- **Add:** `socket.io-client` (protocol-matches the Python `python-socketio` server),
  `sonner` (toasts). REST via native `fetch` (no new dep).
- **Config:** `VITE_BLOOM_BACKEND_URL`, defaulting to `http://localhost:8000` (CORS is
  already `*`; same-origin in any future deploy).

## 13. Out of scope (this subsystem)

- Layout presets / the "Layout" menu — that is **subsystem 3** (parent spec §13.4).
- Multi-room simultaneous view (deferred; parent spec §13.1).
- Retiring the demo plugins.
- Auth / accounts; human-to-human chat; game entities (parent spec §11).
