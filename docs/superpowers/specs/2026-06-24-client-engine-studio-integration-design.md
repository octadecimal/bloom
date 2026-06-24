# Client Engine — Studio Integration (Plan 2) Design

- **Date:** 2026-06-24
- **Status:** Approved (design); next step is an implementation plan
- **Component:** `studio/backend/`, `studio/frontend/`, plus a small `runtime/client/` addition
- **Consumes:** the Plan 1 contract — `runtime/client/src/model/ops.ts` (op vocabulary),
  `runtime/client/src/model/document.ts` (`IGameDocument`), and
  `runtime/client/src/protocol/messages.ts` (`InboundMessage`/`OutboundMessage`, `PROTOCOL_VERSION`)
- **Related:** [`2026-06-23-client-engine-design.md`](2026-06-23-client-engine-design.md) (the engine design),
  [`../plans/2026-06-23-client-engine-core.md`](../plans/2026-06-23-client-engine-core.md) (Plan 1, see its "Plan 2" stub)

---

## 1. Essence

Plan 1 built the standalone engine: a node-graph Pixi runtime driven entirely by a
versioned `postMessage` protocol, with **zero studio coupling**. Plan 2 wires that
engine into the studio so the **agentic rail can author a live game scene**: an agent
emits ops as tool calls, the studio persists them and fans them out, and an embedded
engine iframe renders the result incrementally — **no regenerate, no reload**.

The Plan 1 contract is the seam. Plan 2 adds three things around it:

1. **Backend** — durable persistence of one scene document per game, six `scene.*`
   agent tools, and a socket broadcast (`scene_snapshot` + `scene_op`).
2. **Frontend** — a `game` plugin that holds the canonical client model, hosts the
   engine iframe, and bridges ops into it over `postMessage`.
3. **Engine** — the one Plan-1-deferred seam: `event.origin` pinning.

---

## 2. Two decisions that shape this plan

### 2.1 Engine iframe hosting — host-derived URL, env-configurable port

**Hard constraint:** the studio is browsed from another machine on the LAN, so the
iframe `src` and the `postMessage` `targetOrigin` must work cross-machine — **never a
hardcoded `http://localhost:4300`.**

**Decision:** the `GamePreviewPane` derives the engine origin at runtime from
`window.location.hostname` plus an **env-configurable engine port** (default `4300`):

```
engineOrigin = `${window.location.protocol}//${window.location.hostname}:${ENGINE_PORT}`
iframe.src   = `${engineOrigin}/`
```

- Works from any LAN machine (the hostname is whatever the browser used to reach the
  studio).
- **Port is configurable** (`VITE_BLOOM_ENGINE_PORT`, default `4300`) so a parallel
  worktree can offset it — the engine is **not** a hard singleton (mirrors the
  frontend `:4201` worktree-offset convention).
- **No edit to the shared `:4200` Vite proxy** — avoids the fragility of proxying one
  Vite dev server through another (HMR websocket, module base paths), and reduces the
  config surface other sessions could conflict on.

Rejected alternative — a `/engine` → `:4300` Vite proxy giving a same-origin iframe:
simpler origin story, but couples to and edits the shared studio dev server and hits
Vite-through-Vite HMR/base-path quirks.

### 2.2 Op authority — backend-authoritative (Python GraphModel port)

**Decision:** the **backend** is the source of truth for the durable document and for
op validation, matching the established asset/gdd precedent (a backend store + hub is
authoritative; the frontend mirrors over socket).

- `GameSceneStore` holds one `IGameDocument` per game and applies ops through a
  **Python port of Plan 1's `GraphModel`** — the _same_ validation: duplicate id,
  unknown node, single-parent, child-cycle, and `applyBatch` all-or-nothing atomicity.
- An agent tool calls `GameSceneHub.apply_op(game_id, op)` → **validate + apply +
  persist** → emit `scene_op`. An invalid op raises and the tool **returns an error
  string to the agent** (the design's "fail loudly" guarantee, now _semantic_, not
  just arg-shape). The durable document can never rot.
- Works for **headless agent turns** — persistence does not depend on a frontend
  being connected.
- The engine still validates **independently** in the iframe (defense in depth).

**This refines spec §6** of the engine design, which named `studio/frontend` as the
"live canonical writer" that persists through the backend. Plan 2 instead makes the
**backend** the canonical writer (the agent tools that emit ops are backend-side, and
the asset/gdd features already establish backend-authoritative as the repo pattern).
The frontend remains a faithful in-memory replica that drives the iframe.

**Drift risk:** there are exactly **two _validating_ implementations** of the graph
rules — the engine's TS `GraphModel` (Plan 1) and the backend's Python `GraphModel`.
(The frontend reducer is a thin _trusting_ structural applier, not a third validator —
see §3.2.) Drift is mitigated by (a) a **shared set of golden op→document vectors**
exercised by both validating suites, and (b) the engine's independent validation
catching any divergence as an `error` event.

---

## 3. Components

### 3.1 Backend (`studio/backend/app/scene/`)

| Unit             | Responsibility                                                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models.py`      | Pydantic mirror of `IGameDocument`, `INode`, `IEdge`, `IPortRef`, and the `Op` union. Wire (de)serialization (`from`/`to` are reserved-ish field names — alias as needed).                                                                                       |
| `graph_model.py` | `GraphModel` — `apply(op)`, `apply_batch(ops)`, `load(doc)`, read API. Pure, Mongo-free, unit-tested. The Python port of Plan 1 Tasks 3–6 validation.                                                                                                            |
| `store.py`       | `GameSceneStore(db)` over the `game_scenes` collection, **one document per game** (`_id == game_id`). `get_or_create(game_id)`, `apply_op(game_id, op)`, `apply_batch(game_id, ops)` (loads doc → `GraphModel` → persists updated doc), `get_document(game_id)`. |
| `hub.py`         | `GameSceneHub(sio, store)`. `attach(game_id, sid)` → join room + emit `scene_snapshot` (full doc) to that sid. `apply_op` / `apply_batch` → store then emit `scene_op` to the room. Snapshot-on-join + incremental-op, mirroring `GddHub`.                       |
| `sockets.py`     | `register_scene_handlers(sio, hub)` with `join_scene` / `leave_scene`. (Ops originate from agent tools, not client emits, this iteration.)                                                                                                                       |

