# LLM Chat — shared, multi-user, multi-room LLM interface

- **Date:** 2026-06-19
- **Status:** Design approved; ready for implementation planning
- **Scope:** First real `studio/backend` service + a `studio/frontend` plugin

## 1. Summary

A studio plugin that provides a **shared interface to an LLM**. Multiple users can
join the same **room** (a shared LLM conversation), submit prompts, and watch the
LLM's response **stream in real time to every participant**. Rooms are isolated
(each will eventually map to a game). This is an interface *to an LLM*, not a
human-to-human chat — human-to-human messaging, if ever wanted, is a separate
plugin.

This is the slice that **bootstraps `studio/backend`**: the frontend is currently
in-memory with no networking code, and `studio/backend` (FastAPI + Langchain +
MongoDB) is decided in ADR 0001 but not yet built. This design stands up the first
backend service.

## 2. Requirements

- **Shared sessions / live fan-out.** If client A submits a prompt in a room, both
  A and B (and any other participant) see the response stream in real time.
- **Multiple rooms.** Users create, join, and leave rooms. Each room is an isolated
  conversation. A room carries an optional `gameId` seam for future game association.
- **LLM participation is turn-based.** Every human prompt triggers one LLM response.
  Concurrent prompts in a room are **serialized** via a per-room lock/queue — no
  overlapping completions.
- **Author attribution.** Because multiple humans drive one conversation, messages
  carry the author's display name.
- **Typing indicators / presence.** Participants see who is typing and who is in the
  room.
- **Lightweight identity.** A client supplies a display name (persisted in
  localStorage, sent on connect). No accounts, no auth for this slice.
- **Durable conversations.** Rooms and messages persist in MongoDB (per ADR 0001).
- **Provider-agnostic, OpenRouter first.** The LLM layer is Langchain; OpenRouter is
  the configured backend today. The API key lives server-side only.

## 3. Key decisions (with rationale)

These were settled during brainstorming; recording them so the "why" survives.

### 3.1 Provider: OpenRouter first

- The user's $20/month **ChatGPT Plus subscription does not grant API access** — the
  OpenAI API is billed separately, pay-as-you-go. This ruled out "use the Plus sub."
- OpenRouter chosen: one key, many models, **free (`:free`) variants** for cheap
  development, paid models at cents. Preload a few dollars of credit.
- Implication: **model selection must be trivial to change** (free model for dev,
  reliable paid model when wanted). Per-room model setting (see 6.1).

### 3.2 Transport: Socket.IO (single multiplexed duplex connection)

Considered SSE first (token streaming is unidirectional, and multi-user fan-out is
solved by a server-side broadcast hub, not by the transport). The decision flipped
to Socket.IO once two facts surfaced:

1. **Multiple rooms, joinable/leavable**, possibly **viewed simultaneously** — the
   UI is a dockview multi-pane workbench, so a user can have several room panes open
   at once, each wanting a live stream.
2. **Typing indicators / presence** are genuinely duplex.

N simultaneously-live rooms over SSE means N connections per client *plus* a separate
WebSocket for typing — two overlapping transports, and the HTTP/1.1 ~6-connection
limit looms. A **single multiplexed duplex connection** carrying tokens + typing +
join/leave + presence for all open rooms is cleaner. Socket.IO over raw WebSocket
because its **rooms** abstraction maps 1:1 onto chat rooms and it provides
reconnection/heartbeats/event-multiplexing out of the box — the exact boilerplate we
would otherwise hand-roll.

The **backend↔provider** leg is unaffected: the server still consumes OpenRouter's
streaming HTTP response and re-emits tokens over Socket.IO into the room.

### 3.3 LLM layer: Langchain, behind a thin seam

The simple-streaming case alone would not justify Langchain (a thin httpx/OpenAI-SDK
adapter would do). It is adopted deliberately as the **first-class LLM interface** for
the studio's future direction (agents, RAG over the Mongo store, tool-calling), to
avoid building a throwaway adapter.

- Langchain streams over OpenRouter via `langchain-openai`'s `ChatOpenAI` with
  `base_url` set to OpenRouter's OpenAI-compatible endpoint, consumed through
  `.astream()` / `astream_events`.
