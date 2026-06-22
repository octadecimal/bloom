# Agentic Skill Chat — a Claude-Code-like chat for iterative game development

- **Date:** 2026-06-22
- **Status:** Design approved (brainstorming). Ready for implementation planning.
- **Scope:** Slice 1 of a multi-slice initiative — turn the text-only `llm-chat`
  into a **tool-calling agent** driven by **markdown-defined skills**, proven
  end-to-end with one real skill.

## 1. Summary

`llm-chat` today is a shared, multi-user, **text-only** streaming interface: a human
prompt produces one streamed assistant message. This initiative evolves it into a
**Claude-Code-like agent for iterative game development** — the chat runs an
**agentic tool-calling loop** (built on **LangChain / LangGraph**), and users invoke
**skills** (markdown files, git-authored) that bind a curated prompt + tool allowlist
to drive real actions on the game.

**Slice 1** delivers the whole vertical for a single skill so every layer is proven
at once: the agent runner, the first tool (ComfyUI asset generation, reusing the
existing pipeline), the repo skill registry, `/skill` invocation, a **structured run
timeline** surfaced live to every room participant, and the test ladder — shipped
with one real skill, `generate-sprite`.

This is deliberately a **vertical slice**, not an abstract "engine," so it is
demoable and de-risks all layers together.

## 2. Guiding principles (carried from prior work)

- **Leverage libraries over hand-rolling.** LangChain/LangGraph own the agent loop,
  tool dispatch, and retries. (See `prefer-proven-libraries`.)
- **Test/real parity is mandatory.** The agent loop MUST run in `PROVIDER_MODE=replay`
  with recorded-real cassettes, offline and deterministic. (See `test-real-parity`.)
- **E2e is the authoritative behavioral contract**, and browser e2e stays out of CI.
- **Design language is authoritative** — all new UI follows `docs/design-language.md`.
- **TypeScript interfaces use the `I` prefix** (`docs/coding-standards.md`).

## 3. Key decisions (with rationale)

These were settled during brainstorming; recording the "why" so it survives.

### 3.1 Agentic, not prompt-only — built on LangChain

A skill executes **real tools**, not just guidance. The agent loop is built on
**LangGraph** (`create_react_agent`) over LangChain chat models — the maximal use of
the libraries already adopted as the studio's first-class LLM interface (see the
original `llm-chat` design §3.3).

### 3.2 Unified executor — every turn is an agent invocation (chosen over a parallel path)

Rather than run skills through a new path while leaving plain chat on
`chat_service.stream`, **every turn is a LangGraph agent invocation**:

- **Plain message** = the agent with **no skill bound and an empty tool allowlist**.
- **`/skill` run** = the same agent with the skill's prompt + tool allowlist bound.

`chat_service.stream` is **replaced** by the new `TurnRunner`, not paralleled by it.
One executor, one replay surface → **parity by construction** and the maximal-LangChain
architecture.

**Why this is safe, not just optimistic:** the regression surface is the working
streaming/turn-lock/presence contract, which is **fully covered by the authoritative
realtime e2e suite**. Green = safe. The no-tool case is rendered onto the *existing*
wire protocol (§5.2), so the frontend plain-chat path and the existing suite are
untouched and serve as the safety net. Plain-chat migration onto the runner is the
**last task**, behind that green suite; if it cannot be kept green, plain chat falls
back to the legacy path with zero impact on the shipped skill feature.

### 3.3 Explicit `/skill` invocation (model auto-select deferred)

Skills are invoked by an explicit slash command — deterministic, demoable, testable.
The human chooses the skill; the agent drives the tool loop. Model **auto-selection**
of skills by description is a slice-2 concern.

### 3.4 Skills are repo markdown at the repo root, git-authored

Skills are **product content** — a curated, PR-reviewed capability library that sits
above any one service. They live at the **repo root `skills/`** directory (not under
`studio/backend/`), making them a first-class concept and keeping the door open for
other services to read the same source. The backend loads them via a configured path
(default `<repo-root>/skills/`). User-authored / Mongo-backed skills are a slice-2
concern.

### 3.5 Skill format: frontmatter (typed args + tool allowlist) + prose body

A skill **declares which tools it may use** and its **typed args**, constraining the
agent for the run — more deterministic and safer than a freeform prose-only skill.

### 3.6 Structured run timeline (not hidden steps, not plain messages)

A skill run is a **first-class object** with ordered, streamed steps rendered as
tool-call cards — the "watch it work" feel that makes it Claude-Code-like — surfaced
live to **all** room participants.

### 3.7 Asset generation auto-runs (no approval gate)

The `generate_asset` tool runs autonomously: asset generation is non-destructive
(it adds an asset) and is the entire point. Approval gates are a slice-2 concern for
destructive tools (file writes, entity deletes).

## 4. Architecture

