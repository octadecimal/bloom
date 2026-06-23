# Agentic Skill Chat — Slice 3: destructive tool + library-native approval gate

- **Date:** 2026-06-22
- **Status:** Design approved (brainstorming). Ready for implementation planning.
- **Builds on:** Slice 1 (PR #44, `54f8d53`) and Slice 2 (PR #45, `8194096`) and their
  designs ([slice 1](2026-06-22-agentic-skill-chat-design.md),
  [slice 2](2026-06-22-agentic-skill-chat-slice-2-design.md)).
- **Scope:** Give the agent its first **destructive tool** (`delete_asset`) and its first
  **human-in-the-loop approval gate**, built on LangGraph's native `interrupt()` +
  checkpointer — the proven primitive that a Claude-Code-like approve/deny workflow grows
  from. A read tool (`list_assets`) and a proving skill (`manage-assets`) complete the loop.

## 1. Summary

Slices 1–2 proved the vertical with a single **creative** tool (`generate_asset`) and made
git-authored skills invocable via a typed form and authorable in-studio. Slice 3 adds the
first tool that can **destroy** state and the first turn that must **pause for a human**:

- **`list_assets`** (read, **ungated**) lets the agent see what is on the Asset Board so it
  can choose what to act on.
- **`delete_asset`** (**destructive, gated**) pauses the turn via LangGraph's `interrupt()`,
  surfaces an **approval card**, and deletes only on explicit approval; denial returns a
  normal tool result the agent reasons about.
- **`manage-assets`** (new skill) drives the full loop: list the board, then delete the
  targeted asset(s) — each deletion gated.

The gate is the **library-blessed human-in-the-loop primitive** (`interrupt()` +
checkpointer), not a hand-rolled state machine. This is a deliberate reversal of an early
in-tool-future sketch: the destination is a Claude-Code-like workflow (approve/deny, then
later always-allow / edit-args / per-tool policy), and the LangGraph interrupt is the
foundation those later slices hang off of.

## 2. Guiding principles (carried forward)

- **Leverage libraries over hand-rolling.** The gate uses LangGraph's `interrupt()` +
  `MemorySaver` checkpointer — no bespoke HITL machinery. The react agent and the single
  forward stream are otherwise unchanged. (See `prefer-proven-libraries`.)
- **Test/real parity is mandatory.** The interrupt sits _between_ existing graph steps and
  **adds no model invocation**, so the replay cassette's prompt sequence is unchanged. No
  new provider surface. (See `test-real-parity`.)
- **E2e is the authoritative behavioral contract**, and browser e2e stays out of CI.
- **Design language is authoritative** — the approval card is a floating-card surface with
  a rationed accent on the destructive action, per `docs/design-language.md`.
- **TypeScript interfaces use the `I` prefix** (`docs/coding-standards.md`).
- **YAGNI** — approve/deny only this slice; always-allow, edit-args, per-tool policy memory,
  and durable cross-restart resume are explicitly deferred (the foundation supports them).

## 3. Key decisions (with rationale)

### 3.1 Approval gate is now real — the deferral from slices 1–2 ends

Slices 1–2 deferred the approval gate because, with every skill PR-reviewed, an approval
gate "gated nothing" — it had no real consumer. **`delete_asset` is that consumer.** A tool
that irreversibly removes an asset from the board is genuinely worth confirming, so the gate
finally earns its place.

### 3.2 LangGraph `interrupt()` + checkpointer — not an in-tool future state machine

An early sketch put the pause inside the tool as a hand-rolled `asyncio.Future` branch. We
**reject** that: the destination is a Claude-Code-like workflow (approve / deny → later
always-allow, edit-args, per-tool policies, resumable sessions), and a bespoke branch is
exactly what that would outgrow. LangGraph's `interrupt()` with a checkpointer **is** the
proven primitive for human-in-the-loop, so adopting it is leveraging the library, not
rolling our own. The react agent and `astream_events` pass are otherwise untouched.

### 3.3 Selective gating via `interrupt()` _inside_ the tool — not `interrupt_before`

`interrupt_before=["tools"]` would pause the whole ToolNode and gate `list_assets` too.
Instead, `delete_asset` calls `interrupt({...})` itself before deleting; `list_assets` never
does. The tool is its own gate declaration — minimal, honest, and per-tool selective. A
generic per-skill `requires_approval` flag remains a documented seam (§7) but has no
consumer this slice.

### 3.4 In-memory checkpointer (`MemorySaver`); the run stays open while awaiting

`MemorySaver` backs the interrupt/resume this slice. The run task **stays open** (the room
stays `busy`) while awaiting the human decision, then resumes via `Command(resume=decision)`
from the checkpoint — consistent with the existing held-open-run socket architecture and the
in-process checkpointer. A **durable Mongo checkpointer** (interrupted run survives a server
restart) is a documented seam for a later slice; adopting it requires no rework because the
primitive is unchanged.

### 3.5 Denial is a tool result, not an error; timeout is a denial

On approve, the tool performs the delete and returns a confirmation. On deny, it returns
`"Deletion denied by the user."` — a normal tool result the model sees and concludes from,
keeping the turn graceful. A decision **timeout is treated as a denial** (same path), so a
run never hangs forever.

## 4. Architecture (delta from slice 2)

The agent loop, provider seam, run model, and realtime protocol are reused; the deltas are
localized to the tool layer, the runner's resume path, and one new socket event + step type.

```
studio/frontend (llm-chat plugin)
  Run timeline: render an `approval` step as an APPROVAL CARD (Approve/Deny)           [NEW]
                Approve/Deny → emit `resolve_approval` {roomId, runId, decision}        [NEW]
              │ inbound socket `resolve_approval`
studio/backend (Python)
  agent_tools: list_assets (read, ungated) + delete_asset (destructive, interrupt())   [NEW]
               ToolFactory registers both builders                                      [EDIT]
  TurnRunner:  attach MemorySaver + thread_id; detect interrupt → emit `approval` step; [EDIT]
               resume entry re-enters astream_events with Command(resume=decision)
  RoomHub:     hold run open on interrupt; per-run Future; `resolve_approval` resolves; [EDIT]
               timeout → deny; project new `approval` step events
  sockets:     `resolve_approval` inbound handler → hub                                 [NEW]
  runs:        RunStep gains type "approval"                                            [EDIT]
  skills/manage-assets.md                                                               [NEW]
```

## 5. Components

### 5.1 Read tool — `list_assets` (`app/agent_tools.py`)

- `list_assets() -> str`: returns a compact summary (id, name, category) of the current
  game's assets via `AssetStore.list_assets(ctx.game_id)`, so the agent can choose targets.
- **Ungated** — never calls `interrupt()`.
- Registered in `ToolFactory._BUILDERS` alongside `generate_asset`.

### 5.2 Destructive tool — `delete_asset` (`app/agent_tools.py`)

- `delete_asset(asset_id: str) -> str`:
  1. Resolve the asset (name for the human label); if unknown, return a clear not-found
     string (no interrupt).
  2. `decision = interrupt({"tool": "delete_asset", "args": {"asset_id": ...},`
     `"label": "Delete '<name>' (id <id>) — this can't be undone."})`.
  3. On `"approve"` → `AssetStore.delete_asset(asset_id)` + board-removal notify (mirror the
     pattern in `app/assets/rest.py:94`), return a confirmation string.
  4. On `"deny"` (or timeout-driven deny) → return `"Deletion denied by the user."`.
- The tool **declares its own gate** by calling `interrupt()`; nothing else is gated.

### 5.3 Proving skill — `skills/manage-assets.md`

```markdown
---
name: manage-assets
description: Review the Asset Board and remove assets you no longer want (deletion is confirmed).
args:
  - { name: target, type: string, required: true, description: 'Which asset(s) to remove, described in words' }
tools: [list_assets, delete_asset]
---

You help curate the game's Asset Board. First call list_assets to see what exists. Then,
for each asset that matches the target, call delete_asset with its id — each deletion will
be confirmed by a human before it happens. After acting, state in one sentence what was
removed (or that nothing matched / the human declined).
```

### 5.4 Runner — interrupt detection + resume (`app/turn_runner.py`)

- Build the react agent with a `MemorySaver` checkpointer; pass a per-run `thread_id`
  (the run id) in the stream `config`.
- During `astream_events`, when the graph interrupts, the stream yields control with the
  interrupt payload available (the `__interrupt__` value / a captured `GraphInterrupt`).
  The runner emits a new **`ApprovalRequired`** event carrying the pending action
  (`tool`, `args`, `label`), then returns from the current stream pass.
- **Resume path:** `run(..., resume=decision)` (or an explicit `resume()` coroutine)
  re-enters `agent.astream_events(Command(resume=decision), config={thread_id})` from the
  checkpoint and continues projecting the same `StepStarted`/`StepToken`/`StepCompleted`
  events, ending in `RunFinished`.
- Parity: the interrupt adds no model invocation, so the replay prompt sequence across the
  pause is identical to an ungated run.

### 5.5 Hub — hold open, resolve, timeout (`app/room_hub.py`)

- In `_run_skill`, on an `ApprovalRequired` event: project it as an `approval` run step
  (status `running`, content = pending action), keep the run task **open**, and `await` a
  per-run `asyncio.Future` (keyed by run id) with a timeout.
- New `resolve_approval(room_id, run_id, decision)` hub method resolves that Future. Any
  room member may resolve (collaborative, consistent with the room model). Unknown/loser
  resolutions are ignored idempotently.
- On resolution (or timeout → `"deny"`), drive the runner's resume path with the decision;
  complete the `approval` step (status `complete`, content includes the decision) and
  continue projecting until `RunFinished`.
- Run status stays `running` while awaiting; the unresolved `approval` step drives the UI.
  Late joiners get the pending card for free via the existing `run_snapshot`.

### 5.6 Socket event — `resolve_approval` (`app/sockets.py`)

- New inbound `@sio.on("resolve_approval")` handler: reads `{roomId, runId, decision}` and
  calls `hub.resolve_approval(...)`. `decision` is constrained to `"approve" | "deny"`.

### 5.7 Run model — `approval` step type (`app/runs.py`)

- `RunStep.type` gains `"approval"`. No new run status; the step's lifecycle (`running` →
  `complete`) and content (pending action + resolved decision) carry the gate state. Reuses
  the existing `run_step_started` / `run_step_completed` emits and the `run_snapshot` replay.