- A thin internal seam — `chat_service.stream(messages, model) -> async iterator of
  tokens` — keeps the Socket.IO hub and room-locking logic insulated from Langchain's
  fast-moving surface. Langchain remains first-class for building chains/agents; the
  seam only protects the realtime plumbing from version churn.

### 3.4 Persistence: MongoDB now

Per ADR 0001, Mongo is the studio datastore. Conversations are durable from day one
(this slice stands up Mongo via Docker Compose as part of the backend bootstrap).

### 3.5 Identity: lightweight ephemeral display name

Unlocks attribution, typing, and presence with zero auth machinery. Real accounts +
auth are a clean, self-contained follow-up when access actually needs protecting.

### 3.6 Rooms: standalone now, `gameId` seam for later

No game entities exist yet, so rooms are first-class objects created/named/joined
directly. A nullable `gameId` field makes future game association additive.

## 4. Architecture

```
┌─────────────── studio/frontend (React/Nx) ───────────────┐
│  llm-chat plugin (IPlugin)                                │
│   • Room List pane   • Chat Room pane(s)   • Settings pane │
│   • hookstate slice  • socket.io-client (one connection)  │
└───────────────────────────┬───────────────────────────────┘
                            │  Socket.IO (one multiplexed conn)
                            │  + REST for history / room CRUD
┌───────────────────────────┴─── studio/backend (Python) ───┐
│  FastAPI + python-socketio (ASGI)                          │
│   • RoomHub: per-room subscribers + turn lock/queue        │
│   • chat_service.stream(messages, model)  ── thin seam ──┐ │
│   • ConversationStore (Mongo: rooms, messages)           │ │
└──────────────────────────────────────────────────────────┼─┘
                                                           │ Langchain
                                              ChatOpenAI(base_url=OpenRouter)
                                                           │ stream=True
                                                    ┌──────┴──────┐
                                                    │  OpenRouter │
                                                    └─────────────┘
```

- **One Socket.IO connection per client**, multiplexed across all open rooms.
  Socket.IO rooms = chat rooms.
- **REST (FastAPI)** handles non-realtime concerns: list/create rooms, fetch a
  room's message history on join. REST = past; socket = present.
- **RoomHub** (in-memory) tracks per-room subscribers and owns the per-room turn
  lock/queue.
- **MongoDB** via the async `motor` driver is the durable store.
- **chat_service** is the thin seam over Langchain.

## 5. Data model (MongoDB)

- **`rooms`**: `{ _id, name, gameId: null, model: string, createdAt }`
  - `model` is per-room, defaults to the configured default model.
  - `gameId` is the nullable seam for future game association.
- **`messages`**: `{ _id, roomId, author: string, role: 'user' | 'assistant',
  content: string, status: 'streaming' | 'complete', createdAt }`
  - `author` is the ephemeral display name.
  - Assistant messages start `streaming` and finalize to `complete`.
- **Users are not persisted.** Display name is client-side (localStorage), sent on
  connect.

## 6. Realtime protocol (Socket.IO events)

**Client → server:**

- `join_room { roomId }`
- `leave_room { roomId }`
- `send_prompt { roomId, text }`
- `typing { roomId, isTyping }`

**Server → client:**

- `message_created { message }` — a user OR assistant message has appeared.
- `token { roomId, messageId, delta }` — a streamed assistant token.
- `message_completed { roomId, messageId }`
- `typing { roomId, author, isTyping }`
- `presence { roomId, members[] }`
- `ai_status { roomId, state: 'idle' | 'generating' | 'queued', queueDepth }`
- `error { ... }`

History is **not** replayed over sockets. On join, the client fetches history via
REST (`GET /rooms/{id}/messages`); the socket then carries only live deltas.

## 7. Turn-based queue/lock (concurrency core)

Each room has a **single-flight lock** owned by RoomHub:

1. `send_prompt` arrives → persist the user message (Mongo) → broadcast
   `message_created` to the room.
2. If the room's AI is **idle** → acquire lock, start generation. If **busy** →
   enqueue the prompt, broadcast `ai_status: queued`.