**Agent tools** (added to `agent_tools.py`, registered in `ToolFactory._BUILDERS`):
`scene_add_node`, `scene_set_prop`, `scene_connect`, `scene_disconnect`,
`scene_remove_node`, `scene_apply_batch`. Each builds an `Op`, calls
`ctx.scene_hub.apply_op` / `apply_batch`, and returns a human-readable result or an
error string on `OpError`. `ToolContext` and `ToolFactory` gain `scene_store` /
`scene_hub`; `main.py` wires them (store → hub → factory → `RoomHub`, plus
`register_scene_handlers`).

**Skill:** `skills/design-scene.md` — frontmatter (`name`, `description`, `args`,
`tools: [scene_add_node, scene_set_prop, scene_connect, scene_disconnect,
scene_remove_node, scene_apply_batch]`) + prose guiding the agent to build a scene
node-graph from user intent (Root → Containers → Sprites, Textures bound via `data`
edges, addressing nodes by stable semantic ids).

### 3.2 Frontend (`studio/frontend/src/plugins/game/`)

Mirrors the assets/gdd plugin shape: `index.ts`, `state.ts`, `reducers.ts`,
`socketClient.ts`, `actions.ts`, `config.ts`, `GamePreviewPane.tsx`, plus `*.spec.ts`.

| Unit                  | Responsibility                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state.ts`            | `IGameState { connection; activeGameId; document: IGameDocument; status }`. The **canonical client model** in hookstate.                                                                                                                                                                                                                                                                               |
| `reducers.ts`         | Pure `applyOpToDocument(doc, op): IGameDocument` (and a `loadDocument`). A **thin, trusting structural applier** — the backend already validated before broadcast, so the frontend does **not** re-run semantic checks (no cycle/parent validation here). It exists so the frontend can re-`init` the iframe from its cached document after an iframe reload without a server round-trip. Unit-tested. |
| `socketClient.ts`     | Connects, joins per-game room, handles `scene_snapshot` (→ `loadDocument` + iframe `init`) and `scene_op` (→ `applyOpToDocument` + forward op to iframe). Scoped by `isActive(gameId)`.                                                                                                                                                                                                                |
| `ProtocolBridge`      | Owns the iframe `Window`. Waits for the engine's `ready` (`OutboundMessage`), then posts `init{document, origin}` and subsequently `op`/`batch` envelopes with `targetOrigin = engineOrigin`. Queues messages sent before `ready`. Listens for `ack`/`error` and surfaces errors.                                                                                                                      |
| `GamePreviewPane.tsx` | A Dockview pane (`IDockviewPanelProps`) rendering the engine `<iframe>` (host-derived src) and wiring the `ProtocolBridge` to the socket-applied op stream. Design-language tokens only (no raw colors). `data-testid` hooks for e2e.                                                                                                                                                                  |
| `actions.ts`          | `openGame` (fetch/snapshot, join room), `closeGame` (leave, clear), `initGame` (boot connect) — mirroring assets/gdd lifecycle, wired into `RoomRoute`.                                                                                                                                                                                                                                                |
| `config.ts`           | `BACKEND_URL` (existing convention) + `ENGINE_PORT` / derived `engineOrigin`.                                                                                                                                                                                                                                                                                                                          |

Plugin registered in `studio/frontend/src/plugins/index.ts`; pane opened via a command.

### 3.3 Engine (`runtime/client`)

Add the Plan-1-deferred **origin pinning**: the engine records the expected studio
origin from the `init` message (or a query param in standalone) and, once known,
ignores `message` events whose `event.origin` does not match. Standalone mode (no
studio origin supplied) keeps accepting any origin, preserving Plan 1 behavior.

---

## 4. Data flow

```
Live AI edit:
  scene.* agent tool (backend)
    → GameSceneHub.apply_op(game_id, op)          [validate via Python GraphModel]
        → GameSceneStore persist (Mongo game_scenes)
        → sio.emit("scene_op", {gameId, op}, room=game_id)
    → frontend socketClient (scene_op)
        → reducers.applyOpToDocument(canonical hookstate)
        → ProtocolBridge.post({v:1, kind:"op", id, op})  [targetOrigin = engineOrigin]
            → engine validates → mutates model → reconciles Pixi → ack