```
┌──────────────── studio/frontend (React/Nx) — llm-chat plugin ───────────────┐
│  Composer: '/' → skill autocomplete (GET /skills) → emit run_skill           │
│  RunTimeline: streamed tool-call cards (design-language floating cards)       │
│  hookstate run-state keyed by runId; plain-chat path UNCHANGED                │
└───────────────────────────────┬──────────────────────────────────────────────┘
              Socket.IO: run_skill ↑   run_started/run_step_*/run_completed ↓
              (legacy message_created/token/message_completed for plain chat)
┌───────────────────────────────┴──────────────── studio/backend (Python) ─────┐
│  RoomHub  — per-room turn lock/queue (reused), fans out events                │
│    └─ consumes RunEvent stream; projects → legacy events (no skill)           │
│                                  or  → run_* events + Run persistence (skill)  │
│  TurnRunner.run(room, messages, skill|None, args, model) -> AsyncIterator[RunEvent]
│    builds create_react_agent(chat_model, tools = skill.tools or [])           │
│    system prompt = base + skill.body; streams LangGraph events → RunEvent      │
│  SkillRegistry — loads <repo-root>/skills/*.md, validates, GET /skills         │
│  ToolFactory — builds tools per-run bound to {room, gameId, hubs}              │
│    • generate_asset → existing ComfyUI/AssetHub/store pipeline                 │
│  build_chat_model(settings, model) -> BaseChatModel  (tool-capable)           │
│    live   → ChatOpenAI(base_url=OpenRouter)                                    │
│    replay → ReplayToolCallingChatModel(cassette)  (NEW)                        │
│  Stores: ConversationStore (rooms/messages) + RunStore (runs)  — Mongo         │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 5. Components

#### 5.1 The seam shift — `build_chat_model`

The provider seam moves **up one level**: from "stream tokens"
(`LLMProvider.stream(turns, model) -> AsyncIterator[str]`) to "**supply a
tool-capable LangChain chat model**":

```
build_chat_model(settings, model) -> BaseChatModel        # supports .bind_tools()
   live    → ChatOpenAI(model, base_url=OpenRouter)        # tool-call capable today
   replay  → ReplayToolCallingChatModel(cassette)          # NEW (§5.5)