3. On generation start: create a `streaming` assistant message, broadcast
   `message_created`, then fan out `token` deltas to **all** room subscribers as they
   arrive from `chat_service`.
4. On completion: finalize the message (Mongo `complete`), broadcast
   `message_completed`, release the lock, **dequeue** the next prompt if any.

This delivers "A submits, both A and B see the stream" while keeping a busy room
coherent instead of spawning overlapping completions.

## 8. Provider / configuration

- **OpenRouter API key**: server-side only, from `OPENROUTER_API_KEY`, loaded via a
  gitignored `.env`. Never sent to the client.
- **Model selection**: each room stores its `model`. The Settings pane offers a small
  configured list — a cheap `:free` model as the dev default plus a reliable paid
  model. Changing a room's model affects its next generation.
- **Provider abstraction**: Langchain is the interface; OpenRouter is the configured
  backend today. Claude-direct / OpenAI-direct later = additional configured chat
  models behind the same seam.

## 9. Frontend plugin (`studio/frontend/src/plugins/llm-chat/`)

Follows the existing `IPlugin` pattern (manifest + panes + commands + hookstate
slice; `persist: true` for display name and last-open rooms).

- **Room List pane** — list rooms; create; join/leave.
- **Chat Room pane** — parameterized by `roomId` (multiple open at once in dockview);
  shows messages, streaming assistant output, composer, typing indicators, presence.
  One pane instance per room.
- **Settings pane** — display name; per-room model picker.
- A **single `socket.io-client` connection** lives in the plugin (module-scoped) and
  feeds the hookstate slice. Panes subscribe to their room's narrow slice, respecting
  the repo's scoped-subscription discipline (a change in one room's pane must not
  re-render another).

## 10. Testing

Per repo policy: TDD at the unit level; e2e is the authoritative behavioral contract;
browser e2e stays out of CI (cost), non-browser e2e is CI-affordable and gates CI.

- **Unit (pytest, TDD, CI):** `chat_service` seam (mocked Langchain), RoomHub
  lock/queue serialization, ConversationStore.
- **Non-browser e2e (Python Socket.IO suite, CI-gated, authoritative for the
  realtime core):** connect **two** socket clients, join one room, `send_prompt` from
  A, assert **both** receive ordered `token` deltas; assert queue serialization when
  both send concurrently; assert author attribution and typing broadcast.
- **Frontend unit (vitest):** plugin slice/hooks; render-count discipline.
- **Browser e2e (Playwright, local-only):** real two-client streaming in the UI;
  multiple room panes open simultaneously.

## 11. Scope

**In scope:**

- Backend bootstrap: FastAPI + python-socketio + MongoDB (motor) + Langchain.
- Rooms CRUD (REST), room join/leave (socket).
- Shared streaming with per-room turn lock/queue.
- Ephemeral identity (display name).
- Typing indicators and presence.
- OpenRouter via server-side env; per-room model selection.
- The frontend plugin UI (room list, chat room panes, settings).
- Docker Compose for Mongo; `justfile` targets; `uv` for Python deps.

**Out of scope (deliberately):**

- Authentication / user accounts.
- Human-to-human chat (a separate plugin).
- Game entities (only the nullable `gameId` seam is added).
- Multi-worker / horizontal scaling.

**Documented scaling seam:** the in-memory RoomHub assumes a **single `uvicorn`
worker**. Multi-worker requires Redis pub/sub (fan-out) + a distributed lock (turn
serialization). Noted here, not built.

## 12. Open implementation details (for the plan)

These are deferred to implementation planning, not blockers for the design:

- Exact LLM context construction (whether/how author attribution is injected into the
  prompt sent to the model).
- Backend project layout under `studio/backend` (package structure, `pyproject.toml`,
  `uv` setup) and the `compose.yaml` for Mongo.
- Socket.IO ASGI mounting alongside FastAPI and the dev-serve story (`justfile`).
- Reconnection/resume behavior when a client drops mid-stream (history via REST on
  rejoin covers completed messages; behavior for an in-flight stream on reconnect to
  be specified).
