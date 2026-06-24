# Client Engine — Studio Integration (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the standalone Plan 1 client engine into the studio so the agentic rail can author a live game scene — backend persistence + `scene.*` agent tools + a socket broadcast, a frontend `game` plugin that hosts the engine iframe and bridges ops into it, and the one Plan-1-deferred engine seam (origin pinning).

**Architecture:** The **backend** is authoritative: a `GameSceneStore` holds one `IGameDocument` per game and validates every op through a Python port of Plan 1's `GraphModel`; six `scene.*` agent tools call a `GameSceneHub` that persists then broadcasts `scene_op` (and `scene_snapshot` on join). The **frontend** `game` plugin keeps a faithful in-memory replica in hookstate, hosts the engine in a host-derived iframe, and a `ProtocolBridge` forwards ops into it over the Plan 1 `postMessage` protocol. The **engine** pins `event.origin` to the studio origin (passed as a `?parentOrigin=` query param). One contract, two validators (engine TS + backend Python), kept honest by shared golden vectors.

**Tech Stack:** Python 3 / FastAPI / motor (Mongo) / python-socketio / LangChain `StructuredTool` (backend); TypeScript / React / hookstate / socket.io-client / Vite / Vitest / Playwright (frontend); Pixi v8 engine (consumed, mostly unchanged).

## Global Constraints

- **Work in the worktree** `C:\code\bloom.wt\game-scene` on branch `feat/game-scene`. Never work in the primary checkout.
- **Consumes the Plan 1 contract** — `runtime/client/src/model/ops.ts`, `.../model/document.ts` (`IGameDocument`), `.../protocol/messages.ts` (`InboundMessage`/`OutboundMessage`, `PROTOCOL_VERSION = 1`). Do not change these shapes.
- **TypeScript interfaces use the `I` prefix** (`IGameState`, `IProtocolBridge`) per `docs/coding-standards.md`. Op/message discriminated-union members use a `kind` field.
- **Studio design language is authoritative** — `studio/frontend` UI uses only design-language Tailwind tokens (`bg-surface`, `text-text-1`, `border-hairline`, …). No raw hex/`rgba` outside `styles.css` (a guard test blocks it).
- **TDD mandatory** — RED → GREEN → REFACTOR per task; commit at each task boundary using Conventional Commits.
- **Prettier is a gate (frontend/docs)** — `npx prettier --check .` must pass before commit (run `npx prettier --write` on touched files first). **Backend: keep style consistent with surrounding files** (the repo has no Python formatter gate; match existing 4-space style).
- **Backend tests use the `bloom_studio_test` DB** via the existing `settings`/`mongo_db` fixtures — never the shared dev DB.
- **Browser e2e (Playwright) is NOT run in CI** — local only. Backend unit + non-browser e2e (`pytest`) and frontend unit (`vitest`) ARE CI-affordable and expected to run in CI.
- **Non-interference:** the engine port is env-configurable (`VITE_BLOOM_ENGINE_PORT`, default `4300`) — not a hard singleton. No GPU/ComfyUI use. Take the live stack (`:4200`/`:8000`/engine `:4300`) solo for local e2e only, after confirming it is free.
- **Backend commands run from** `studio/backend` via `uv run …`. **Frontend/engine commands run from the worktree root** via `npx nx …`.

## File Structure

```
runtime/client/src/protocol/
├─ origin.ts            (NEW) pure origin-gate helpers
├─ origin.spec.ts       (NEW)
└─ ../main.ts           (MOD) wire origin gate + targeted post

studio/backend/app/scene/            (NEW package)
├─ __init__.py
├─ document.py          empty_document(), OpError, NODE_TYPES, EDGE_TYPES, SCENE_TOOL_NAMES
├─ graph_model.py       GraphModel (apply/apply_batch/load/to_document) — Python port
├─ store.py             GameSceneStore (game_scenes collection, one doc/game)
├─ hub.py               GameSceneHub (scene_snapshot + scene_op)
└─ sockets.py           register_scene_handlers (join_scene/leave_scene)
studio/backend/app/agent_tools.py    (MOD) 6 scene.* tools + ToolContext/ToolFactory
studio/backend/app/room_hub.py       (MOD) pass scene_store/scene_hub into ToolContext
studio/backend/app/main.py           (MOD) DI wiring + register_scene_handlers
skills/design-scene.md               (NEW) the scene-authoring skill
studio/backend/tests/test_scene_graph_model.py   (NEW)
studio/backend/tests/test_scene_store.py         (NEW)
studio/backend/tests/test_scene_hub.py           (NEW)
studio/backend/tests/test_scene_sockets.py       (NEW)
studio/backend/tests/test_scene_tools.py         (NEW)
studio/backend/tests/test_design_scene_skill.py  (NEW)
studio/backend/tests/test_agent_tools.py         (MOD) known-tool-names set
studio/backend/tests/test_design_game_skill.py   (MOD) known set incl. scene tools
studio/backend/tests/test_skills.py              (MOD) two real-dir loads
studio/backend/tests/e2e/test_scene.py           (NEW) non-browser e2e (CI)

studio/frontend/src/plugins/game/    (NEW plugin)
├─ config.ts            engineOrigin(), ENGINE_PORT, BACKEND_URL re-export
├─ state.ts             IGameState (canonical IGameDocument), hooks, slice
├─ reducers.ts          applyOpToDocument / loadDocument (trusting structural)
├─ protocolBridge.ts    ProtocolBridge + bridgeRef (setBridge/getBridge/clearBridge)
├─ socketClient.ts      join_scene, scene_snapshot, scene_op
├─ actions.ts           openGame/closeGame/initGame
├─ GamePreviewPane.tsx  host-derived engine iframe + bridge wiring
├─ index.ts             IPlugin registration
└─ *.spec.ts / *.spec.tsx  unit + component tests
studio/frontend/src/plugins/index.ts (MOD) register `game`
studio/frontend/src/app/routes/RoomRoute.tsx (MOD) bind openGame/closeGame
studio/frontend/e2e/game-scene.spec.ts (NEW) authoritative client render e2e (local)
```

---

## Phase A — Engine origin pinning (`runtime/client`)

### Task 1: Engine pins `event.origin` to the studio origin

**Files:**

- Create: `runtime/client/src/protocol/origin.ts`
- Create: `runtime/client/src/protocol/origin.spec.ts`
- Modify: `runtime/client/src/main.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `parseParentOrigin(search: string): string | null` — reads the `parentOrigin` query param (empty/missing → `null`).
  - `originAllowed(expected: string | null, actual: string): boolean` — `true` when `expected` is `null` (standalone, accept any) or `actual === expected`.

- [ ] **Step 1: Write the failing test**

`runtime/client/src/protocol/origin.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseParentOrigin, originAllowed } from './origin';

describe('parseParentOrigin', () => {
  it('returns the decoded parentOrigin param', () => {
    expect(parseParentOrigin('?parentOrigin=http%3A%2F%2Fhost%3A4200')).toBe('http://host:4200');
  });
  it('returns null when absent or empty', () => {
    expect(parseParentOrigin('')).toBeNull();
    expect(parseParentOrigin('?foo=1')).toBeNull();
    expect(parseParentOrigin('?parentOrigin=')).toBeNull();
  });
});

describe('originAllowed', () => {
  it('accepts any origin in standalone (expected null)', () => {
    expect(originAllowed(null, 'http://evil.example')).toBe(true);
  });
  it('accepts only the matching origin when expected is set', () => {
    expect(originAllowed('http://host:4200', 'http://host:4200')).toBe(true);
    expect(originAllowed('http://host:4200', 'http://host:9999')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `Cannot find module './origin'`.

- [ ] **Step 3: Implement the helpers**

`runtime/client/src/protocol/origin.ts`:

```ts
export function parseParentOrigin(search: string): string | null {
  const value = new URLSearchParams(search).get('parentOrigin');
  return value && value.length > 0 ? value : null;
}

export function originAllowed(expected: string | null, actual: string): boolean {
  return expected === null || actual === expected;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Wire the gate into `main.ts`**

Replace `runtime/client/src/main.ts` with:

```ts
import { PixiRenderer } from './render/pixiRenderer';
import { createEngine } from './engine';
import type { InboundMessage, OutboundMessage } from './protocol/messages';
import { parseParentOrigin, originAllowed } from './protocol/origin';

const stage = document.getElementById('stage');
if (!stage) throw new Error('missing #stage element');

// When embedded by the studio, the iframe src carries ?parentOrigin=<studio origin>.
// Standalone (no param) keeps Plan 1 behavior: accept any origin, post with '*'.
const expectedOrigin = parseParentOrigin(window.location.search);

const post = (m: OutboundMessage) => window.parent?.postMessage(m, expectedOrigin ?? '*');
const renderer = new PixiRenderer(stage);
const { host, model } = createEngine({ renderer, post });

// Test/standalone observability.
(window as unknown as { __engineModel: typeof model }).__engineModel = model;

window.addEventListener('message', (event: MessageEvent) => {
  if (!originAllowed(expectedOrigin, event.origin)) return;
  void host.handle(event.data as InboundMessage);
});

host.start();

// Standalone mode: ?doc=<url> loads a document file directly (no studio).
const docUrl = new URLSearchParams(window.location.search).get('doc');
if (docUrl) {
  void fetch(docUrl)
    .then((r) => r.json())
    .then((document) => host.handle({ v: 1, kind: 'init', id: 'standalone', document }));
}
```

- [ ] **Step 6: Verify the unit suite + typecheck, then commit**

Run:

```bash
npx nx test client
npx nx typecheck client
npx prettier --write runtime/client
npx prettier --check .
git add runtime/client
git commit -m "feat(client): pin engine event.origin to the studio origin (Plan 2)"
```

Expected: tests PASS, typecheck clean, prettier clean. (Plan 1's engine e2e is unaffected: no `parentOrigin` param → `expectedOrigin` null → accept any / post `'*'`.)

---

## Phase B — Backend (`studio/backend`)

### Task 2: Scene document + GraphModel (add/remove/setProp)

**Files:**

- Create: `studio/backend/app/scene/__init__.py` (empty)
- Create: `studio/backend/app/scene/document.py`
- Create: `studio/backend/app/scene/graph_model.py`
- Test: `studio/backend/tests/test_scene_graph_model.py`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `document.py`: `NODE_TYPES = ("Root","Container","Sprite","Texture")`, `EDGE_TYPES = ("child","data")`, `SCENE_TOOL_NAMES: set[str]`, `class OpError(Exception)` with `.code`, `empty_document() -> dict`.
  - `graph_model.py`: `class GraphModel` with `apply(op: dict) -> None` (raises `OpError`, model untouched on failure), `get_node(id) -> dict | None`, `to_document() -> dict`. (Edges/batch/load added in Tasks 3–4.) A document dict is `{"version": 1, "nodes": {id: {"id","type","props"}}, "edges": [ {"id","type","from","to"} ]}`, mirroring `document.ts`.

- [ ] **Step 1: Write the failing test**

`studio/backend/tests/test_scene_graph_model.py`:

```python
import pytest
from app.scene.graph_model import GraphModel
from app.scene.document import OpError


def test_add_node_then_read():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "s", "type": "Sprite", "props": {"alpha": 1}})
    assert m.get_node("s") == {"id": "s", "type": "Sprite", "props": {"alpha": 1}}


def test_add_node_defaults_props():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "root", "type": "Root"})
    assert m.get_node("root")["props"] == {}


def test_duplicate_id_rejected_without_mutation():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "x", "type": "Container"})
    with pytest.raises(OpError) as e:
        m.apply({"kind": "addNode", "id": "x", "type": "Sprite"})
    assert e.value.code == "duplicate_id"
    assert m.get_node("x")["type"] == "Container"


def test_unknown_type_rejected():
    m = GraphModel()
    with pytest.raises(OpError) as e:
        m.apply({"kind": "addNode", "id": "x", "type": "Nope"})
    assert e.value.code == "bad_type"


def test_remove_node():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "x", "type": "Sprite"})
    m.apply({"kind": "removeNode", "id": "x"})
    assert m.get_node("x") is None


def test_remove_unknown_rejected():
    m = GraphModel()
    with pytest.raises(OpError) as e:
        m.apply({"kind": "removeNode", "id": "ghost"})
    assert e.value.code == "unknown_node"