```

This is the one structural change to the provider layer. LangGraph drives the chat
model; the executor never calls a raw token stream.

#### 5.2 `TurnRunner` + wire-compat projection

`TurnRunner.run(room, messages, skill|None, args, model)` builds
`create_react_agent(chat_model, tools)` where `tools` is the skill's allowlisted tools
(empty for plain chat) and the system prompt is `base + skill.body`. It consumes
LangGraph's streamed events and yields a **uniform `RunEvent` stream**:

| LangGraph event | RunEvent |
| --- | --- |
| LLM token chunk | `thinking`/`final` token delta |
| tool start | `tool_call` (tool name + args) |
| tool end | `tool_result` (structured result) |
| final message | `final` complete |

`RoomHub` consumes this iterator where it consumes `chat_service` today, under the
**same per-room turn lock**, and projects it:

- **skill is None** → existing `message_created` / `token` / `message_completed`.
  Frontend + existing e2e suite untouched (the safety net).
- **skill present** → persist a `Run` and emit `run_*` events (§5.6).

#### 5.3 Skill registry + loader

- Loads `<repo-root>/skills/*.md` at startup (configurable path; dev hot-reload
  optional). Frontmatter is **pydantic-validated**; the loader **fails fast** if a
  skill names an unknown tool or has malformed args.
- Exposes `GET /skills → [{ name, description, args }]` (server-authoritative,
  mirroring `GET /models`).
- **Skill file format:**

```markdown
---
name: generate-sprite
description: Generate a game sprite from a description and add it to the Asset Board.
args:
  - { name: description, type: string, required: true }
  - { name: style, type: string, required: false }
tools: [generate_asset]
---
You are generating a single game sprite. Use the generate_asset tool with a
prompt derived from the user's description and style. Confirm what you made.
```

#### 5.4 Invocation — `run_skill`

New typed client→server event **`run_skill { roomId, skillName, args }`**. The
composer parses `/generate-sprite description="..." style="..."` into
`{ skillName, args }`; the server validates `args` against the skill's schema and
emits an `error` event on mismatch. (Chosen over reusing `send_prompt` with slash-text
— a typed event is testable and enables autocomplete + validation.)

Arg syntax for slice 1: `key=value` pairs (quoted values allowed), validated against
the declared typed args. Rich per-arg form UI is deferred to slice 2.

#### 5.5 Replay tool-calling chat model (parity)

`ReplayToolCallingChatModel` is a `BaseChatModel` subclass that **replays recorded
tool-call + text sequences deterministically**. The LLM cassette format extends so a
recorded turn step can be either a **tool call** (tool name + args) or **text chunks**.
`just record-fixtures` is extended to capture a real agent run's tool-call sequence +
final text from the live provider. The `generate_asset` tool uses the **existing asset
replay** in replay mode. This is the one parity cost of slice 1 — and it is required by
skills regardless of the unified-executor decision.

#### 5.6 Run model + realtime protocol

- **Mongo `runs`:** `{ _id, roomId, skillName, args, status: running|completed|error,
  steps[], createdAt, completedAt }`; step =
  `{ index, type: thinking|tool_call|tool_result|final, toolName?, content, status }`.
- **Server → client events:** `run_started`, `run_step_started`, `run_step_token`
  (streamed thinking/final deltas), `run_step_completed`, `run_completed`.
- **Resume:** a mid-run joiner receives a **`run_snapshot`** (the run doc so far),
  mirroring the existing `stream_snapshot` pattern (`llm-chat` design §13.3); live
  events resume after.
- **Concurrency:** runs **serialize on the existing per-room turn lock** — no
  overlapping runs/turns in a room.

#### 5.7 The one tool — `generate_asset`

A LangChain `@tool` wrapping the **existing** ComfyUI / AssetHub / asset-store
pipeline, built **per-run by a `ToolFactory` bound to the turn's context**
(`{ room, gameId, hubs }`) rather than as a global singleton. It kicks a generation
job, awaits the existing completion path, attaches the asset to the active game, and
returns a structured result (asset id + image ref) that renders as a tool-result card
linking into the Asset Board. **Auto-runs**, no approval gate (§3.7).

#### 5.8 Frontend

- **Composer:** detect leading `/`, autocomplete skills from `GET /skills`, parse args,
  emit `run_skill`. Plain text still emits `send_prompt` (unchanged).
- **`RunTimeline`:** renders run steps as **floating-card tool-call cards** per
  `docs/design-language.md` — thinking text, a tool-call card (tool + args + spinner),
  a tool-result card (generated-asset thumbnail → Asset Board), final answer.
- **State:** hookstate run-state keyed by `runId`; new reducers for `run_*` events;
  scoped-subscription / render-count discipline preserved. Interfaces use the `I`
  prefix.

## 6. Testing

Per repo policy: TDD at the unit level; e2e is the authoritative behavioral contract;
browser e2e stays out of CI; non-browser e2e is CI-affordable and gates CI.

- **pytest unit (CI):** skill loader/validation (unknown-tool **fails fast**), arg
  validation, `TurnRunner` RunEvent mapping (fake tool-calling chat model), per-run
  tool-context binding, `RunStore`.
- **pytest realtime (CI, authoritative for the core):** two clients in a room,
  `run_skill` from A → **both** receive ordered `run_*` events and the asset is
  attached; concurrent runs serialize on the lock; a third client joining mid-run gets
  a `run_snapshot` that + subsequent events reconstructs the run. **The existing chat
  realtime suite stays green** — the migration safety net.
- **Replay parity (CI):** a recorded tool-calling cassette drives a full run offline;
  `just record-fixtures` captures tool-call sequences; committed-fixtures guard covers
  the new cassettes.
- **vitest (CI):** run reducers (token-append into the in-flight step), slash-command
  parsing/autocomplete, render-count discipline.
- **Playwright (local-only):** `/generate-sprite …` → watch the run timeline → asset
  appears on the Asset Board; a second client watches the same run live.

## 7. Scope

**In scope:**

- The provider **seam shift** to `build_chat_model` + `ReplayToolCallingChatModel`.
- `TurnRunner` on LangGraph; the **wire-compat projection** and the **plain-chat
  migration** (last task, behind the existing suite).
- Skill **registry/loader** from `<repo-root>/skills/`; `GET /skills`.
- The `generate_asset` tool + per-run `ToolFactory` context binding.
- Run model, `run_*` events, `run_snapshot` resume; per-room lock serialization.
- Composer slash-command + autocomplete; `RunTimeline` UI.
- **One shipped skill:** `skills/generate-sprite.md`.
- The full test ladder above.
- New dependency: `langgraph` (via `uv`); `langchain-openai` already present.

**Out of scope (slice 2+):**

- More tools: game-data/entity mutation, project/file ops, run/inspect the game.
- Model **auto-selection** of skills by description.
- **User-authored / Mongo-backed** skills + authoring UI.
- Rich per-arg form UI; approval gates for destructive tools.
- Multi-room concurrent panes.

**Documented seams for later:**

- The `SkillRegistry` source is behind a seam → a Mongo-backed source slots in later.
- The `ToolFactory` registry → new tools register without touching the runner.
- The unified executor already covers plain chat → no second path to migrate later.

## 8. Open implementation details (for the plan)

- Exact LangGraph streaming mode (`astream_events` v2 vs `astream(stream_mode=...)`)
  and the precise event→RunEvent mapping.
- The `ReplayToolCallingChatModel` cassette schema and the record path's capture of
  tool-call args.
- Whether dev hot-reload of skills is included or deferred.
- `generate_asset` argument surface (size/style passthrough to the existing pipeline)
  and how job progress maps onto `run_step` status.
- Backend package layout for the new modules (`turn_runner`, `skills`, `tools`,
  `run_store`) and `langgraph` pinning under `uv`.