### 5.8 Approval card (frontend, `plugins/llm-chat/`)

- Render an `approval` step as a **floating-card** approval card in the run timeline:
  shows the `label`, **Approve** (rationed accent — destructive) and **Deny** buttons.
- Approve/Deny → emit `resolve_approval` `{roomId, runId, decision}`; buttons disable after
  resolution; the card then shows the outcome (approved / denied).
- State/render-count discipline preserved; interfaces use the `I` prefix; no raw colors
  outside `styles.css` (guard test).

## 6. Testing (the ladder)

Per repo policy: TDD at the unit level; e2e is the authoritative behavioral contract;
browser e2e stays out of CI; non-browser e2e is CI-affordable and gates CI.

- **pytest unit (CI):**
  - `list_assets` returns the game's assets and **never interrupts**;
  - `delete_asset` **interrupts** with the pending-action payload; `Command(resume="approve")`
    deletes + notifies the board; `resume="deny"` does **not** delete and returns the denied
    string; unknown `asset_id` returns not-found without interrupting;
  - `TurnRunner` emits `ApprovalRequired` on interrupt and resumes cleanly with a decision;
  - `RunStep` accepts the `approval` type.
- **pytest realtime/socket (CI):**
  - a `manage-assets` run emits an `approval` step; `resolve_approval(approve)` deletes the
    asset and the run completes; the deny path leaves the asset and completes gracefully;
  - **timeout → deny** path; a **late joiner** receives a `run_snapshot` showing the pending
    approval card; resolution by a second member works.