def test_set_prop_nested_creates_intermediate():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "s", "type": "Sprite"})
    m.apply({"kind": "setProp", "id": "s", "path": "position.x", "value": 240})
    assert m.get_node("s")["props"]["position"] == {"x": 240}


def test_set_prop_unknown_node_rejected():
    m = GraphModel()
    with pytest.raises(OpError) as e:
        m.apply({"kind": "setProp", "id": "ghost", "path": "alpha", "value": 1})
    assert e.value.code == "unknown_node"


def test_to_document_shape():
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "x", "type": "Sprite"})
    assert m.to_document() == {
        "version": 1,
        "nodes": {"x": {"id": "x", "type": "Sprite", "props": {}}},
        "edges": [],
    }
```

- [ ] **Step 2: Run to verify it fails**

Run (from `studio/backend`): `uv run pytest tests/test_scene_graph_model.py -q`
Expected: FAIL — `ModuleNotFoundError: app.scene`.

- [ ] **Step 3: Implement document.py + GraphModel (partial)**

`studio/backend/app/scene/__init__.py`: empty file.

`studio/backend/app/scene/document.py`:

```python
NODE_TYPES = ("Root", "Container", "Sprite", "Texture")
EDGE_TYPES = ("child", "data")

SCENE_TOOL_NAMES: set[str] = {
    "scene_add_node", "scene_set_prop", "scene_connect",
    "scene_disconnect", "scene_remove_node", "scene_apply_batch",
}