Cold join (open a game):
  socketClient join_scene → backend emits scene_snapshot{document}
    → reducers.loadDocument(hookstate)
    → ProtocolBridge waits for engine `ready`, then post init{document, origin}
        → engine batch-loads → scene appears

Invalid op:
  GraphModel raises OpError → tool returns an error string to the agent
  (durable doc untouched; nothing broadcast)
```

---

## 5. Error handling

- **Backend validation** rejects an invalid op (duplicate/unknown/cycle/two-parents);
  `apply_batch` is transactional (validate-all-then-apply, or none). The tool returns
  the error to the agent; the store and broadcast are untouched.
- **Engine** independently rejects invalid ops with `error{code}` (defense in depth);
  the `ProtocolBridge` surfaces these (they indicate TS/Python drift — a bug signal).
- **Origin mismatch** at the engine is silently ignored (not an app error).
- **Pre-`ready` ops** are queued by the bridge and flushed on `ready` — no lost-message
  race.
- A missing scene document for a game is created empty on first access
  (`get_or_create`).

---

## 6. Testing strategy

Per repo policy: **TDD mandatory**; **e2e is the authoritative behavioral contract**;
browser e2e runs locally only; backend unit + non-browser e2e are CI-affordable.

- **Backend unit (pytest, CI):** `GraphModel` op application + validation +
  `apply_batch` atomicity (the bulk; mirrors Plan 1 unit coverage); `GameSceneStore`
  CRUD + op application against the `bloom_studio_test` DB; tool builders return
  success/error strings.
- **Backend non-browser e2e (pytest `-m e2e`, CI):** a socket.io client joins a scene,
  the hub applies ops, and the client observes `scene_snapshot` + `scene_op`
  (mirrors `tests/e2e/test_assets.py`).
- **Frontend unit (vitest, CI):** `applyOpToDocument` / `loadDocument` reducers;
  `ProtocolBridge` handshake + queue-before-ready + origin targeting (with a fake
  iframe `Window`).
- **Frontend e2e (Playwright, local-only, authoritative):** open a game, drive
  `scene.*` ops through the real backend (replay) + socket + the **real engine
  iframe**, assert the observable scene mutates live with no reload; a second client
  in the same game sees the same scene (room fan-out).
- **Cross-impl golden vectors:** a shared fixture of `op-sequence → expected document`
  exercised by both the Python and TS model suites to catch drift.

### Non-interference (other worktrees)

- Engine port is env-overridable (default `4300`); nothing here is a hard singleton.
- All backend tests use the `bloom_studio_test` DB — never the shared dev DB.
- No GPU/ComfyUI use (Plan 2 references existing assets; generates nothing).
- The live stack (`:4200`/`:8000`/engine) is taken solo for local e2e only, after
  confirming it is free. All code + unit work is parallel-safe.

---

## 7. Scope boundary

**In this iteration:**

- Backend: scene `models`, `GraphModel` (Python port), `GameSceneStore`,
  `GameSceneHub`, `sockets`, the six `scene.*` agent tools, the `design-scene` skill,
  DI wiring, and unit + non-browser e2e.
- Frontend: the `game` plugin (canonical hookstate model, reducers, socketClient,
  actions), `GamePreviewPane` hosting the host-derived engine iframe, the
  `ProtocolBridge`, registration + lifecycle, and unit + (local) e2e.
- Engine: `event.origin` pinning supplied via `init`.

**Labeled, not built:**

- Client-initiated ops (drag a sprite → op): all mutation stays agent-driven this
  iteration; the bridge is already op-shaped so it is purely additive.
- Multiple scenes per game (the store is keyed one-doc-per-game).
- A `scene_op` _client→server_ socket path (ops originate from agent tools now).
- Sharing the model implementation across TS/Python via codegen (we hand-mirror +
  golden vectors this iteration).
- Asset-reference resolution beyond passing `Texture.src` through to the engine's
  `resolveSrc` (the asset → URL mapping reuses the existing `/media` convention; richer
  resolution is deferred).

---

## 8. Open / deferred decisions

- Exact `Texture.src` → URL resolution for the embedded engine (reuse the assets
  plugin's media URL shape; finalized during planning against the assets `restClient`).
- Whether the frontend also needs a REST `getScene` fallback or relies solely on the
  `scene_snapshot` socket event on join (lean: socket snapshot, mirroring gdd).