- **Replay parity (CI):** unchanged — the gate adds no model call; the committed-fixtures
  guard covers any `manage-assets` cassette if one is recorded.
- **vitest (CI):** the approval card renders from an `approval` step (label + buttons);
  Approve/Deny emit `resolve_approval` with the right payload; buttons disable after
  resolution; the outcome is shown.
- **Playwright (local-only):** invoke `manage-assets` → the agent calls `list_assets` then
  proposes a delete → the **approval card appears** → **Approve** removes the asset from the
  Asset Board and the agent confirms; a second run + **Deny** leaves the asset and the agent
  says the deletion was cancelled.

## 7. Scope

**In scope:**

- `list_assets` (read, ungated) + `delete_asset` (destructive, `interrupt()`-gated), both
  registered in `ToolFactory`.
- LangGraph `interrupt()` + `MemorySaver` gate with a runner **resume** path keyed by run id.
- `RoomHub` holds the run open on interrupt, resolves via a per-run Future, **timeout → deny**.
- New inbound `resolve_approval` socket event and new `approval` `RunStep` type (reusing
  existing step emits + `run_snapshot`).
- Approval card in the run timeline (floating-card, rationed destructive accent).
- `skills/manage-assets.md`.
- The full test ladder above.

**Out of scope (later slices; the foundation supports them):**

- **Always-allow / "don't ask again", edit-args before approval, per-tool policy memory.**
- **Durable Mongo checkpointer** (cross-restart resumable runs).
- More destructive tools; run-the-game; file ops on game files.
- A generic per-skill `requires_approval` config / editor surface.

**Documented seams for later:**

- The checkpointer is swappable — `MemorySaver` → a Mongo checkpointer with no change to the
  interrupt primitive.
- The interrupt payload (`tool`, `args`, `label`) is the contract a richer approval UI
  (edit-args, always-allow) will extend.
- A per-skill / per-tool `requires_approval` policy can layer over the `interrupt()` call
  site without changing the resume protocol.

## 8. Open implementation details (for the plan)

- Exact mechanics of detecting the interrupt within `astream_events` (inspecting the
  `__interrupt__` channel vs. catching `GraphInterrupt`) and the precise resume signature
  (`run(resume=...)` overload vs. a dedicated `resume()` coroutine on `TurnRunner`).
- The board-removal notification on delete (which `asset_hub` / socket event the studio
  already uses to drop an asset from the board, mirrored from `app/assets/rest.py:94`).
- The approval **timeout** duration and where it lives (hub constant vs. config).
- Whether `list_assets` returns categories/thumbnail metadata or a minimal id/name/category
  triple (default: minimal).
- The approval card's exact placement/registration in the run-timeline component and which
  existing run-step renderer it composes with.
- Whether a `manage-assets` replay cassette is recorded this slice or the realtime test runs
  against the existing fixture set.