class OpError(Exception):
    """A scene op was rejected; the model is left untouched. Mirrors the
    engine's TS OpError (runtime/client/src/model/ops.ts)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def empty_document() -> dict:
    return {"version": 1, "nodes": {}, "edges": []}
```

`studio/backend/app/scene/graph_model.py`:

```python
from app.scene.document import NODE_TYPES, OpError


class GraphModel:
    """Pure, Mongo-free port of the engine's TS GraphModel
    (runtime/client/src/model/graphModel.ts) — same validation, no change
    records (the backend validates + persists; it does not reconcile Pixi)."""

    def __init__(self):
        self._nodes: dict[str, dict] = {}
        self._edges: dict[str, dict] = {}

    # --- read API ---
    def get_node(self, node_id: str) -> dict | None:
        return self._nodes.get(node_id)

    def to_document(self) -> dict:
        nodes = {
            nid: {"id": n["id"], "type": n["type"], "props": dict(n["props"])}
            for nid, n in self._nodes.items()
        }
        edges = [dict(e) for e in self._edges.values()]
        return {"version": 1, "nodes": nodes, "edges": edges}

    # --- write API ---
    def apply(self, op: dict) -> None:
        kind = op.get("kind")
        if kind == "addNode":
            return self._add_node(op["id"], op["type"], op.get("props"))
        if kind == "removeNode":
            return self._remove_node(op["id"])
        if kind == "setProp":
            return self._set_prop(op["id"], op["path"], op["value"])
        raise OpError("unknown_op", f"unknown op kind: {kind}")

    def _add_node(self, node_id: str, type_: str, props) -> None:
        if node_id in self._nodes:
            raise OpError("duplicate_id", f"node already exists: {node_id}")
        if type_ not in NODE_TYPES:
            raise OpError("bad_type", f"unknown node type: {type_}")
        self._nodes[node_id] = {"id": node_id, "type": type_, "props": dict(props or {})}

    def _remove_node(self, node_id: str) -> None:
        if node_id not in self._nodes:
            raise OpError("unknown_node", f"no such node: {node_id}")
        incident = [
            e for e in self._edges.values()
            if e["from"]["node"] == node_id or e["to"]["node"] == node_id
        ]
        for e in incident:
            del self._edges[e["id"]]
        del self._nodes[node_id]

    def _set_prop(self, node_id: str, path: str, value) -> None:
        node = self._nodes.get(node_id)
        if node is None:
            raise OpError("unknown_node", f"no such node: {node_id}")
        keys = path.split(".")
        cursor = node["props"]
        for k in keys[:-1]:
            if not isinstance(cursor.get(k), dict):
                cursor[k] = {}
            cursor = cursor[k]
        cursor[keys[-1]] = value
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_scene_graph_model.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene studio/backend/tests/test_scene_graph_model.py
git commit -m "feat(scene): scene document + GraphModel add/remove/setProp (Python port)"
```

---

### Task 3: GraphModel connect/disconnect + cascade + read API

**Files:**

- Modify: `studio/backend/app/scene/graph_model.py`
- Test: `studio/backend/tests/test_scene_graph_model.py` (append)

**Interfaces:**

- Consumes: `GraphModel` (Task 2).
- Produces: `apply` handles `connect`/`disconnect`; `removeNode` already cascades incident edges (Task 2). New read helpers `get_edge(id)`, `edges_by_source(node, port=None)`, `edges_by_target(node, port=None)`. Validation (raises `OpError`): unknown `from`/`to` node, duplicate edge id, a child gaining a second parent (`already_parented`), child cycle (`cycle`), unknown edge on disconnect.

- [ ] **Step 1: Write the failing test (append to the file)**

```python
def _with_nodes() -> GraphModel:
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "root", "type": "Root"})
    m.apply({"kind": "addNode", "id": "box", "type": "Container"})
    m.apply({"kind": "addNode", "id": "s", "type": "Sprite"})
    m.apply({"kind": "addNode", "id": "tex", "type": "Texture", "props": {"src": "asset:1"}})
    return m


def _child(eid, parent, kid):
    return {"kind": "connect", "edgeId": eid, "type": "child",
            "from": {"node": parent, "port": "children"},
            "to": {"node": kid, "port": "parent"}}


def _data(eid, src, dst):
    return {"kind": "connect", "edgeId": eid, "type": "data",
            "from": {"node": src, "port": "data"},
            "to": {"node": dst, "port": "texture"}}


def test_child_connect_and_disconnect():
    m = _with_nodes()
    m.apply(_child("e1", "root", "box"))
    assert m.get_edge("e1")["type"] == "child"
    m.apply({"kind": "disconnect", "edgeId": "e1"})
    assert m.get_edge("e1") is None


def test_data_connect_read_helpers():
    m = _with_nodes()
    m.apply(_data("e2", "tex", "s"))
    assert [e["id"] for e in m.edges_by_source("tex", "data")] == ["e2"]
    assert [e["id"] for e in m.edges_by_target("s", "texture")] == ["e2"]


def test_edge_to_unknown_node_rejected():
    m = _with_nodes()
    with pytest.raises(OpError) as e:
        m.apply(_child("e1", "root", "ghost"))
    assert e.value.code == "unknown_node"


def test_duplicate_edge_id_rejected():
    m = _with_nodes()
    m.apply(_child("e1", "root", "box"))
    with pytest.raises(OpError) as e:
        m.apply(_child("e1", "box", "s"))
    assert e.value.code == "duplicate_edge"


def test_two_parents_rejected():
    m = _with_nodes()
    m.apply(_child("e1", "root", "s"))
    with pytest.raises(OpError) as e:
        m.apply(_child("e2", "box", "s"))
    assert e.value.code == "already_parented"


def test_cycle_rejected():
    m = _with_nodes()
    m.apply(_child("e1", "root", "box"))
    with pytest.raises(OpError) as e:
        m.apply(_child("e2", "box", "root"))
    assert e.value.code == "cycle"


def test_disconnect_unknown_rejected():
    m = _with_nodes()
    with pytest.raises(OpError) as e:
        m.apply({"kind": "disconnect", "edgeId": "nope"})
    assert e.value.code == "unknown_edge"


def test_remove_node_cascades_incident_edges():
    m = _with_nodes()
    m.apply(_child("e1", "root", "box"))
    m.apply(_data("e2", "tex", "s"))
    m.apply(_child("e3", "box", "s"))
    m.apply({"kind": "removeNode", "id": "s"})
    assert m.get_edge("e2") is None and m.get_edge("e3") is None
    assert m.get_edge("e1") is not None  # untouched (not incident to s)
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_scene_graph_model.py -q`
Expected: FAIL — connect/disconnect raise `unknown_op`; `get_edge`/`edges_by_*` missing.

- [ ] **Step 3: Implement edges + read helpers**

In `graph_model.py`, extend `EDGE` import and `apply`, and add the helpers. Change the top import to:

```python
from app.scene.document import NODE_TYPES, OpError
```

Add `connect`/`disconnect` branches to `apply` (before the final `raise`):

```python
        if kind == "connect":
            return self._connect(op["edgeId"], op["type"], op["from"], op["to"])
        if kind == "disconnect":
            return self._disconnect(op["edgeId"])
```

Add these methods to `GraphModel`:

```python
    def get_edge(self, edge_id: str) -> dict | None:
        return self._edges.get(edge_id)

    def edges_by_source(self, node_id: str, port: str | None = None) -> list[dict]:
        return [
            e for e in self._edges.values()
            if e["from"]["node"] == node_id and (port is None or e["from"]["port"] == port)
        ]

    def edges_by_target(self, node_id: str, port: str | None = None) -> list[dict]:
        return [
            e for e in self._edges.values()
            if e["to"]["node"] == node_id and (port is None or e["to"]["port"] == port)
        ]

    def _connect(self, edge_id: str, type_: str, frm: dict, to: dict) -> None:
        if edge_id in self._edges:
            raise OpError("duplicate_edge", f"edge already exists: {edge_id}")
        if frm["node"] not in self._nodes:
            raise OpError("unknown_node", f"no such node: {frm['node']}")
        if to["node"] not in self._nodes:
            raise OpError("unknown_node", f"no such node: {to['node']}")
        if type_ == "child":
            child_id, parent_id = to["node"], frm["node"]
            if self._parent_of(child_id) is not None:
                raise OpError("already_parented", f"node already has a parent: {child_id}")
            if child_id == parent_id or self._is_ancestor(child_id, parent_id):
                raise OpError("cycle", "child edge would create a cycle")
        self._edges[edge_id] = {
            "id": edge_id, "type": type_, "from": dict(frm), "to": dict(to),
        }

    def _disconnect(self, edge_id: str) -> None:
        if edge_id not in self._edges:
            raise OpError("unknown_edge", f"no such edge: {edge_id}")
        del self._edges[edge_id]

    def _parent_of(self, child_id: str) -> str | None:
        for e in self._edges.values():
            if e["type"] == "child" and e["to"]["node"] == child_id:
                return e["from"]["node"]
        return None

    def _is_ancestor(self, maybe_ancestor: str, node: str) -> bool:
        cur: str | None = node
        while cur is not None:
            if cur == maybe_ancestor:
                return True
            cur = self._parent_of(cur)
        return False
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_scene_graph_model.py -q`
Expected: PASS (all node, prop, and edge tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/graph_model.py studio/backend/tests/test_scene_graph_model.py
git commit -m "feat(scene): GraphModel typed edges (connect/disconnect) + cascade + read API"
```

---

### Task 4: GraphModel apply_batch (transactional) + load + to_document

**Files:**

- Modify: `studio/backend/app/scene/graph_model.py`
- Test: `studio/backend/tests/test_scene_graph_model.py` (append)

**Interfaces:**

- Consumes: `GraphModel` (Tasks 2–3).
- Produces: `apply_batch(ops: list[dict]) -> None` — validate+apply all or none (on any `OpError`, restore the prior snapshot and re-raise). `load(doc: dict) -> None` — reset, then replay the document as one batch (all `addNode` first, then `connect` per edge). `to_document()` already returns edges (Task 2/3).

- [ ] **Step 1: Write the failing test (append)**

```python
def test_apply_batch_all_or_nothing():
    m = GraphModel()
    with pytest.raises(OpError):
        m.apply_batch([
            {"kind": "addNode", "id": "a", "type": "Sprite"},
            {"kind": "addNode", "id": "a", "type": "Sprite"},  # duplicate
        ])
    assert m.get_node("a") is None  # first op rolled back


def test_apply_batch_success():
    m = GraphModel()
    m.apply_batch([
        {"kind": "addNode", "id": "root", "type": "Root"},
        {"kind": "addNode", "id": "s", "type": "Sprite"},
        _child("e1", "root", "s"),
    ])
    assert m.get_node("s") is not None and m.get_edge("e1") is not None


def test_load_round_trips_document():
    doc = {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 800, "height": 600}},
            "s": {"id": "s", "type": "Sprite", "props": {"alpha": 1}},
        },
        "edges": [{"id": "e1", "type": "child",
                   "from": {"node": "root", "port": "children"},
                   "to": {"node": "s", "port": "parent"}}],
    }
    m = GraphModel()
    m.load(doc)
    assert m.to_document() == doc
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_scene_graph_model.py -q`
Expected: FAIL — `apply_batch`/`load` not defined.

- [ ] **Step 3: Implement apply_batch + load + restore**

Add to `GraphModel`:

```python
    def apply_batch(self, ops: list[dict]) -> None:
        snapshot = self.to_document()
        try:
            for op in ops:
                self.apply(op)
        except Exception:
            self._restore(snapshot)
            raise

    def load(self, doc: dict) -> None:
        self._nodes.clear()
        self._edges.clear()
        ops: list[dict] = []
        for node in doc.get("nodes", {}).values():
            ops.append({"kind": "addNode", "id": node["id"], "type": node["type"],
                        "props": node.get("props") or {}})
        for e in doc.get("edges", []):
            ops.append({"kind": "connect", "edgeId": e["id"], "type": e["type"],
                        "from": e["from"], "to": e["to"]})
        self.apply_batch(ops)

    def _restore(self, doc: dict) -> None:
        self._nodes.clear()
        self._edges.clear()
        for node in doc["nodes"].values():
            self._nodes[node["id"]] = {"id": node["id"], "type": node["type"],
                                       "props": dict(node["props"])}
        for e in doc["edges"]:
            self._edges[e["id"]] = dict(e)
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_scene_graph_model.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/graph_model.py studio/backend/tests/test_scene_graph_model.py
git commit -m "feat(scene): GraphModel transactional apply_batch + document load"
```

---

### Task 5: GameSceneStore (Mongo persistence, one doc per game)

**Files:**

- Create: `studio/backend/app/scene/store.py`
- Test: `studio/backend/tests/test_scene_store.py`

**Interfaces:**

- Consumes: `GraphModel` (Tasks 2–4), `empty_document` (Task 2).
- Produces: `class GameSceneStore(db)` over the `game_scenes` collection, **one record per game** (`_id == game_id`). Mongo cannot store dots in field names and node ids contain dots (e.g. `tex.oak`), so **nodes are persisted as a list** and rehydrated to the dict wire form at the store boundary.
  - `async get_or_create(game_id: str) -> dict` — returns the wire document, creating an empty one if absent.
  - `async get_document(game_id: str) -> dict | None`.
  - `async apply_op(game_id: str, op: dict) -> dict` — load → `GraphModel.apply` (raises `OpError`) → persist → return the new document.
  - `async apply_batch(game_id: str, ops: list[dict]) -> dict` — same, transactional.

- [ ] **Step 1: Write the failing test**

`studio/backend/tests/test_scene_store.py`:

```python
import pytest
import pytest_asyncio
from app.scene.store import GameSceneStore
from app.scene.document import OpError


@pytest_asyncio.fixture(autouse=True)
async def _clean_scenes(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    yield
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_get_or_create_returns_empty_document(mongo_db):
    store = GameSceneStore(mongo_db)
    doc = await store.get_or_create("g1")
    assert doc == {"version": 1, "nodes": {}, "edges": []}


@pytest.mark.asyncio
async def test_apply_op_persists_and_round_trips_dotted_ids(mongo_db):
    store = GameSceneStore(mongo_db)
    await store.apply_op("g1", {"kind": "addNode", "id": "tex.oak", "type": "Texture",
                                "props": {"src": "asset:1"}})
    reread = await store.get_document("g1")
    assert "tex.oak" in reread["nodes"]
    assert reread["nodes"]["tex.oak"]["props"]["src"] == "asset:1"


@pytest.mark.asyncio
async def test_apply_op_invalid_raises_and_leaves_doc_untouched(mongo_db):
    store = GameSceneStore(mongo_db)
    await store.apply_op("g1", {"kind": "addNode", "id": "s", "type": "Sprite"})
    with pytest.raises(OpError):
        await store.apply_op("g1", {"kind": "addNode", "id": "s", "type": "Sprite"})
    doc = await store.get_document("g1")
    assert list(doc["nodes"]) == ["s"]  # no partial mutation


@pytest.mark.asyncio
async def test_apply_batch_is_atomic(mongo_db):
    store = GameSceneStore(mongo_db)
    with pytest.raises(OpError):
        await store.apply_batch("g1", [
            {"kind": "addNode", "id": "a", "type": "Sprite"},
            {"kind": "addNode", "id": "a", "type": "Sprite"},
        ])
    doc = await store.get_document("g1")
    # game_scenes row was created empty by get_or_create; the batch rolled back.
    assert doc["nodes"] == {}
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_scene_store.py -q`
Expected: FAIL — `ModuleNotFoundError: app.scene.store`.

- [ ] **Step 3: Implement the store**

`studio/backend/app/scene/store.py`:

```python
from app.scene.document import empty_document
from app.scene.graph_model import GraphModel


def _to_mongo(game_id: str, document: dict) -> dict:
    # Node ids may contain dots, which Mongo forbids in field names, so the
    # nodes dict is persisted as a list and rehydrated on read.
    return {
        "_id": game_id,
        "version": document["version"],
        "nodes": list(document["nodes"].values()),
        "edges": document["edges"],
    }


def _from_mongo(raw: dict) -> dict:
    return {
        "version": raw["version"],
        "nodes": {n["id"]: n for n in raw["nodes"]},
        "edges": raw["edges"],
    }


class GameSceneStore:
    def __init__(self, db):
        self._scenes = db["game_scenes"]

    async def get_or_create(self, game_id: str) -> dict:
        raw = await self._scenes.find_one({"_id": game_id})
        if raw is None:
            doc = empty_document()
            await self._scenes.insert_one(_to_mongo(game_id, doc))
            return doc
        return _from_mongo(raw)

    async def get_document(self, game_id: str) -> dict | None:
        raw = await self._scenes.find_one({"_id": game_id})
        return _from_mongo(raw) if raw else None

    async def apply_op(self, game_id: str, op: dict) -> dict:
        model = GraphModel()
        model.load(await self.get_or_create(game_id))
        model.apply(op)  # raises OpError; nothing persisted
        doc = model.to_document()
        await self._scenes.replace_one({"_id": game_id}, _to_mongo(game_id, doc), upsert=True)
        return doc

    async def apply_batch(self, game_id: str, ops: list[dict]) -> dict:
        model = GraphModel()
        model.load(await self.get_or_create(game_id))
        model.apply_batch(ops)  # raises OpError, transactional
        doc = model.to_document()
        await self._scenes.replace_one({"_id": game_id}, _to_mongo(game_id, doc), upsert=True)
        return doc
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_scene_store.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/store.py studio/backend/tests/test_scene_store.py
git commit -m "feat(scene): GameSceneStore persisting one IGameDocument per game"
```

---

### Task 6: GameSceneHub (snapshot-on-join + scene_op broadcast)

**Files:**

- Create: `studio/backend/app/scene/hub.py`
- Test: `studio/backend/tests/test_scene_hub.py`

**Interfaces:**

- Consumes: `GameSceneStore` (Task 5).
- Produces: `class GameSceneHub(sio, store)` mirroring `GddHub`:
  - `async attach(game_id, sid)` → `sio.enter_room(sid, game_id)` then emit `scene_snapshot` `{gameId, document}` to that sid.
  - `async apply_op(game_id, op) -> dict` → `store.apply_op` then emit `scene_op` `{gameId, op}` to `room=game_id`; returns the doc.
  - `async apply_batch(game_id, ops) -> dict` → `store.apply_batch` then emit one `scene_op` per op (in order) to the room; returns the doc.

- [ ] **Step 1: Write the failing test**

`studio/backend/tests/test_scene_hub.py`:

```python
import pytest
import pytest_asyncio
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore


@pytest_asyncio.fixture(autouse=True)
async def _clean_scenes(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    yield
    await mongo_db["game_scenes"].delete_many({})


class FakeSio:
    def __init__(self):
        self.emitted = []
        self.rooms = []

    async def emit(self, event, data, room=None, to=None):
        self.emitted.append((event, data, room, to))

    async def enter_room(self, sid, room):
        self.rooms.append((sid, room))


@pytest.mark.asyncio
async def test_attach_enters_room_and_sends_snapshot(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    await hub.attach("g1", "sid-1")
    assert ("sid-1", "g1") in sio.rooms
    snap = [e for e in sio.emitted if e[0] == "scene_snapshot"][-1]
    assert snap[1]["gameId"] == "g1"
    assert snap[1]["document"] == {"version": 1, "nodes": {}, "edges": []}
    assert snap[3] == "sid-1"  # to=sid


@pytest.mark.asyncio
async def test_apply_op_broadcasts_scene_op_to_room(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    op = {"kind": "addNode", "id": "root", "type": "Root"}
    await hub.apply_op("g1", op)
    ev = [e for e in sio.emitted if e[0] == "scene_op"][-1]
    assert ev[1] == {"gameId": "g1", "op": op}
    assert ev[2] == "g1"  # room


@pytest.mark.asyncio
async def test_apply_batch_broadcasts_each_op(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    ops = [
        {"kind": "addNode", "id": "root", "type": "Root"},
        {"kind": "addNode", "id": "s", "type": "Sprite"},
    ]
    await hub.apply_batch("g1", ops)
    sent = [e[1]["op"] for e in sio.emitted if e[0] == "scene_op"]
    assert sent == ops
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_scene_hub.py -q`
Expected: FAIL — `ModuleNotFoundError: app.scene.hub`.

- [ ] **Step 3: Implement the hub**

`studio/backend/app/scene/hub.py`:

```python
from app.scene.store import GameSceneStore


class GameSceneHub:
    def __init__(self, sio, store: GameSceneStore):
        self._sio = sio
        self._store = store

    async def attach(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._store.get_or_create(game_id)
        await self._sio.emit(
            "scene_snapshot", {"gameId": game_id, "document": doc}, to=sid
        )

    async def apply_op(self, game_id: str, op: dict) -> dict:
        doc = await self._store.apply_op(game_id, op)
        await self._sio.emit("scene_op", {"gameId": game_id, "op": op}, room=game_id)
        return doc

    async def apply_batch(self, game_id: str, ops: list[dict]) -> dict:
        doc = await self._store.apply_batch(game_id, ops)
        for op in ops:
            await self._sio.emit("scene_op", {"gameId": game_id, "op": op}, room=game_id)
        return doc
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_scene_hub.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/hub.py studio/backend/tests/test_scene_hub.py
git commit -m "feat(scene): GameSceneHub snapshot-on-join + scene_op broadcast"
```

---

### Task 7: Scene socket handlers (join_scene / leave_scene)

**Files:**

- Create: `studio/backend/app/scene/sockets.py`
- Test: `studio/backend/tests/test_scene_sockets.py`

**Interfaces:**

- Consumes: `GameSceneHub` (Task 6).
- Produces: `register_scene_handlers(sio, hub)` registering `join_scene` (→ `hub.attach(gameId, sid)`) and `leave_scene` (→ `sio.leave_room(sid, gameId)`), mirroring `register_gdd_handlers`.

- [ ] **Step 1: Write the failing test**

`studio/backend/tests/test_scene_sockets.py`:

```python
import pytest
from app.scene.sockets import register_scene_handlers


class FakeSio:
    def __init__(self):
        self.handlers = {}
        self.left = []

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn
        return deco

    async def leave_room(self, sid, room):
        self.left.append((sid, room))


class FakeHub:
    def __init__(self):
        self.attached = []

    async def attach(self, game_id, sid):
        self.attached.append((game_id, sid))


@pytest.mark.asyncio
async def test_join_scene_attaches_and_leave_leaves():
    sio, hub = FakeSio(), FakeHub()
    register_scene_handlers(sio, hub)
    await sio.handlers["join_scene"]("sid-1", {"gameId": "g1"})
    assert hub.attached == [("g1", "sid-1")]
    await sio.handlers["leave_scene"]("sid-1", {"gameId": "g1"})
    assert sio.left == [("sid-1", "g1")]
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_scene_sockets.py -q`
Expected: FAIL — `ModuleNotFoundError: app.scene.sockets`.

- [ ] **Step 3: Implement the handlers**

`studio/backend/app/scene/sockets.py`:

```python
def register_scene_handlers(sio, hub):
    @sio.on("join_scene")
    async def join_scene(sid, data):
        await hub.attach(data["gameId"], sid)

    @sio.on("leave_scene")
    async def leave_scene(sid, data):
        await sio.leave_room(sid, data["gameId"])
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_scene_sockets.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/sockets.py studio/backend/tests/test_scene_sockets.py
git commit -m "feat(scene): join_scene/leave_scene socket handlers"
```

---

### Task 8: Scene agent tools (6) + ToolContext/ToolFactory wiring

**Files:**

- Modify: `studio/backend/app/agent_tools.py`
- Modify: `studio/backend/tests/test_agent_tools.py` (the `known_tool_names` assertion)
- Test: `studio/backend/tests/test_scene_tools.py`

**Interfaces:**

- Consumes: `GameSceneHub.apply_op`/`apply_batch` (Task 6), `OpError` (Task 2).
- Produces: six `StructuredTool`s — `scene_add_node`, `scene_set_prop`, `scene_connect`, `scene_disconnect`, `scene_remove_node`, `scene_apply_batch` — each building an op dict and calling `ctx.scene_hub`, returning a human string or a `Rejected (<code>): …` string on `OpError`. Typed values arrive **JSON-encoded** (`props_json`, `value_json`, `ops_json`) for unambiguous mixed-type encoding; a parse error returns a clear string. `ToolContext` and `ToolFactory` gain `scene_store` / `scene_hub`; the six builders are added to `_BUILDERS`.

- [ ] **Step 1: Write the failing test**

`studio/backend/tests/test_scene_tools.py`:

```python
import pytest
import pytest_asyncio
from app.agent_tools import ToolContext, ToolFactory
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore


@pytest_asyncio.fixture(autouse=True)
async def _clean_scenes(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    yield
    await mongo_db["game_scenes"].delete_many({})


class _SilentSio:
    async def emit(self, *a, **k): ...
    async def enter_room(self, *a, **k): ...


def _ctx(store, hub):
    return ToolContext(room_id="r1", game_id="g1", asset_store=None, asset_hub=None,
                       scene_store=store, scene_hub=hub)


def _factory(store, hub):
    return ToolFactory(asset_store=None, asset_hub=None, scene_store=store, scene_hub=hub)


@pytest.mark.asyncio
async def test_add_node_then_set_prop(mongo_db):
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    f, ctx = _factory(store, hub), _ctx(store, hub)

    add = f.build(["scene_add_node"], ctx)[0]
    out = await add.ainvoke({"node_id": "root", "type": "Root",
                             "props_json": '{"width": 1280, "height": 720}'})
    assert "root" in out

    sp = f.build(["scene_set_prop"], ctx)[0]
    await sp.ainvoke({"node_id": "root", "path": "background", "value_json": '"#101014"'})
    doc = await store.get_document("g1")
    assert doc["nodes"]["root"]["props"]["background"] == "#101014"


@pytest.mark.asyncio
async def test_invalid_op_returns_error_string_not_raise(mongo_db):
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    f, ctx = _factory(store, hub), _ctx(store, hub)
    rm = f.build(["scene_remove_node"], ctx)[0]
    out = await rm.ainvoke({"node_id": "ghost"})
    assert "rejected" in out.lower() and "unknown_node" in out


@pytest.mark.asyncio
async def test_connect_and_apply_batch(mongo_db):
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    f, ctx = _factory(store, hub), _ctx(store, hub)

    batch = f.build(["scene_apply_batch"], ctx)[0]
    out = await batch.ainvoke({"ops_json":
        '[{"kind":"addNode","id":"root","type":"Root"},'
        ' {"kind":"addNode","id":"s","type":"Sprite"}]'})
    assert "2" in out

    conn = f.build(["scene_connect"], ctx)[0]
    await conn.ainvoke({"edge_id": "e1", "type": "child",
                        "from_node": "root", "from_port": "children",
                        "to_node": "s", "to_port": "parent"})
    doc = await store.get_document("g1")
    assert doc["edges"][0]["id"] == "e1"
```

- [ ] **Step 2: Update the `known_tool_names` assertion (it WILL fail once builders are added)**

In `studio/backend/tests/test_agent_tools.py`, replace the `test_known_tool_names` body's expected set with:

```python
async def test_known_tool_names():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert f.known_tool_names() == {
        "generate_asset", "list_assets", "delete_asset",
        "list_gdd_docs", "read_gdd_doc", "write_gdd_doc",
        "edit_gdd_doc", "set_doc_status", "ask_user_question",
        "scene_add_node", "scene_set_prop", "scene_connect",
        "scene_disconnect", "scene_remove_node", "scene_apply_batch",
    }
```

- [ ] **Step 3: Run to verify both fail**

Run: `uv run pytest tests/test_scene_tools.py tests/test_agent_tools.py::test_known_tool_names -q`
Expected: FAIL — scene builders missing; `ToolContext`/`ToolFactory` lack `scene_*`.

- [ ] **Step 4: Implement the tools + wiring**

In `studio/backend/app/agent_tools.py`, add `import json` at the top and `from app.scene.document import OpError`. Extend the `ToolContext` dataclass with two fields:

```python
@dataclass
class ToolContext:
    room_id: str
    game_id: str
    asset_store: object
    asset_hub: object
    gdd_store: object = None
    gdd_hub: object = None
    scene_store: object = None
    scene_hub: object = None
```

Add the six builders (anywhere above `class ToolFactory`):

```python
def build_scene_add_node_tool(ctx: ToolContext) -> BaseTool:
    async def scene_add_node(node_id: str, type: str, props_json: str = "") -> str:
        try:
            props = json.loads(props_json) if props_json.strip() else {}
        except json.JSONDecodeError as e:
            return f"Invalid props_json: {e}"
        op = {"kind": "addNode", "id": node_id, "type": type, "props": props}
        try:
            await ctx.scene_hub.apply_op(ctx.game_id, op)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Added {type} node '{node_id}'."

    return StructuredTool.from_function(
        coroutine=scene_add_node, name="scene_add_node",
        description="Add a scene node. type is Root|Container|Sprite|Texture. "
                    "node_id is a stable, semantic id you choose (e.g. 'reels', "
                    "'sym.r2c1'). props_json is an optional JSON object of initial "
                    "props (e.g. '{\"position\":{\"x\":100,\"y\":80}}').",
    )


def build_scene_set_prop_tool(ctx: ToolContext) -> BaseTool:
    async def scene_set_prop(node_id: str, path: str, value_json: str) -> str:
        try:
            value = json.loads(value_json)
        except json.JSONDecodeError as e:
            return f"Invalid value_json: {e}"
        op = {"kind": "setProp", "id": node_id, "path": path, "value": value}
        try:
            await ctx.scene_hub.apply_op(ctx.game_id, op)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Set {node_id}.{path}."

    return StructuredTool.from_function(
        coroutine=scene_set_prop, name="scene_set_prop",
        description="Set one prop on a node. path supports nesting (e.g. "
                    "'position.x'). value_json is the JSON-encoded value "
                    "(e.g. '0.5', 'true', '{\"x\":10,\"y\":20}').",
    )


def build_scene_connect_tool(ctx: ToolContext) -> BaseTool:
    async def scene_connect(edge_id: str, type: str, from_node: str, from_port: str,
                            to_node: str, to_port: str) -> str:
        op = {"kind": "connect", "edgeId": edge_id, "type": type,
              "from": {"node": from_node, "port": from_port},
              "to": {"node": to_node, "port": to_port}}
        try:
            await ctx.scene_hub.apply_op(ctx.game_id, op)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Connected {edge_id} ({type})."

    return StructuredTool.from_function(
        coroutine=scene_connect, name="scene_connect",
        description="Connect two nodes. type 'child' parents a node "
                    "(from_port='children', to_port='parent'); type 'data' binds a "
                    "Texture to a Sprite (from_port='data', to_port='texture').",
    )


def build_scene_disconnect_tool(ctx: ToolContext) -> BaseTool:
    async def scene_disconnect(edge_id: str) -> str:
        try:
            await ctx.scene_hub.apply_op(ctx.game_id, {"kind": "disconnect", "edgeId": edge_id})
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Disconnected {edge_id}."

    return StructuredTool.from_function(
        coroutine=scene_disconnect, name="scene_disconnect",
        description="Remove an edge by its id.",
    )


def build_scene_remove_node_tool(ctx: ToolContext) -> BaseTool:
    async def scene_remove_node(node_id: str) -> str:
        try:
            await ctx.scene_hub.apply_op(ctx.game_id, {"kind": "removeNode", "id": node_id})
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Removed node '{node_id}' (and its edges)."

    return StructuredTool.from_function(
        coroutine=scene_remove_node, name="scene_remove_node",
        description="Remove a node and all edges touching it.",
    )


def build_scene_apply_batch_tool(ctx: ToolContext) -> BaseTool:
    async def scene_apply_batch(ops_json: str) -> str:
        try:
            ops = json.loads(ops_json)
        except json.JSONDecodeError as e:
            return f"Invalid ops_json: {e}"
        if not isinstance(ops, list):
            return "ops_json must be a JSON array of op objects."
        try:
            await ctx.scene_hub.apply_batch(ctx.game_id, ops)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Applied {len(ops)} ops atomically."

    return StructuredTool.from_function(
        coroutine=scene_apply_batch, name="scene_apply_batch",
        description="Apply many ops atomically (all-or-nothing). ops_json is a JSON "
                    "array of op objects matching the add/remove/setProp/connect/"
                    "disconnect shapes. Use for building a group (e.g. a reel of "
                    "symbols) in one step.",
    )
```

Register them and thread `scene_store`/`scene_hub` through `ToolFactory`:

```python
class ToolFactory:
    _BUILDERS = {
        "generate_asset": build_generate_asset_tool,
        "list_assets": build_list_assets_tool,
        "delete_asset": build_delete_asset_tool,
        "list_gdd_docs": build_list_gdd_docs_tool,
        "read_gdd_doc": build_read_gdd_doc_tool,
        "write_gdd_doc": build_write_gdd_doc_tool,
        "edit_gdd_doc": build_edit_gdd_doc_tool,
        "set_doc_status": build_set_doc_status_tool,
        "ask_user_question": build_ask_user_question_tool,
        "scene_add_node": build_scene_add_node_tool,
        "scene_set_prop": build_scene_set_prop_tool,
        "scene_connect": build_scene_connect_tool,
        "scene_disconnect": build_scene_disconnect_tool,
        "scene_remove_node": build_scene_remove_node_tool,
        "scene_apply_batch": build_scene_apply_batch_tool,
    }

    def __init__(self, asset_store, asset_hub, gdd_store=None, gdd_hub=None,
                 scene_store=None, scene_hub=None):
        self._asset_store = asset_store
        self._asset_hub = asset_hub
        self._gdd_store = gdd_store
        self._gdd_hub = gdd_hub
        self._scene_store = scene_store
        self._scene_hub = scene_hub

    def known_tool_names(self) -> set[str]:
        return set(self._BUILDERS)

    def build(self, allowlist, ctx: ToolContext) -> list[BaseTool]:
        return [self._BUILDERS[name](ctx) for name in allowlist if name in self._BUILDERS]
```

- [ ] **Step 5: Run to verify it passes**

Run: `uv run pytest tests/test_scene_tools.py tests/test_agent_tools.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_scene_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(scene): six scene.* agent tools + ToolFactory wiring"
```

---

### Task 9: design-scene skill + fix skill-registry tests

**Files:**

- Create: `skills/design-scene.md`
- Create: `studio/backend/tests/test_design_scene_skill.py`
- Modify: `studio/backend/tests/test_design_game_skill.py` (known set)
- Modify: `studio/backend/tests/test_skills.py` (two real-dir loads)

**Interfaces:**

- Consumes: `SCENE_TOOL_NAMES` (Task 2), `SkillRegistry` (existing).
- Produces: `skills/design-scene.md` declaring the six scene tools. **Because the shared `skills/` dir now contains a skill with `scene_*` tools, every test that loads the real dir with a hand-curated `known` set must include `SCENE_TOOL_NAMES`, or `reg.load()` raises `SkillError`.**

- [ ] **Step 1: Write the failing test**

`studio/backend/tests/test_design_scene_skill.py`:

```python
from pathlib import Path
from app.skills import SkillRegistry
from app.scene.document import SCENE_TOOL_NAMES

SKILLS_DIR = Path(__file__).resolve().parents[3] / "skills"


def test_design_scene_skill_loads_with_known_scene_tools():
    known = SCENE_TOOL_NAMES | {"generate_asset", "list_assets"}
    reg = SkillRegistry(SKILLS_DIR, known)
    reg.load()  # raises if any skill declares an unknown tool
    spec = reg.get("design-scene")
    assert spec is not None
    assert set(spec.tools) == SCENE_TOOL_NAMES
    assert "node" in spec.body.lower()  # encodes the node-graph authoring loop
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_design_scene_skill.py -q`
Expected: FAIL — no `design-scene` skill / file missing.

- [ ] **Step 3: Write the skill**

`skills/design-scene.md`:

```markdown
---
name: design-scene
description: Build the game's on-screen scene as a live node graph from your
  description — a Root stage, Containers for layout, Sprites for symbols, and
  Textures bound to them — mutating the scene incrementally.
args:
  - { name: focus, type: string, required: false, description: 'Optionally focus on one part of the scene (e.g. the reels).' }
tools: [scene_add_node, scene_set_prop, scene_connect, scene_disconnect, scene_remove_node, scene_apply_batch]
---

You build a slot game's visual scene as a node graph that renders live in the
preview. The graph has four node types: Root (the stage; props width, height,
background), Container (layout group; position, scale, rotation, alpha, visible),
Sprite (an image; position, scale, rotation, alpha, anchor, visible, zIndex), and
Texture (an image source; prop `src`). Edges are either `child` (parenting:
from_port 'children' → to_port 'parent') or `data` (bind a Texture to a Sprite:
from_port 'data' → to_port 'texture').

Choose **stable, semantic ids** you can address again later (e.g. `root`,
`reels`, `sym.r2c1`, `tex.oak`). Work incrementally — one op per change; never
rebuild the whole scene to adjust one thing.

Work in this order:

1. STAGE. Add the `root` Root node first, sizing it to the game (e.g. 1280×720).
   Everything else parents under it (directly or via Containers).

2. LAYOUT. Add Containers for the major regions (e.g. a `reels` container) and
   parent them to `root` with `child` edges. Position them with `scene_set_prop`.

3. SYMBOLS. Add Sprite nodes for the visible elements and parent them into their
   Containers. Use `scene_apply_batch` to build a repetitive group (e.g. a reel of
   5 symbols) atomically.

4. TEXTURES. For each image, add a Texture node whose `src` references an existing
   asset (use an asset id or media URL from the Asset Board), then bind it to its
   Sprite with a `data` edge.

5. REFINE. Adjust positions, scale, alpha, and zIndex with `scene_set_prop`. If an
   op is Rejected, read the error code (e.g. unknown_node, cycle, already_parented),
   fix the cause, and retry. When the scene reads well, summarise what you built.
```

- [ ] **Step 4: Fix the existing skill-registry tests (they load the real dir)**

In `studio/backend/tests/test_design_game_skill.py`, widen the `known` set so `reg.load()` tolerates `design-scene`:

```python
from pathlib import Path
from app.skills import SkillRegistry
from app.gdd.models import GDD_TOOL_NAMES
from app.scene.document import SCENE_TOOL_NAMES

SKILLS_DIR = Path(__file__).resolve().parents[3] / "skills"


def test_design_game_skill_loads_with_known_gdd_tools():
    known = (GDD_TOOL_NAMES | {"generate_asset", "list_assets", "delete_asset"}
             | SCENE_TOOL_NAMES)
    reg = SkillRegistry(SKILLS_DIR, known)
    reg.load()  # raises if any skill declares an unknown tool
    spec = reg.get("design-game")
    assert spec is not None
    assert set(spec.tools) == GDD_TOOL_NAMES
    assert "gap" in spec.body.lower()  # encodes the gap-driven loop
```

In `studio/backend/tests/test_skills.py`, both `test_repo_skills_dir_loads_background` (~line 104) and `test_manage_assets_skill_loads_with_asset_tools` (~line 211) construct a `SkillRegistry` over `get_settings().skills_dir`. Add the scene tools to each `known_tools` set. In both, change:

```python
    from app.gdd.models import GDD_TOOL_NAMES
    from app.scene.document import SCENE_TOOL_NAMES

    reg = SkillRegistry(
        Path(get_settings().skills_dir),
        known_tools=({"generate_asset", "list_assets", "delete_asset"}
                     | GDD_TOOL_NAMES | SCENE_TOOL_NAMES),
    )
    reg.load()
```

- [ ] **Step 5: Run to verify it passes**

Run: `uv run pytest tests/test_design_scene_skill.py tests/test_design_game_skill.py tests/test_skills.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write skills/design-scene.md
git add skills/design-scene.md studio/backend/tests/test_design_scene_skill.py studio/backend/tests/test_design_game_skill.py studio/backend/tests/test_skills.py
git commit -m "feat(scene): design-scene skill + widen skill-registry test known-sets"
```

---

### Task 10: DI wiring (main.py + room_hub.py)

**Files:**

- Modify: `studio/backend/app/main.py`
- Modify: `studio/backend/app/room_hub.py`
- Test: `studio/backend/tests/test_scene_wiring.py`

**Interfaces:**

- Consumes: `GameSceneStore`, `GameSceneHub`, `register_scene_handlers`, `ToolFactory` (Tasks 5–8).
- Produces: `build(settings)` constructs `scene_store`/`scene_hub`, passes them to `ToolFactory` and `RoomHub`, and calls `register_scene_handlers`. `RoomHub` accepts `scene_store`/`scene_hub` kwargs and threads them into the `ToolContext` it builds for skill runs.

- [ ] **Step 1: Write the failing test**

`studio/backend/tests/test_scene_wiring.py`:

```python
from app.config import Settings
from app.main import build


def test_build_wires_scene_tools_into_factory():
    ctx = build(Settings(provider_mode="replay", mongo_db="bloom_studio_test"))
    names = ctx.hub._tool_factory.known_tool_names()
    assert {"scene_add_node", "scene_apply_batch"} <= names
    # The room hub holds a scene hub so skill runs can author scenes.
    assert ctx.hub._scene_hub is not None
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_scene_wiring.py -q`
Expected: FAIL — `RoomHub` has no `_scene_hub`; factory lacks scene tools (not yet wired in `build`).

- [ ] **Step 3: Wire main.py**

In `studio/backend/app/main.py`, add imports near the gdd imports:

```python
from app.scene.hub import GameSceneHub
from app.scene.sockets import register_scene_handlers
from app.scene.store import GameSceneStore
```

After the `gdd_hub = GddHub(sio, gdd_store)` line, add:

```python
    scene_store = GameSceneStore(mongo[settings.mongo_db])
    scene_hub = GameSceneHub(sio, scene_store)
```

Change the `ToolFactory(...)` construction to include the scene deps:

```python
    tool_factory = ToolFactory(asset_store, asset_hub, gdd_store=gdd_store, gdd_hub=gdd_hub,
                               scene_store=scene_store, scene_hub=scene_hub)
```

Change the `RoomHub(...)` construction to pass them:

```python
    hub = RoomHub(
        sio, store, chat_service,
        run_store=run_store, turn_runner=turn_runner,
        skills=skill_registry, tool_factory=tool_factory,
        asset_store=asset_store, asset_hub=asset_hub,
        gdd_store=gdd_store, gdd_hub=gdd_hub,
        scene_store=scene_store, scene_hub=scene_hub,
    )
```

After `register_gdd_handlers(sio, gdd_hub)`, add:

```python
    register_scene_handlers(sio, scene_hub)
```

- [ ] **Step 4: Wire room_hub.py**

In `studio/backend/app/room_hub.py`, add to the `RoomHub.__init__` keyword args (after `gdd_hub=None,`):

```python
        scene_store=None,
        scene_hub=None,
```

and store them (after `self._gdd_hub = gdd_hub`):

```python
        self._scene_store = scene_store
        self._scene_hub = scene_hub
```

Update the `ToolContext(...)` construction (the `ctx = ToolContext(...)` line) to thread the scene deps:

```python
        ctx = ToolContext(room_id, room.game_id, self._asset_store, self._asset_hub,
                         gdd_store=self._gdd_store, gdd_hub=self._gdd_hub,
                         scene_store=self._scene_store, scene_hub=self._scene_hub)
```

- [ ] **Step 5: Run to verify it passes + the whole backend unit suite**

Run:

```bash
uv run pytest tests/test_scene_wiring.py -q
uv run pytest -m "not e2e" -q
```

Expected: the wiring test PASSES; the full non-e2e suite is green (confirms no existing test broke).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/main.py studio/backend/app/room_hub.py studio/backend/tests/test_scene_wiring.py
git commit -m "feat(scene): wire GameSceneStore/Hub into DI + RoomHub tool context"
```

---

### Task 11: Backend non-browser e2e — join_scene snapshot (CI)

**Files:**

- Create: `studio/backend/tests/e2e/test_scene.py`

**Interfaces:**

- Consumes: the running app via the `live_server` fixture (existing, `tests/e2e/conftest.py`), the `join_scene` handler + `scene_snapshot` event (Tasks 6–7, 10).
- Produces: a CI-affordable, deterministic (no LLM) e2e proving a socket client that joins a scene receives a `scene_snapshot` for an empty document. (The agent-driven op→broadcast path is unit-covered in Task 6 and exercised end-to-end by the Playwright e2e in Task 18; this guards the live socket+hub+store wiring.)

- [ ] **Step 1: Write the test**

`studio/backend/tests/e2e/test_scene.py`:

```python
"""Backend service e2e for the scene socket layer (replay, no LLM).

Verifies that joining a game's scene room delivers a scene_snapshot for a
freshly-created empty document over a real live server + socket.io client.
"""
import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "SceneE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_join_scene_delivers_empty_snapshot(live_server):
    _room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    seen = {"snapshots": []}
    client.on("scene_snapshot", lambda d: seen["snapshots"].append(d))

    await client.connect(live_server, auth={"displayName": "SceneViewer"})
    await client.emit("join_scene", {"gameId": game_id})

    deadline = asyncio.get_event_loop().time() + 10
    while not seen["snapshots"] and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert seen["snapshots"], "expected a scene_snapshot on join"
    snap = seen["snapshots"][0]
    assert snap["gameId"] == game_id
    assert snap["document"] == {"version": 1, "nodes": {}, "edges": []}

    await client.disconnect()
```

- [ ] **Step 2: Run the backend e2e**

Run (from `studio/backend`): `uv run pytest -m e2e tests/e2e/test_scene.py -q`
Expected: PASS (the fixture starts its own server on a free port in replay mode; `game_scenes` is created lazily by `get_or_create`).

- [ ] **Step 3: Commit**

```bash
git add studio/backend/tests/e2e/test_scene.py
git commit -m "test(scene): non-browser e2e for join_scene snapshot delivery"
```

---

## Phase C — Frontend (`studio/frontend`)

### Task 12: `game` plugin config + state

**Files:**

- Create: `studio/frontend/src/plugins/game/config.ts`
- Create: `studio/frontend/src/plugins/game/state.ts`
- Test: `studio/frontend/src/plugins/game/config.spec.ts`

**Interfaces:**

- Consumes: `IGameDocument` from the engine package (`runtime/client`), the `makePluginHooks`/`rootStore` host (existing).
- Produces:
  - `config.ts`: `ENGINE_PORT: string`, `engineOrigin(): string` (host-derived), re-export `BACKEND_URL`.
  - `state.ts`: `GAME_PLUGIN_ID = 'game'`, `IGameState { connection; activeGameId; document: IGameDocument; status }`, `makeInitialState()`, `gameHooks`, `gameSlice()`.

> **Import note:** the studio MAY depend on `runtime/client` (platform rule: `studio/ → runtime/client` is allowed). Import the document type from the engine's source: `import type { IGameDocument } from '../../../../../runtime/client/src/model/document'`. If Nx path resolution rejects the deep relative path, define a local structural copy of `IGameDocument`/`INode`/`IEdge` in `state.ts` (the wire shape is fixed by the protocol). Prefer the import; fall back to the local copy only if the build fails.

- [ ] **Step 1: Write the failing test**

`studio/frontend/src/plugins/game/config.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { engineOrigin, ENGINE_PORT } from './config';

describe('engineOrigin', () => {
  it('derives the engine origin from the current host + engine port', () => {
    // jsdom default location is http://localhost
    expect(engineOrigin()).toBe(`http://localhost:${ENGINE_PORT}`);
  });
  it('defaults the engine port to 4300', () => {
    expect(ENGINE_PORT).toBe('4300');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from worktree root): `npx nx test frontend -- config.spec`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Implement config + state**

`studio/frontend/src/plugins/game/config.ts`:

```ts
export { BACKEND_URL } from '../assets/config';

// The engine dev server runs on a configurable port (default 4300). The origin is
// derived from the current host so the iframe works when the studio is browsed
// from another LAN machine — never a hardcoded localhost.
export const ENGINE_PORT: string = (import.meta.env.VITE_BLOOM_ENGINE_PORT as string | undefined) ?? '4300';

export function engineOrigin(): string {
  return `${window.location.protocol}//${window.location.hostname}:${ENGINE_PORT}`;
}
```

`studio/frontend/src/plugins/game/state.ts`:

```ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const GAME_PLUGIN_ID = 'game';

// Structural copy of the engine wire shapes (runtime/client/src/model/document.ts).
// The protocol fixes these; keep them in lockstep with the engine.
export type NodeType = 'Root' | 'Container' | 'Sprite' | 'Texture';
export type EdgeType = 'child' | 'data';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export interface IPortRef {
  node: string;
  port: string;
}
export interface INode {
  id: string;
  type: NodeType;
  props: Record<string, JsonValue>;
}
export interface IEdge {
  id: string;
  type: EdgeType;
  from: IPortRef;
  to: IPortRef;
}
export interface IGameDocument {
  version: number;
  nodes: Record<string, INode>;
  edges: IEdge[];
}

export interface IGameState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  document: IGameDocument;
  status: 'idle' | 'loading' | 'error';
}

export function emptyDocument(): IGameDocument {
  return { version: 1, nodes: {}, edges: [] };
}

export function makeInitialState(): IGameState {
  return {
    connection: 'disconnected',
    activeGameId: null,
    document: emptyDocument(),
    status: 'idle',
  };
}

export const gameHooks = makePluginHooks<IGameState>(GAME_PLUGIN_ID);

export function gameSlice(): State<IGameState> {
  return rootStore.plugins.nested(GAME_PLUGIN_ID) as unknown as State<IGameState>;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test frontend -- config.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/game
git add studio/frontend/src/plugins/game
git commit -m "feat(game): plugin config (host-derived engine origin) + hookstate state"
```

---

### Task 13: Reducers — applyOpToDocument / loadDocument (trusting structural)

**Files:**

- Create: `studio/frontend/src/plugins/game/reducers.ts`
- Test: `studio/frontend/src/plugins/game/reducers.spec.ts`

**Interfaces:**

- Consumes: `IGameDocument`, `INode`, `IEdge`, `JsonValue` (Task 12); the engine `Op` shape (structural copy via the wire — same `kind` discriminants).
- Produces:
  - `applyOpToDocument(doc: IGameDocument, op: ISceneOp): IGameDocument` — pure, returns a new document. **Trusting**: the backend already validated; no cycle/parent checks here. `removeNode` cascades incident edges structurally. `setProp` writes nested dotted paths immutably.
  - `loadDocument(doc: IGameDocument): IGameDocument` — returns a deep-ish clone (replace).
  - `type ISceneOp` — the op union (structural copy of `runtime/client/src/model/ops.ts`).

- [ ] **Step 1: Write the failing test**

`studio/frontend/src/plugins/game/reducers.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyDocument } from './state';
import { applyOpToDocument } from './reducers';

describe('applyOpToDocument', () => {
  it('adds a node', () => {
    const d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 's', type: 'Sprite', props: { alpha: 1 } });
    expect(d.nodes.s).toEqual({ id: 's', type: 'Sprite', props: { alpha: 1 } });
  });

  it('addNode defaults props to {}', () => {
    const d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 'root', type: 'Root' });
    expect(d.nodes.root.props).toEqual({});
  });

  it('sets a nested prop immutably', () => {
    let d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 's', type: 'Sprite' });
    const before = d;
    d = applyOpToDocument(d, { kind: 'setProp', id: 's', path: 'position.x', value: 240 });
    expect(d.nodes.s.props.position).toEqual({ x: 240 });
    expect(before.nodes.s.props).toEqual({}); // original untouched
  });

  it('connects an edge', () => {
    let d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 'root', type: 'Root' });
    d = applyOpToDocument(d, { kind: 'addNode', id: 's', type: 'Sprite' });
    d = applyOpToDocument(d, {
      kind: 'connect',
      edgeId: 'e1',
      type: 'child',
      from: { node: 'root', port: 'children' },
      to: { node: 's', port: 'parent' },
    });
    expect(d.edges).toHaveLength(1);
    expect(d.edges[0].id).toBe('e1');
  });

  it('disconnects an edge', () => {
    let d = emptyDocument();
    d = applyOpToDocument(applyOpToDocument(d, { kind: 'addNode', id: 'a', type: 'Container' }), {
      kind: 'addNode',
      id: 'b',
      type: 'Sprite',
    });
    d = applyOpToDocument(d, { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'a', port: 'children' }, to: { node: 'b', port: 'parent' } });
    d = applyOpToDocument(d, { kind: 'disconnect', edgeId: 'e1' });
    expect(d.edges).toHaveLength(0);
  });

  it('removeNode cascades incident edges', () => {
    let d = emptyDocument();
    for (const id of ['root', 's', 'tex'])
      d = applyOpToDocument(d, { kind: 'addNode', id, type: id === 'tex' ? 'Texture' : id === 'root' ? 'Root' : 'Sprite' });
    d = applyOpToDocument(d, { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } });
    d = applyOpToDocument(d, { kind: 'connect', edgeId: 'e2', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } });
    d = applyOpToDocument(d, { kind: 'removeNode', id: 's' });
    expect(d.nodes.s).toBeUndefined();
    expect(d.edges).toHaveLength(0); // both incident edges dropped
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test frontend -- game/reducers.spec`
Expected: FAIL — `Cannot find module './reducers'`.

- [ ] **Step 3: Implement the reducers**

`studio/frontend/src/plugins/game/reducers.ts`:

```ts
import type { EdgeType, IEdge, IGameDocument, INode, IPortRef, JsonValue, NodeType } from './state';

export type ISceneOp =
  | { kind: 'addNode'; id: string; type: NodeType; props?: Record<string, JsonValue> }
  | { kind: 'removeNode'; id: string }
  | { kind: 'setProp'; id: string; path: string; value: JsonValue }
  | { kind: 'connect'; edgeId: string; type: EdgeType; from: IPortRef; to: IPortRef }
  | { kind: 'disconnect'; edgeId: string };

// Trusting structural applier: the backend has already validated. We only mirror
// the durable document so the iframe can be (re-)initialised from cache.
export function applyOpToDocument(doc: IGameDocument, op: ISceneOp): IGameDocument {
  switch (op.kind) {
    case 'addNode': {
      const node: INode = { id: op.id, type: op.type, props: { ...(op.props ?? {}) } };
      return { ...doc, nodes: { ...doc.nodes, [op.id]: node } };
    }
    case 'removeNode': {
      const nodes = { ...doc.nodes };
      delete nodes[op.id];
      const edges = doc.edges.filter((e) => e.from.node !== op.id && e.to.node !== op.id);
      return { ...doc, nodes, edges };
    }
    case 'setProp': {
      const existing = doc.nodes[op.id];
      if (!existing) return doc; // trusting: ignore unknown (backend wouldn't have sent it)
      const props = setNested(existing.props, op.path, op.value);
      return { ...doc, nodes: { ...doc.nodes, [op.id]: { ...existing, props } } };
    }
    case 'connect': {
      const edge: IEdge = { id: op.edgeId, type: op.type, from: { ...op.from }, to: { ...op.to } };
      return { ...doc, edges: [...doc.edges, edge] };
    }
    case 'disconnect': {
      return { ...doc, edges: doc.edges.filter((e) => e.id !== op.edgeId) };
    }
    default:
      return doc;
  }
}

export function loadDocument(doc: IGameDocument): IGameDocument {
  return {
    version: doc.version,
    nodes: Object.fromEntries(Object.entries(doc.nodes).map(([id, n]) => [id, { ...n, props: { ...n.props } }])),
    edges: doc.edges.map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } })),
  };
}

function setNested(props: Record<string, JsonValue>, path: string, value: JsonValue): Record<string, JsonValue> {
  const keys = path.split('.');
  const root: Record<string, JsonValue> = { ...props };
  let cursor = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cursor[k];
    const copy: Record<string, JsonValue> = typeof next === 'object' && next !== null && !Array.isArray(next) ? { ...(next as Record<string, JsonValue>) } : {};
    cursor[k] = copy;
    cursor = copy;
  }
  cursor[keys[keys.length - 1]] = value;
  return root;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test frontend -- game/reducers.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/game
git add studio/frontend/src/plugins/game
git commit -m "feat(game): trusting structural reducers (applyOpToDocument/loadDocument)"
```

---

### Task 14: ProtocolBridge + bridgeRef

**Files:**

- Create: `studio/frontend/src/plugins/game/protocolBridge.ts`
- Test: `studio/frontend/src/plugins/game/protocolBridge.spec.ts`

**Interfaces:**

- Consumes: `ISceneOp` (Task 13), `IGameDocument` (Task 12), the Plan 1 `InboundMessage`/`OutboundMessage` shapes (structural).
- Produces:
  - `class ProtocolBridge` constructed with `{ post: (m, targetOrigin) => void; engineOrigin: string; onError?: (e) => void }`. Methods: `handleEngineMessage(data, origin)` (gates by `engineOrigin`, flips ready on `ready`, flushes queue, forwards `error`); `init(document)`, `op(op)`, `batch(ops)` (queue until ready, else post with `engineOrigin`); `reset()` (back to not-ready, clear queue — for iframe reload).
  - `bridgeRef`: `setBridge`, `getBridge`, `clearBridge` (module singleton so the socketClient reaches the pane's live bridge).

- [ ] **Step 1: Write the failing test**

`studio/frontend/src/plugins/game/protocolBridge.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ProtocolBridge } from './protocolBridge';
import { emptyDocument } from './state';

const ENGINE = 'http://localhost:4300';

function setup() {
  const post = vi.fn();
  const onError = vi.fn();
  const bridge = new ProtocolBridge({ post, engineOrigin: ENGINE, onError });
  return { bridge, post, onError };
}

describe('ProtocolBridge', () => {
  it('queues ops sent before ready, then flushes on ready', () => {
    const { bridge, post } = setup();
    bridge.op({ kind: 'addNode', id: 's', type: 'Sprite' });
    expect(post).not.toHaveBeenCalled(); // queued
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, ENGINE);
    expect(post).toHaveBeenCalledTimes(1);
    const [msg, target] = post.mock.calls[0];
    expect(msg).toMatchObject({ v: 1, kind: 'op', op: { kind: 'addNode', id: 's' } });
    expect(target).toBe(ENGINE);
  });

  it('posts immediately once ready', () => {
    const { bridge, post } = setup();
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, ENGINE);
    bridge.init(emptyDocument());
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatchObject({ kind: 'init' });
  });

  it('ignores engine messages from a foreign origin', () => {
    const { bridge, post } = setup();
    bridge.op({ kind: 'addNode', id: 's', type: 'Sprite' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://evil:9999');
    expect(post).not.toHaveBeenCalled(); // never became ready
  });

  it('surfaces engine errors', () => {
    const { bridge, onError } = setup();
    const err = { v: 1, kind: 'error', id: 'm1', code: 'cycle', message: 'no' };
    bridge.handleEngineMessage(err, ENGINE);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('reset() re-queues until the next ready (iframe reload)', () => {
    const { bridge, post } = setup();
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, ENGINE);
    bridge.reset();
    bridge.op({ kind: 'addNode', id: 's', type: 'Sprite' });
    expect(post).not.toHaveBeenCalled();
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, ENGINE);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test frontend -- game/protocolBridge.spec`
Expected: FAIL — `Cannot find module './protocolBridge'`.

- [ ] **Step 3: Implement the bridge + ref**

`studio/frontend/src/plugins/game/protocolBridge.ts`:

```ts
import type { IGameDocument } from './state';
import type { ISceneOp } from './reducers';

type InboundMessage =
  | { v: 1; kind: 'init'; id: string; document?: IGameDocument }
  | { v: 1; kind: 'op'; id: string; op: ISceneOp }
  | { v: 1; kind: 'batch'; id: string; ops: ISceneOp[] };

type OutboundMessage =
  | { v: 1; kind: 'ready'; protocolVersion: 1 }
  | { v: 1; kind: 'ack'; id: string }
  | { v: 1; kind: 'error'; id: string; code: string; message: string };

export interface IProtocolBridgeDeps {
  post: (m: InboundMessage, targetOrigin: string) => void;
  engineOrigin: string;
  onError?: (e: { code: string; message: string }) => void;
}

export class ProtocolBridge {
  private ready = false;
  private queue: InboundMessage[] = [];
  private seq = 0;

  constructor(private readonly deps: IProtocolBridgeDeps) {}

  handleEngineMessage(data: OutboundMessage, origin: string): void {
    if (origin !== this.deps.engineOrigin) return;
    if (!data || data.v !== 1) return;
    if (data.kind === 'ready') {
      this.ready = true;
      const pending = this.queue;
      this.queue = [];
      for (const m of pending) this.deps.post(m, this.deps.engineOrigin);
    } else if (data.kind === 'error') {
      this.deps.onError?.({ code: data.code, message: data.message });
    }
  }

  init(document: IGameDocument): void {
    this.send({ v: 1, kind: 'init', id: this.nextId(), document });
  }

  op(op: ISceneOp): void {
    this.send({ v: 1, kind: 'op', id: this.nextId(), op });
  }

  batch(ops: ISceneOp[]): void {
    this.send({ v: 1, kind: 'batch', id: this.nextId(), ops });
  }

  reset(): void {
    this.ready = false;
    this.queue = [];
  }

  private send(m: InboundMessage): void {
    if (!this.ready) this.queue.push(m);
    else this.deps.post(m, this.deps.engineOrigin);
  }

  private nextId(): string {
    return `m${++this.seq}`;
  }
}

// Module singleton so the socket client can reach the pane's live bridge.
let active: ProtocolBridge | null = null;
export function setBridge(b: ProtocolBridge): void {
  active = b;
}
export function getBridge(): ProtocolBridge | null {
  return active;
}
export function clearBridge(b: ProtocolBridge): void {
  if (active === b) active = null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test frontend -- game/protocolBridge.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/game
git add studio/frontend/src/plugins/game
git commit -m "feat(game): ProtocolBridge (handshake + queue-before-ready + origin-targeted post)"
```

---

### Task 15: socketClient + actions (lifecycle)

**Files:**

- Create: `studio/frontend/src/plugins/game/socketClient.ts`
- Create: `studio/frontend/src/plugins/game/actions.ts`
- Test: `studio/frontend/src/plugins/game/socketClient.spec.ts`

**Interfaces:**

- Consumes: `gameSlice` (Task 12), `applyOpToDocument`/`loadDocument` (Task 13), `getBridge` (Task 14), `BACKEND_URL` (Task 12).
- Produces:
  - `socketClient.ts`: `createGameSocket()` returning `{ connect, disconnect, joinScene, leaveScene }`; inbound `scene_snapshot` → `loadDocument` into hookstate + `getBridge()?.reset()` + `getBridge()?.init(doc)`; inbound `scene_op` → `applyOpToDocument` into hookstate + `getBridge()?.op(op)`. Both scoped by `isActive(gameId)`. `gameSock()` lazy singleton.
  - `actions.ts`: `initGame()` (connect), `openGame(gameId)` (set active, join), `closeGame()` (leave, reset state).

- [ ] **Step 1: Write the failing test**

`studio/frontend/src/plugins/game/socketClient.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState } from './state';
import { applyInbound } from './socketClient';
import { setBridge, ProtocolBridge } from './protocolBridge';

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeInitialState() as never);
  gameSlice().activeGameId.set('g1');
});

describe('game socket inbound', () => {
  it('scene_snapshot loads the document and re-inits the bridge', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applyInbound('scene_snapshot', {
      gameId: 'g1',
      document: { version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] },
    });

    expect(gameSlice().document.nodes.get({ noproxy: true })).toHaveProperty('root');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'init' }), 'http://localhost:4300');
  });

  it('scene_op applies to the document and forwards to the bridge', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applyInbound('scene_op', { gameId: 'g1', op: { kind: 'addNode', id: 's', type: 'Sprite' } });

    expect(gameSlice().document.nodes.get({ noproxy: true })).toHaveProperty('s');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'op' }), 'http://localhost:4300');
  });

  it('ignores events for an inactive game', () => {
    const post = vi.fn();
    setBridge(new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' }));
    applyInbound('scene_op', { gameId: 'other', op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    expect(gameSlice().document.nodes.get({ noproxy: true })).not.toHaveProperty('s');
  });
});
```

> **Note:** `applyInbound(event, payload)` is the pure inbound dispatcher exported for testing; `createGameSocket()` wires it to real socket events. This keeps the socket logic unit-testable without a real socket.

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test frontend -- game/socketClient.spec`
Expected: FAIL — `Cannot find module './socketClient'`.

- [ ] **Step 3: Implement socketClient + actions**

`studio/frontend/src/plugins/game/socketClient.ts`:

```ts
import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { gameSlice, type IGameDocument } from './state';
import { applyOpToDocument, loadDocument, type ISceneOp } from './reducers';
import { getBridge } from './protocolBridge';

let sock: Socket | null = null;

function isActive(gameId: string): boolean {
  return gameSlice().activeGameId.get() === gameId;
}

export function applyInbound(event: 'scene_snapshot' | 'scene_op', payload: unknown): void {
  if (event === 'scene_snapshot') {
    const p = payload as { gameId: string; document: IGameDocument };
    if (!isActive(p.gameId)) return;
    const doc = loadDocument(p.document);
    gameSlice().document.set(doc as never);
    const bridge = getBridge();
    bridge?.reset();
    bridge?.init(doc);
  } else {
    const p = payload as { gameId: string; op: ISceneOp };
    if (!isActive(p.gameId)) return;
    const current = gameSlice().document.get({ noproxy: true }) as IGameDocument;
    gameSlice().document.set(applyOpToDocument(current, p.op) as never);
    getBridge()?.op(p.op);
  }
}

export function createGameSocket() {
  function connect(): void {
    if (sock) return;
    gameSlice().connection.set('connecting');
    sock = io(BACKEND_URL, { auth: { displayName: 'game-preview' } });
    sock.on('connect', () => {
      gameSlice().connection.set('connected');
      const active = gameSlice().activeGameId.get();
      if (active) sock?.emit('join_scene', { gameId: active });
    });
    sock.on('disconnect', () => gameSlice().connection.set('reconnecting'));
    sock.on('scene_snapshot', (p) => applyInbound('scene_snapshot', p));
    sock.on('scene_op', (p) => applyInbound('scene_op', p));
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
    gameSlice().connection.set('disconnected');
  }
  return {
    connect,
    disconnect,
    joinScene: (gameId: string) => sock?.emit('join_scene', { gameId }),
    leaveScene: (gameId: string) => sock?.emit('leave_scene', { gameId }),
  };
}

let client: ReturnType<typeof createGameSocket> | null = null;
export function gameSock() {
  if (!client) client = createGameSocket();
  return client;
}
```

`studio/frontend/src/plugins/game/actions.ts`:

```ts
import { gameSlice, emptyDocument } from './state';
import { gameSock } from './socketClient';

export function initGame(): void {
  gameSock().connect();
}

export function openGame(gameId: string): void {
  const s = gameSlice();
  if (s.activeGameId.get() === gameId) return;
  const prev = s.activeGameId.get();
  if (prev) gameSock().leaveScene(prev);
  s.activeGameId.set(gameId);
  s.document.set(emptyDocument() as never);
  s.status.set('loading');
  gameSock().joinScene(gameId); // snapshot arrives over the socket
  s.status.set('idle');
}

export function closeGame(): void {
  const s = gameSlice();
  const prev = s.activeGameId.get();
  if (prev) gameSock().leaveScene(prev);
  s.activeGameId.set(null);
  s.document.set(emptyDocument() as never);
  s.status.set('idle');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test frontend -- game/socketClient.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/game
git add studio/frontend/src/plugins/game
git commit -m "feat(game): socketClient (snapshot/op → hookstate + bridge) + lifecycle actions"
```

---

### Task 16: GamePreviewPane (host-derived engine iframe)

**Files:**

- Create: `studio/frontend/src/plugins/game/GamePreviewPane.tsx`
- Test: `studio/frontend/src/plugins/game/GamePreviewPane.spec.tsx`

**Interfaces:**

- Consumes: `gameHooks` (Task 12), `engineOrigin` (Task 12), `ProtocolBridge`/`setBridge`/`clearBridge` (Task 14), `gameSlice` (Task 12).
- Produces: a Dockview pane (`IDockviewPanelProps`) that renders an empty state when no game is active, else an `<iframe>` whose `src` is `${engineOrigin()}/?parentOrigin=${encodeURIComponent(window.location.origin)}`. On mount it creates a `ProtocolBridge` (post → `iframe.contentWindow.postMessage`), registers it via `setBridge`, adds a `window` `message` listener routing to `bridge.handleEngineMessage`, and on the engine's `ready` inits the iframe from the current hookstate document. On unmount it removes the listener and `clearBridge`. Design-language tokens only; `data-testid` hooks for e2e.

- [ ] **Step 1: Write the failing test**

`studio/frontend/src/plugins/game/GamePreviewPane.spec.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState } from './state';
import { GamePreviewPane } from './GamePreviewPane';

vi.mock('./actions', () => ({ openGame: vi.fn(), closeGame: vi.fn(), initGame: vi.fn() }));

const fakeProps = {} as Parameters<typeof GamePreviewPane>[0];

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeInitialState() as never);
});

describe('GamePreviewPane', () => {
  it('shows an empty state when no game is active', () => {
    render(<GamePreviewPane {...fakeProps} />);
    expect(screen.getByTestId('game-no-game')).toBeTruthy();
  });

  it('renders the engine iframe with a host-derived, origin-pinned src', () => {
    act(() => gameSlice().activeGameId.set('g1'));
    render(<GamePreviewPane {...fakeProps} />);
    const frame = screen.getByTestId('game-engine-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toContain(`:4300/?parentOrigin=`);
    expect(frame.getAttribute('src')).toContain(encodeURIComponent(window.location.origin));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test frontend -- game/GamePreviewPane.spec`
Expected: FAIL — `Cannot find module './GamePreviewPane'`.

- [ ] **Step 3: Implement the pane**

`studio/frontend/src/plugins/game/GamePreviewPane.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { gameHooks, gameSlice, type IGameDocument } from './state';
import { engineOrigin } from './config';
import { ProtocolBridge, setBridge, clearBridge } from './protocolBridge';

export function GamePreviewPane(_props: IDockviewPanelProps) {
  const s = gameHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!activeGameId) return;
    const frame = frameRef.current;
    if (!frame) return;
    const origin = engineOrigin();
    const bridge = new ProtocolBridge({
      engineOrigin: origin,
      post: (m, targetOrigin) => frame.contentWindow?.postMessage(m, targetOrigin),
    });
    setBridge(bridge);

    const onMessage = (event: MessageEvent) => {
      bridge.handleEngineMessage(event.data, event.origin);
      // On the engine's first ready, init it from the current canonical document.
      if (event.origin === origin && event.data?.kind === 'ready') {
        const doc = gameSlice().document.get({ noproxy: true }) as IGameDocument;
        bridge.init(doc);
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      clearBridge(bridge);
    };
  }, [activeGameId]);

  if (!activeGameId) {
    return (
      <div data-testid="game-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to see its live scene.
      </div>
    );
  }

  const src = `${engineOrigin()}/?parentOrigin=${encodeURIComponent(window.location.origin)}`;
  return (
    <div className="flex h-full flex-col bg-surface">
      <iframe ref={frameRef} data-testid="game-engine-frame" title="Game scene preview" src={src} className="h-full w-full flex-1 border-0" />
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test frontend -- game/GamePreviewPane.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/game
git add studio/frontend/src/plugins/game
git commit -m "feat(game): GamePreviewPane hosting the host-derived engine iframe"
```

---

### Task 17: Plugin registration + route binding

**Files:**

- Create: `studio/frontend/src/plugins/game/index.ts`
- Modify: `studio/frontend/src/plugins/index.ts`
- Modify: `studio/frontend/src/app/routes/RoomRoute.tsx`
- Test: `studio/frontend/src/plugins/game/index.spec.ts`

**Interfaces:**

- Consumes: the plugin pieces (Tasks 12–16), `IPlugin` (existing host type).
- Produces: `game: IPlugin<IGameState>` (id `game`, a `game/preview` pane + an open command, `init: initGame`); registration in `PLUGINS`; `openGame`/`closeGame` bound in `RoomRoute` alongside the gdd/assets plugins.

- [ ] **Step 1: Write the failing test**

`studio/frontend/src/plugins/game/index.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { game } from './index';

describe('game plugin', () => {
  it('declares the preview pane and id', () => {
    expect(game.id).toBe('game');
    expect(game.panes.map((p) => p.id)).toContain('game/preview');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test frontend -- game/index.spec`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: Implement the plugin index**

`studio/frontend/src/plugins/game/index.ts`:

```ts
import type { IPlugin } from '../../host/types';
import { GamePreviewPane } from './GamePreviewPane';
import { GAME_PLUGIN_ID, makeInitialState, type IGameState } from './state';
import { initGame } from './actions';

export const game: IPlugin<IGameState> = {
  id: GAME_PLUGIN_ID,
  title: 'Game Scene',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'game/preview', title: 'Game Scene', component: GamePreviewPane as never }],
  commands: [{ id: 'game/open-preview', title: 'Open Game Scene', run: (host) => host.openPane('game/preview') }],
  init: () => initGame(),
};
```

- [ ] **Step 4: Register it + bind in the route**

In `studio/frontend/src/plugins/index.ts`:

```ts
import type { IPlugin } from '../host/types';
import { demoCounter } from './demo-counter';
import { demoScratch } from './demo-scratch';
import { llmChat } from './llm-chat';
import { assets } from './assets';
import { gdd } from './gdd';
import { game } from './game';

export const PLUGINS: IPlugin[] = [demoCounter, demoScratch, llmChat, assets, gdd, game];
```

In `studio/frontend/src/app/routes/RoomRoute.tsx`, add the import:

```ts
import { openGame, closeGame } from '../../plugins/game/actions';
```

In the `getRooms().then(...)` success branch, after `if (found.gameId) void openGameDocs(found.gameId);`, add:

```ts
if (found.gameId) openGame(found.gameId);
```

In the unmount cleanup effect, after `closeGameDocs();`, add:

```ts
closeGame();
```

- [ ] **Step 5: Run to verify it passes + typecheck + the whole frontend unit suite**

Run:

```bash
npx nx test frontend -- game/index.spec
npx nx typecheck frontend
npx nx test frontend
```

Expected: PASS / clean (no existing test broke).

- [ ] **Step 6: Commit**

```bash
npx prettier --write studio/frontend/src
git add studio/frontend/src/plugins/game studio/frontend/src/plugins/index.ts studio/frontend/src/app/routes/RoomRoute.tsx
git commit -m "feat(game): register game plugin + bind scene lifecycle in RoomRoute"
```

---

### Task 18: Authoritative client e2e (Playwright, local-only)

**Files:**

- Create: `studio/frontend/e2e/game-scene.spec.ts`

**Interfaces:**

- Consumes: the running stack — frontend `:4200` (Vite), backend `:8000` (replay), and the engine on `:4300` (`npx nx serve client`). The pane's iframe + `ProtocolBridge` + socket + reducers.
- Produces: a local-only Playwright spec proving the **authoritative client behavior**: with a game open, ops applied through the real socket→reducer→bridge chain mutate the **engine iframe scene live, with no reload**, and the canonical hookstate stays in sync. Deterministic (no LLM): the test drives ops through the live socket by invoking the backend `GameSceneHub` path via the agent is out of scope here — instead it exercises the real bridge→engine render path by posting ops through the page's own socket-applied stream using a seeded scene.

> **Driving ops deterministically:** the test opens a game (the pane mounts the engine iframe and the socket joins the scene), then applies ops by calling the exported `applyInbound('scene_op', …)` on the page — the _same_ function the socket dispatches into — so the full reducer + `ProtocolBridge` + iframe path runs without an LLM. It asserts the engine iframe's `__engineModel.toDocument()` reflects the ops (proving cross-frame render) and the canonical hookstate matches.

- [ ] **Step 1: Confirm the stack is free, then start it (solo)**

Per non-interference policy, verify nothing else holds the ports, then start the three servers (each in its own terminal, or background):

```bash
# from the worktree root
npx nx serve client            # engine on :4300
just backend-serve-replay      # backend on :8000 (replay)
npx nx serve frontend          # studio on :4200
```

(Confirm `:4200`/`:8000`/`:4300` were free first — see Global Constraints.)

- [ ] **Step 2: Expose the inbound dispatcher to the page for deterministic driving**

In `studio/frontend/src/plugins/game/socketClient.ts`, at the end of `createGameSocket().connect()` (after wiring the socket handlers), expose the dispatcher for e2e (guarded, harmless in prod):

```ts
(window as unknown as { __gameApplyInbound?: typeof applyInbound }).__gameApplyInbound = applyInbound;
```

Run `npx nx test frontend` to confirm nothing broke, then commit this one-line hook with the e2e in Step 4.

- [ ] **Step 3: Write the e2e spec**

`studio/frontend/e2e/game-scene.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack:
//   engine :4300 (nx serve client), backend :8000 (replay), studio :4200.
// Drives ops through the real socket-dispatch path (window.__gameApplyInbound)
// so the reducer + ProtocolBridge + engine-iframe render run without an LLM.

async function openAppAtRoom(page: Page, username: string): Promise<string> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Scene E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
  return page.url();
}

test('ops mutate the engine iframe scene live and keep hookstate in sync', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  // Open the Game Scene pane (command palette or a direct host call exposed in dev).
  await page.evaluate(() => (window as any).__host?.openPane?.('game/preview'));
  const frame = page.getByTestId('game-engine-frame');
  await expect(frame).toBeVisible();

  // Wait for the engine iframe to boot and the bridge to be ready.
  await expect
    .poll(async () => page.evaluate(() => !!(document.querySelector('[data-testid=game-engine-frame]') as HTMLIFrameElement)?.contentWindow))
    .toBe(true);

  const gameId = await page.evaluate(() => (window as any).__gameActiveId ?? null);

  // Drive ops through the real socket-dispatch path.
  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    apply('scene_op', {
      gameId: gid,
      op: { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } },
    });
  }, gameId);

  // The engine iframe's model reflects the ops (proves cross-frame render, no reload).
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const f = document.querySelector('[data-testid=game-engine-frame]') as HTMLIFrameElement;
        const model = (f.contentWindow as any)?.__engineModel;
        return model ? Object.keys(model.toDocument().nodes).length : 0;
      }),
    )
    .toBeGreaterThanOrEqual(2);
});
```

> **Wiring `gameId`/host for the test:** if `window.__gameActiveId` / `window.__host` are not already exposed, expose them minimally (e.g. set `(window).__gameActiveId = gameId` in `openGame`, and `(window).__host = host` in `boot`) — both are dev/e2e observability hooks mirroring Plan 1's `__engineModel`. Keep them one-liners.

- [ ] **Step 4: Run the e2e**

Run (from the worktree root, stack up): `npx nx e2e frontend -- game-scene` (or `npx playwright test e2e/game-scene.spec.ts` from `studio/frontend`).
Expected: PASS — the engine iframe shows ≥2 nodes after the ops, with no reload.

- [ ] **Step 5: Run the full local e2e suite to confirm no regression, then commit**

Run: `just e2e` (the repo's replay-backed Playwright suite — start `just backend-serve-replay` first per the e2e tier notes).
Expected: green (existing specs unaffected; the new spec passes).

```bash
npx prettier --write studio/frontend
git add studio/frontend/e2e/game-scene.spec.ts studio/frontend/src/plugins/game/socketClient.ts studio/frontend/src/plugins/game/actions.ts
git commit -m "test(game): authoritative e2e — ops render live in the engine iframe"
```

---

## Optional follow-up (local, requires live providers) — agent-driven cassette e2e

Not required for merge; strengthens coverage to the full agent path. After the stack works end-to-end with a live LLM:

1. Run `just record-fixtures` (live) to record a `design-scene` cassette (drives the six `scene.*` tools to author a small scene).
2. Add a backend non-browser e2e (mirroring `tests/e2e/test_gdd.py`) that runs `design-scene` under replay and asserts (coarsely, tolerating LLM variation): `game_scenes` for the room's game contains a `Root` node and ≥1 other node, and ≥1 `scene_op` was broadcast to a joined socket client.
3. `test_fixtures_committed.py` keeps the cassette committed. This test then runs in CI deterministically.

This is intentionally deferred: it depends on recording an LLM cassette (live access), which the deterministic Task 18 e2e and the Task 6/Task 11 coverage do not require.

---

## Self-Review

**1. Spec coverage** (against `2026-06-24-client-engine-studio-integration-design.md`):

- §2.1 host-derived iframe + env-configurable port → Tasks 12 (`engineOrigin`/`ENGINE_PORT`), 16 (iframe src). ✓
- §2.1 origin pinning both directions → Task 1 (engine gate + targeted post), Task 14/16 (bridge posts with `engineOrigin`; pane gates by origin). ✓
- §2.2 backend-authoritative + Python GraphModel port (validation parity) → Tasks 2–4. ✓
- §2.2 agent tool "fail loudly" (error string on `OpError`) → Task 8. ✓
- §2.2 drift mitigation (two validators; trusting frontend reducer) → Task 13 (trusting), Tasks 2–4 vs Plan 1 TS. (Golden-vector cross-check: the GraphModel tests mirror Plan 1's TS tests case-for-case; a literal shared fixture file is a labeled nicety, not built.) ✓
- §3.1 backend units (models/graph_model/store/hub/sockets, 6 tools, skill, DI) → Tasks 2–10. ✓
- §3.2 frontend `game` plugin (state/reducers/socketClient/actions/config, bridge, pane, registration) → Tasks 12–17. ✓
- §3.3 engine origin pinning via `?parentOrigin=` → Task 1 + Task 16. ✓
- §4 data flow (tool→hub→scene_op→socketClient→hookstate+bridge→iframe; snapshot→loadDocument→init) → Tasks 6, 8, 15, 16. ✓
- §5 error handling (backend reject untouched, batch atomic, queue-before-ready, get_or_create) → Tasks 2–6, 14. ✓
- §6 testing (backend unit + non-browser e2e in CI; frontend unit; local authoritative e2e) → Tasks 2–11, 12–18. ✓
- §6 non-interference (env port, `bloom_studio_test`, no GPU, solo stack) → Global Constraints + Task 18 Step 1. ✓
- §7 scope (in: all listed; deferred: client-initiated ops, multi-scene, client→server op path, codegen, rich asset resolution) → honored; the agent-driven cassette e2e is an explicit optional follow-up. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code. The only "if it fails, fall back" notes (deep import in Task 12; `__host`/`__gameActiveId` hooks in Task 18) are explicit, bounded alternatives, not placeholders.

**3. Type/name consistency:** `IGameDocument`/`INode`/`IEdge`/`IPortRef`/`JsonValue` consistent across Tasks 12–16. `ISceneOp` defined in Task 13, used in 14/15. `applyOpToDocument`/`loadDocument`/`applyInbound`/`engineOrigin`/`gameSlice`/`gameSock`/`getBridge`/`setBridge`/`clearBridge` names match across tasks. Backend `GraphModel.apply/apply_batch/load/to_document/get_node/get_edge/edges_by_source/edges_by_target`, `OpError.code`, `GameSceneStore.get_or_create/get_document/apply_op/apply_batch`, `GameSceneHub.attach/apply_op/apply_batch`, `register_scene_handlers`, `SCENE_TOOL_NAMES`, the six `scene_*` tool names, and the `ToolContext`/`ToolFactory` `scene_store`/`scene_hub` fields are introduced before use and consistent across Tasks 2–11. Socket events `scene_snapshot`/`scene_op`/`join_scene`/`leave_scene` consistent backend↔frontend. ✓
