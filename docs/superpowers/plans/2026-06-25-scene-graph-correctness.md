# Scene-graph Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-built scenes correct-by-construction — reject reversed/mistyped edges and root removal, surface orphaned nodes, and center sprites by default — and lock the behavior down with deterministic tests.

**Architecture:** The scene contract is a lockstep pair: `runtime/client/src/model/graphModel.ts` (engine) and `studio/backend/app/scene/graph_model.py` (backend), with shared definitions in `document.ts` / `document.py`. Every contract change lands in BOTH files with matching `vitest` + `pytest` tests. Centering is an engine-render concern (`PixiRenderer`). The `design-scene` skill prose nudges the LLM. Playwright e2e drives ops through the real engine path and is the authoritative behavioral contract.

**Tech Stack:** TypeScript (Vitest, Pixi v8, Nx), Python (pytest, FastAPI, Motor), Playwright.

## Global Constraints

- **TS/Python GraphModel lockstep:** `graphModel.ts` and `graph_model.py` must validate identically. Every contract task edits both files and both test suites in the same commit. Same error `code` strings on both sides.
- **TDD:** failing test first, watch it fail, minimal code, watch it pass, commit.
- **Semantic commits** (Conventional Commits), imperative mood.
- **Work in the worktree** `C:\code\bloom.wt\design-scene-wiring` (branch `fix/design-scene-wiring`). Do NOT work in the primary checkout.
- **TypeScript interfaces use an `I` prefix** (repo coding standard).
- **Run commands from the worktree root** unless a path says otherwise. Backend tests: `uv --directory studio/backend run pytest`. Engine tests: `npx nx test client` (or `npx vitest run` within `runtime/client`). Browser e2e: `just e2e` against a replay backend (never CI).
- **Spec:** `docs/superpowers/specs/2026-06-25-scene-graph-correctness-design.md`.

---

## File Structure

- `runtime/client/src/model/document.ts` — add `reachableFromRoot` / `unreachableNodes` pure helpers (engine).
- `runtime/client/src/model/graphModel.ts` — typed-edge validation in `connect`; root-removal + second-root guards in `addNode`/`removeNode`.
- `runtime/client/src/render/pixiRenderer.ts` — Sprite default anchor 0.5; `anchorOf` / `onStage` probes.
- `studio/backend/app/scene/document.py` — `unreachable_nodes(document)` pure helper.
- `studio/backend/app/scene/graph_model.py` — mirror of the graphModel.ts validation.
- `studio/backend/app/agent_tools.py` — append an orphan warning to scene-tool results.
- `skills/design-scene.md` — finalize the prose edits already drafted on the branch.
- `studio/frontend/e2e/scene-correctness.spec.ts` — new authoritative e2e.
- Tests touched: `runtime/client/src/model/graphModel.edges.spec.ts`, `runtime/client/src/model/document.spec.ts`, `runtime/client/src/render/pixiRenderer.spec.ts`, `studio/backend/tests/test_scene_graph_model.py`, `studio/backend/tests/test_scene_tools.py`.

---

## Task 1: Typed-edge validation (TS + Python lockstep)

Reject edges whose endpoints don't match the port contract: a `data` edge must run `Texture.data → Sprite.texture`; a `child` edge must run `Root|Container.children → Container|Sprite.parent`. New error code: `invalid_edge` (plus `bad_edge_type`).

**Files:**

- Modify: `runtime/client/src/model/graphModel.ts` (`connect`, ~lines 72–85)
- Modify: `studio/backend/app/scene/graph_model.py` (`_connect`, ~lines 90–105)
- Test: `runtime/client/src/model/graphModel.edges.spec.ts`
- Test: `studio/backend/tests/test_scene_graph_model.py`

**Interfaces:**

- Produces: `OpError('invalid_edge', …)` and `OpError('bad_edge_type', …)` from `connect`/`_connect` when endpoints are mistyped. Existing `child` checks (`already_parented`, `cycle`) still run, AFTER endpoint typing passes.

- [ ] **Step 1: Write the failing TS tests**

In `graphModel.edges.spec.ts`, the `withNodes()`/`child`/`data` helpers already exist. Add these cases inside the `describe('GraphModel connect/disconnect', …)` block:

```typescript
it('rejects a reversed data edge (Sprite.data -> Texture.texture)', () => {
  const m = withNodes();
  expect(() => m.apply({ kind: 'connect', edgeId: 'bad', type: 'data', from: { node: 's', port: 'data' }, to: { node: 'tex', port: 'texture' } })).toThrow(
    OpError,
  );
});

it('rejects a data edge to a non-texture port', () => {
  const m = withNodes();
  expect(() => m.apply({ kind: 'connect', edgeId: 'bad', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'parent' } })).toThrow(
    OpError,
  );
});

it('rejects a child edge with swapped ports', () => {
  const m = withNodes();
  expect(() =>
    m.apply({ kind: 'connect', edgeId: 'bad', type: 'child', from: { node: 'root', port: 'parent' }, to: { node: 'box', port: 'children' } }),
  ).toThrow(OpError);
});

it('rejects a child edge into a Texture', () => {
  const m = withNodes();
  expect(() =>
    m.apply({ kind: 'connect', edgeId: 'bad', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'tex', port: 'parent' } }),
  ).toThrow(OpError);
});
```

Also update the existing `'rejects a child cycle'` test so port-typing doesn't preempt the cycle check (Root can no longer be a child target). Replace it with a two-Container cycle:

```typescript
it('rejects a child cycle', () => {
  const m = withNodes();
  m.apply({ kind: 'addNode', id: 'box2', type: 'Container' });
  m.apply(child('e1', 'box', 'box2'));
  expect(() => m.apply(child('e2', 'box2', 'box'))).toThrow(OpError);
});
```

- [ ] **Step 2: Run the TS tests, verify they fail**

Run: `cd runtime/client && npx vitest run src/model/graphModel.edges.spec.ts`
Expected: the four new cases FAIL (edges currently accepted); the cycle case may still pass.

- [ ] **Step 3: Implement TS endpoint validation**

In `graphModel.ts`, replace the `connect` method's type-specific block (currently the `if (type === 'child') { … }` section, lines ~76–81) with:

```typescript
const fromType = this.nodes.get(from.node)!.type;
const toType = this.nodes.get(to.node)!.type;
if (type === 'child') {
  if (!(fromType === 'Root' || fromType === 'Container') || from.port !== 'children')
    throw new OpError('invalid_edge', `child edge must start at a Root/Container 'children' port`);
  if (!(toType === 'Container' || toType === 'Sprite') || to.port !== 'parent')
    throw new OpError('invalid_edge', `child edge must end at a Container/Sprite 'parent' port`);
  const childId = to.node;
  const parentId = from.node;
  if (this.parentOf(childId) !== null) throw new OpError('already_parented', `node already has a parent: ${childId}`);
  if (childId === parentId || this.isAncestor(childId, parentId)) throw new OpError('cycle', `child edge would create a cycle`);
} else if (type === 'data') {
  if (fromType !== 'Texture' || from.port !== 'data') throw new OpError('invalid_edge', `data edge must start at a Texture 'data' port`);
  if (toType !== 'Sprite' || to.port !== 'texture') throw new OpError('invalid_edge', `data edge must end at a Sprite 'texture' port`);
} else {
  throw new OpError('bad_edge_type', `unknown edge type: ${type as string}`);
}
```

(The two `unknown_node` existence checks immediately above this block are unchanged — `fromType`/`toType` rely on them having passed.)

- [ ] **Step 4: Run the TS tests, verify they pass**

Run: `cd runtime/client && npx vitest run src/model/graphModel.edges.spec.ts`
Expected: PASS (all cases, including the prior edge tests).

- [ ] **Step 5: Write the failing Python tests**

In `studio/backend/tests/test_scene_graph_model.py`, add (use the file's existing helper style — build a model and add `root`/`box`(Container)/`s`(Sprite)/`tex`(Texture) via `apply`):

```python
def _wired():
    from app.scene.graph_model import GraphModel
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "root", "type": "Root"})
    m.apply({"kind": "addNode", "id": "box", "type": "Container"})
    m.apply({"kind": "addNode", "id": "s", "type": "Sprite"})
    m.apply({"kind": "addNode", "id": "tex", "type": "Texture", "props": {"src": "asset:1"}})
    return m


def test_reversed_data_edge_rejected():
    from app.scene.document import OpError
    m = _wired()
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "connect", "edgeId": "bad", "type": "data",
                 "from": {"node": "s", "port": "data"}, "to": {"node": "tex", "port": "texture"}})
    assert ei.value.code == "invalid_edge"


def test_data_edge_to_non_texture_port_rejected():
    from app.scene.document import OpError
    m = _wired()
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "connect", "edgeId": "bad", "type": "data",
                 "from": {"node": "tex", "port": "data"}, "to": {"node": "s", "port": "parent"}})
    assert ei.value.code == "invalid_edge"


def test_child_edge_swapped_ports_rejected():
    from app.scene.document import OpError
    m = _wired()
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "connect", "edgeId": "bad", "type": "child",
                 "from": {"node": "root", "port": "parent"}, "to": {"node": "box", "port": "children"}})
    assert ei.value.code == "invalid_edge"


def test_child_edge_into_texture_rejected():
    from app.scene.document import OpError
    m = _wired()
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "connect", "edgeId": "bad", "type": "child",
                 "from": {"node": "root", "port": "children"}, "to": {"node": "tex", "port": "parent"}})
    assert ei.value.code == "invalid_edge"
```

Add `import pytest` at the top if not present. Also update the existing `test_cycle_rejected` to use two Containers (Root can no longer be a child target):

```python
def test_cycle_rejected():
    from app.scene.document import OpError
    m = _wired()
    m.apply({"kind": "addNode", "id": "box2", "type": "Container"})
    m.apply({"kind": "connect", "edgeId": "e1", "type": "child",
             "from": {"node": "box", "port": "children"}, "to": {"node": "box2", "port": "parent"}})
    with pytest.raises(OpError):
        m.apply({"kind": "connect", "edgeId": "e2", "type": "child",
                 "from": {"node": "box2", "port": "children"}, "to": {"node": "box", "port": "parent"}})
```

- [ ] **Step 6: Run the Python tests, verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_scene_graph_model.py -q`
Expected: the four new cases FAIL.

- [ ] **Step 7: Implement Python endpoint validation**

In `graph_model.py`, replace the `if type_ == "child":` block inside `_connect` (lines ~97–102) with:

```python
        from_type = self._nodes[frm["node"]]["type"]
        to_type = self._nodes[to["node"]]["type"]
        if type_ == "child":
            if from_type not in ("Root", "Container") or frm["port"] != "children":
                raise OpError("invalid_edge", "child edge must start at a Root/Container 'children' port")
            if to_type not in ("Container", "Sprite") or to["port"] != "parent":
                raise OpError("invalid_edge", "child edge must end at a Container/Sprite 'parent' port")
            child_id, parent_id = to["node"], frm["node"]
            if self._parent_of(child_id) is not None:
                raise OpError("already_parented", f"node already has a parent: {child_id}")
            if child_id == parent_id or self._is_ancestor(child_id, parent_id):
                raise OpError("cycle", "child edge would create a cycle")
        elif type_ == "data":
            if from_type != "Texture" or frm["port"] != "data":
                raise OpError("invalid_edge", "data edge must start at a Texture 'data' port")
            if to_type != "Sprite" or to["port"] != "texture":
                raise OpError("invalid_edge", "data edge must end at a Sprite 'texture' port")
        else:
            raise OpError("bad_edge_type", f"unknown edge type: {type_}")
```

- [ ] **Step 8: Run the Python tests, verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_scene_graph_model.py -q`
Expected: PASS.

- [ ] **Step 9: Run both full model suites (lockstep regression)**

Run: `cd runtime/client && npx vitest run src/model/` then `uv --directory studio/backend run pytest tests/test_scene_graph_model.py tests/test_scene_store.py -q`
Expected: PASS (no existing edge/load tests broken — existing valid edges still pass).

- [ ] **Step 10: Commit**

```bash
git add runtime/client/src/model/graphModel.ts runtime/client/src/model/graphModel.edges.spec.ts studio/backend/app/scene/graph_model.py studio/backend/tests/test_scene_graph_model.py
git commit -m "fix(scene): reject mistyped edges (typed ports, TS/Py lockstep)"
```

---

## Task 2: Guard root removal and second root (TS + Python lockstep)

A `Root` node is the stage and must persist; removing it cascade-deleted the whole tree. Reject `removeNode` of a Root (`cannot_remove_root`) and `addNode` of a second Root (`root_exists`).

**Files:**

- Modify: `runtime/client/src/model/graphModel.ts` (`addNode`, `removeNode`)
- Modify: `studio/backend/app/scene/graph_model.py` (`_add_node`, `_remove_node`)
- Test: `runtime/client/src/model/graphModel.nodes.spec.ts`
- Test: `studio/backend/tests/test_scene_graph_model.py`

**Interfaces:**

- Produces: `OpError('cannot_remove_root', …)` from removeNode on a Root; `OpError('root_exists', …)` from addNode of a second Root.

- [ ] **Step 1: Write the failing TS tests**

In `runtime/client/src/model/graphModel.nodes.spec.ts` add:

```typescript
it('refuses to remove the Root node', () => {
  const m = new GraphModel();
  m.apply({ kind: 'addNode', id: 'root', type: 'Root' });
  expect(() => m.apply({ kind: 'removeNode', id: 'root' })).toThrow(OpError);
});

it('refuses a second Root', () => {
  const m = new GraphModel();
  m.apply({ kind: 'addNode', id: 'root', type: 'Root' });
  expect(() => m.apply({ kind: 'addNode', id: 'root2', type: 'Root' })).toThrow(OpError);
});
```

(Ensure `OpError` is imported in that spec; if not, add `import { OpError } from './ops';`.)

- [ ] **Step 2: Run, verify fail**

Run: `cd runtime/client && npx vitest run src/model/graphModel.nodes.spec.ts`
Expected: both new cases FAIL.

- [ ] **Step 3: Implement TS guards**

In `graphModel.ts` `addNode`, after the `bad_type` check:

```typescript
if (type === 'Root' && [...this.nodes.values()].some((n) => n.type === 'Root')) throw new OpError('root_exists', `a Root node already exists`);
```

In `graphModel.ts` `removeNode`, after the `unknown_node` check:

```typescript
if (this.nodes.get(id)!.type === 'Root') throw new OpError('cannot_remove_root', `the Root node cannot be removed`);
```

- [ ] **Step 4: Run, verify pass**

Run: `cd runtime/client && npx vitest run src/model/graphModel.nodes.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Python tests**

In `test_scene_graph_model.py` add:

```python
def test_remove_root_rejected():
    from app.scene.graph_model import GraphModel
    from app.scene.document import OpError
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "root", "type": "Root"})
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "removeNode", "id": "root"})
    assert ei.value.code == "cannot_remove_root"


def test_second_root_rejected():
    from app.scene.graph_model import GraphModel
    from app.scene.document import OpError
    m = GraphModel()
    m.apply({"kind": "addNode", "id": "root", "type": "Root"})
    with pytest.raises(OpError) as ei:
        m.apply({"kind": "addNode", "id": "root2", "type": "Root"})
    assert ei.value.code == "root_exists"
```

- [ ] **Step 6: Run, verify fail**

Run: `uv --directory studio/backend run pytest tests/test_scene_graph_model.py -q -k "root"`
Expected: FAIL.

- [ ] **Step 7: Implement Python guards**

In `graph_model.py` `_add_node`, after the `bad_type` check:

```python
        if type_ == "Root" and any(n["type"] == "Root" for n in self._nodes.values()):
            raise OpError("root_exists", "a Root node already exists")
```

In `graph_model.py` `_remove_node`, after the `unknown_node` check:

```python
        if self._nodes[node_id]["type"] == "Root":
            raise OpError("cannot_remove_root", "the Root node cannot be removed")
```

- [ ] **Step 8: Run, verify pass**

Run: `uv --directory studio/backend run pytest tests/test_scene_graph_model.py -q -k "root"`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add runtime/client/src/model/graphModel.ts runtime/client/src/model/graphModel.nodes.spec.ts studio/backend/app/scene/graph_model.py studio/backend/tests/test_scene_graph_model.py
git commit -m "fix(scene): guard Root removal and duplicate Root (TS/Py lockstep)"
```

---

## Task 3: Reachability / orphan helper (TS + Python lockstep)

A pure document helper that returns the `Sprite`/`Container` ids with no `child`-path to a `Root`. Texture nodes attach via `data` edges and have no display object, so they are never counted.

**Files:**

- Modify: `runtime/client/src/model/document.ts`
- Modify: `studio/backend/app/scene/document.py`
- Test: `runtime/client/src/model/document.spec.ts`
- Test: `studio/backend/tests/test_scene_graph_model.py`

**Interfaces:**

- Produces (TS): `export function unreachableNodes(doc: IGameDocument): string[]` — sorted ids.
- Produces (Py): `def unreachable_nodes(document: dict) -> list[str]` — sorted ids. `document` has `nodes` as a dict id→node and `edges` as a list (the shape returned by `GameSceneStore.get_document`/`apply_op`).

- [ ] **Step 1: Write the failing TS test**

In `runtime/client/src/model/document.spec.ts` add:

```typescript
import { unreachableNodes } from './document';

describe('unreachableNodes', () => {
  it('flags an unparented sprite and clears once parented', () => {
    const doc = {
      version: 1,
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        s: { id: 's', type: 'Sprite', props: {} },
        tex: { id: 'tex', type: 'Texture', props: { src: 'a' } },
      },
      edges: [],
    } as const;
    expect(unreachableNodes(doc as never)).toEqual(['s']); // tex never counts
    const parented = {
      ...doc,
      edges: [{ id: 'e', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } }],
    };
    expect(unreachableNodes(parented as never)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd runtime/client && npx vitest run src/model/document.spec.ts`
Expected: FAIL (`unreachableNodes is not a function`).

- [ ] **Step 3: Implement TS helper**

Append to `runtime/client/src/model/document.ts`:

```typescript
/** Sprite/Container ids with no `child`-path to a Root. Textures never count
 *  (data-only nodes, no display object). */
export function unreachableNodes(doc: IGameDocument): string[] {
  const reached = new Set<string>();
  const frontier: string[] = [];
  for (const n of Object.values(doc.nodes))
    if (n.type === 'Root') {
      reached.add(n.id);
      frontier.push(n.id);
    }
  while (frontier.length) {
    const parent = frontier.pop()!;
    for (const e of doc.edges) {
      if (e.type === 'child' && e.from.node === parent && !reached.has(e.to.node)) {
        reached.add(e.to.node);
        frontier.push(e.to.node);
      }
    }
  }
  return Object.values(doc.nodes)
    .filter((n) => (n.type === 'Sprite' || n.type === 'Container') && !reached.has(n.id))
    .map((n) => n.id)
    .sort();
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd runtime/client && npx vitest run src/model/document.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Python test**

In `test_scene_graph_model.py` add:

```python
def test_unreachable_nodes_flags_orphan_then_clears():
    from app.scene.document import unreachable_nodes
    doc = {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {}},
            "s": {"id": "s", "type": "Sprite", "props": {}},
            "tex": {"id": "tex", "type": "Texture", "props": {"src": "a"}},
        },
        "edges": [],
    }
    assert unreachable_nodes(doc) == ["s"]
    doc["edges"].append({"id": "e", "type": "child",
                         "from": {"node": "root", "port": "children"},
                         "to": {"node": "s", "port": "parent"}})
    assert unreachable_nodes(doc) == []
```

- [ ] **Step 6: Run, verify fail**

Run: `uv --directory studio/backend run pytest tests/test_scene_graph_model.py -q -k unreachable`
Expected: FAIL (ImportError).

- [ ] **Step 7: Implement Python helper**

Append to `studio/backend/app/scene/document.py`:

```python
def unreachable_nodes(document: dict) -> list[str]:
    """Sprite/Container ids with no child-path to a Root. Textures never count
    (data-only nodes, no display object)."""
    nodes = document["nodes"]
    edges = document["edges"]
    reached: set[str] = set()
    frontier: list[str] = []
    for nid, n in nodes.items():
        if n["type"] == "Root":
            reached.add(nid)
            frontier.append(nid)
    while frontier:
        parent = frontier.pop()
        for e in edges:
            if e["type"] == "child" and e["from"]["node"] == parent and e["to"]["node"] not in reached:
                reached.add(e["to"]["node"])
                frontier.append(e["to"]["node"])
    return sorted(
        nid for nid, n in nodes.items()
        if n["type"] in ("Container", "Sprite") and nid not in reached
    )
```

- [ ] **Step 8: Run, verify pass**

Run: `uv --directory studio/backend run pytest tests/test_scene_graph_model.py -q -k unreachable`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add runtime/client/src/model/document.ts runtime/client/src/model/document.spec.ts studio/backend/app/scene/document.py studio/backend/tests/test_scene_graph_model.py
git commit -m "feat(scene): add unreachable-node (orphan) helper (TS/Py lockstep)"
```

---

## Task 4: Surface orphan warnings in scene tools (backend)

After a scene op/batch succeeds, append a non-blocking warning to the tool result listing any unreachable Sprite/Container so the agent self-corrects and the failure is visible in the run feed.

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (scene tool builders ~233–344)
- Test: `studio/backend/tests/test_scene_tools.py`

**Interfaces:**

- Consumes: `unreachable_nodes` from `app.scene.document` (Task 3); `ctx.scene_hub.apply_op`/`apply_batch` return the updated document dict.

- [ ] **Step 1: Write the failing test**

In `studio/backend/tests/test_scene_tools.py` add:

```python
@pytest.mark.asyncio
async def test_orphan_sprite_warns_until_parented(mongo_db):
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    f, ctx = _factory(store, hub), _ctx(store, hub)
    add = f.build(["scene_add_node"], ctx)[0]
    conn = f.build(["scene_connect"], ctx)[0]

    await add.ainvoke({"node_id": "root", "type": "Root"})
    out = await add.ainvoke({"node_id": "s", "type": "Sprite"})
    assert "not parented" in out.lower() and "s" in out  # orphan warning

    out2 = await conn.ainvoke({"edge_id": "e", "type": "child",
                               "from_node": "root", "from_port": "children",
                               "to_node": "s", "to_port": "parent"})
    assert "not parented" not in out2.lower()  # cleared once parented
```

- [ ] **Step 2: Run, verify fail**

Run: `uv --directory studio/backend run pytest tests/test_scene_tools.py -q -k orphan`
Expected: FAIL (no warning text).

- [ ] **Step 3: Implement the warning helper + wire it in**

At the top of `agent_tools.py`, add to the scene import (find the existing `from app.scene.document import OpError` and extend it):

```python
from app.scene.document import OpError, unreachable_nodes
```

Add a module-level helper (near the other scene helpers, e.g. above `build_scene_add_node_tool`):

```python
def _orphan_suffix(doc: dict) -> str:
    orphans = unreachable_nodes(doc)
    if not orphans:
        return ""
    return " ⚠ not parented to root (won't render): " + ", ".join(orphans)
```

Then in each of `scene_add_node`, `scene_set_prop`, `scene_connect`, `scene_disconnect`, `scene_remove_node`, capture the returned doc and append the suffix. Example for `scene_add_node`:

```python
        try:
            doc = await ctx.scene_hub.apply_op(ctx.game_id, op)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Added {type} node '{node_id}'." + _orphan_suffix(doc)
```

Apply the same `doc = await …apply_op(…)` / `+ _orphan_suffix(doc)` change to `scene_set_prop` (`return f"Set {node_id}.{path}." + _orphan_suffix(doc)`), `scene_connect` (`return f"Connected {edge_id} ({type})." + _orphan_suffix(doc)`), `scene_disconnect` (`return f"Disconnected {edge_id}." + _orphan_suffix(doc)`), and `scene_remove_node` (`return f"Removed node '{node_id}' (and its edges)." + _orphan_suffix(doc)`). For `scene_apply_batch`:

```python
        try:
            doc = await ctx.scene_hub.apply_batch(ctx.game_id, ops)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Applied {len(ops)} ops atomically." + _orphan_suffix(doc)
```

If `GameSceneHub.apply_op`/`apply_batch` do not already return the document, update `studio/backend/app/scene/hub.py` to `return doc` (the inner `store.apply_op`/`apply_batch` already return it) — verify and add `return` if missing.

- [ ] **Step 4: Run, verify pass**

Run: `uv --directory studio/backend run pytest tests/test_scene_tools.py -q`
Expected: PASS (new + existing tool tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/app/scene/hub.py studio/backend/tests/test_scene_tools.py
git commit -m "feat(scene): warn on orphan nodes in scene-tool results"
```

---

## Task 5: Center sprites by default + render probes (engine)

New Sprites default to anchor (0.5, 0.5) so `position` is the sprite's center. Add `anchorOf`/`onStage` probes (test affordances, like the existing `textureSizeOf`) used by the unit test and the e2e.

**Files:**

- Modify: `runtime/client/src/render/pixiRenderer.ts`
- Test: `runtime/client/src/render/pixiRenderer.spec.ts`

**Interfaces:**

- Produces: `PixiRenderer.createObject` sets Sprite anchor 0.5 (explicit `anchor` prop still overrides via the reconciler's prop loop). `anchorOf(id): { x: number; y: number } | null`; `onStage(id): boolean`.

- [ ] **Step 1: Write the failing unit test**

In `runtime/client/src/render/pixiRenderer.spec.ts` add (it currently imports only `applyPixiProp`; add the class import):

```typescript
import { PixiRenderer } from './pixiRenderer';

describe('PixiRenderer.createObject', () => {
  it('defaults a new Sprite to a centered anchor (0.5, 0.5)', () => {
    const r = new PixiRenderer(document.createElement('div'));
    r.createObject('s', 'Sprite');
    expect(r.anchorOf('s')).toEqual({ x: 0.5, y: 0.5 });
  });

  it('lets an explicit anchor prop override the default', () => {
    const r = new PixiRenderer(document.createElement('div'));
    r.createObject('s', 'Sprite');
    r.setProp('s', 'anchor', { x: 0, y: 0 });
    expect(r.anchorOf('s')).toEqual({ x: 0, y: 0 });
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd runtime/client && npx vitest run src/render/pixiRenderer.spec.ts`
Expected: FAIL (`anchorOf` undefined / anchor 0,0).

- [ ] **Step 3: Implement default anchor + probes**

In `pixiRenderer.ts` `createObject`, change the Sprite branch:

```typescript
    if (type === 'Sprite') {
      const s = new Sprite();
      s.anchor.set(0.5); // position denotes the sprite's center by default
      this.objects.set(id, s);
    } else if (type === 'Container') {
```

Add two methods to the class (next to `textureSizeOf`):

```typescript
  anchorOf(id: string): { x: number; y: number } | null {
    const obj = this.objects.get(id);
    return obj instanceof Sprite ? { x: obj.anchor.x, y: obj.anchor.y } : null;
  }

  onStage(id: string): boolean {
    const stage = this.app?.stage as unknown as Container | undefined;
    let cur = this.objects.get(id) as Container | null | undefined;
    if (!stage || !cur) return false;
    while (cur) {
      if ((cur as unknown) === (stage as unknown)) return true;
      cur = cur.parent as Container | null;
    }
    return false;
  }
```

- [ ] **Step 4: Run, verify pass**

Run: `cd runtime/client && npx vitest run src/render/pixiRenderer.spec.ts`
Expected: PASS.

- [ ] **Step 5: Sweep fixtures/tests that assumed top-left anchoring**

Run the full engine suite and look for breakage from the anchor change:

Run: `cd runtime/client && npx vitest run`
Expected: PASS. If any reconciler/render test asserted a sprite's top-left-based geometry, update it to the centered default (anchor now 0.5). Fix inline and re-run until green.

- [ ] **Step 6: Commit**

```bash
git add runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/pixiRenderer.spec.ts
git commit -m "feat(engine): default Sprite anchor to center + anchorOf/onStage probes"
```

---

## Task 6: Finalize the design-scene skill prose

The prose edits are already drafted on the branch (edge-direction examples, the Texture-is-`from` rule, the parenting INVARIANT, no-root-removal/incremental rule, centering note). Confirm they're complete and that the skill still loads.

**Files:**

- Modify: `skills/design-scene.md`
- Test: `studio/backend/tests/test_design_scene_skill.py`

- [ ] **Step 1: Verify the prose covers all four failure modes**

Read `skills/design-scene.md`. Confirm it states, explicitly: (a) `data` edge direction `Texture.data → Sprite.texture` with `from_node`/`to_node` example; (b) the parenting INVARIANT (every Sprite/Container parented to root, parent edge in the same batch); (c) never remove or re-add `root`, extend incrementally; (d) centering with anchor-0.5 semantics (place at `width/2, height/2`). Add any missing point inline.

- [ ] **Step 2: Run the skill-loads test**

Run: `uv --directory studio/backend run pytest tests/test_design_scene_skill.py -q`
Expected: PASS (tools unchanged = `SCENE_TOOL_NAMES | {list_assets}`; body still contains "node").

- [ ] **Step 3: Commit**

```bash
git add skills/design-scene.md
git commit -m "docs(skill): make design-scene edge wiring + parenting unambiguous"
```

---

## Task 7: Authoritative Playwright e2e

A new spec drives ops through the real engine path (`__gameApplyInbound`) against a replay backend and encodes the behavioral contract.

**Files:**

- Create: `studio/frontend/e2e/scene-correctness.spec.ts`

**Interfaces:**

- Consumes: engine probes `__engineRenderer.textureSizeOf/anchorOf/onStage` (Task 5); `__engineMsgs` error acks (engine `error` posts on rejected ops); `window.__gameApplyInbound`, `window.__gameActiveId` (existing dev hooks, see `game-scene.spec.ts`).

- [ ] **Step 1: Write the spec**

Create `studio/frontend/e2e/scene-correctness.spec.ts` (modeled on `game-scene.spec.ts`):

```typescript
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack:
//   engine :4300 (nx serve client), backend :8000 (replay), studio :4200.
// Drives ops through the real socket-dispatch path (window.__gameApplyInbound).

async function openSceneRoom(page: Page): Promise<string> {
  await page.addInitScript(() => {
    (window as any).__engineMsgs = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && (d.kind === 'ack' || d.kind === 'ready' || d.kind === 'error')) {
        (window as any).__engineMsgs.push({ kind: d.kind, code: d.code });
      }
    });
  });
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Scene Correctness ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs.some((m: any) => m.kind === 'ready')), { timeout: 20000 }).toBe(true);
  const gid = await page.evaluate(() => (window as any).__gameActiveId as string | null);
  expect(gid).toBeTruthy();
  return gid!;
}

// Generate one real asset (replay) and return its media URL.
async function generateAsset(page: Page, gid: string): Promise<string> {
  await page.getByTestId('asset-name').fill('Sym');
  await page.getByTestId('asset-prompt').fill('a glowing symbol');
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 30_000 });
  return page.evaluate(async (g) => {
    const assets = await (await fetch(`/games/${g}/assets`)).json();
    const a = assets[0];
    const sel = a.generations.find((x: any) => x.id === a.selectedGenerationId) ?? a.generations[0];
    return sel.imageRef as string;
  }, gid);
}

const op = (gid: string, o: unknown) => ((window as any).__gameApplyInbound as (e: string, p: unknown) => void)('scene_op', { gameId: gid, op: o });

test('a correctly-wired sprite binds its texture, is centered, and is on the stage', async ({ page }) => {
  const gid = await openSceneRoom(page);
  const ref = await generateAsset(page, gid);
  await page.evaluate(
    ({ gid, ref }) => {
      const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
      send({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 1280, height: 720 } });
      send({ kind: 'addNode', id: 'sym', type: 'Sprite', props: { position: { x: 640, y: 360 } } });
      send({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: ref } });
      send({ kind: 'connect', edgeId: 'e.child', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'sym', port: 'parent' } });
      send({ kind: 'connect', edgeId: 'e.data', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 'sym', port: 'texture' } });
    },
    { gid, ref },
  );
  const frame = await (await page.getByTestId('game-engine-frame').elementHandle())!.contentFrame();
  await expect
    .poll(async () => frame!.evaluate(() => (window as any).__engineRenderer?.textureSizeOf('sym')?.width ?? 0), { timeout: 20000 })
    .toBeGreaterThan(64);
  expect(await frame!.evaluate(() => (window as any).__engineRenderer.anchorOf('sym'))).toEqual({ x: 0.5, y: 0.5 });
  expect(await frame!.evaluate(() => (window as any).__engineRenderer.onStage('sym'))).toBe(true);
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

test('a reversed data edge is rejected by the engine', async ({ page }) => {
  const gid = await openSceneRoom(page);
  const before = await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length);
  await page.evaluate((gid) => {
    const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
    send({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } });
    send({ kind: 'addNode', id: 'sym', type: 'Sprite' });
    send({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: '/media/x.png' } });
    send({ kind: 'connect', edgeId: 'bad', type: 'data', from: { node: 'sym', port: 'data' }, to: { node: 'tex', port: 'texture' } });
  }, gid);
  await expect
    .poll(() => page.evaluate((b: number) => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length - b, before), { timeout: 10000 })
    .toBeGreaterThanOrEqual(1);
});

test('removing the Root node is rejected by the engine', async ({ page }) => {
  const gid = await openSceneRoom(page);
  const before = await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length);
  await page.evaluate((gid) => {
    const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
    send({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } });
    send({ kind: 'removeNode', id: 'root' });
  }, gid);
  await expect
    .poll(() => page.evaluate((b: number) => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length - b, before), { timeout: 10000 })
    .toBeGreaterThanOrEqual(1);
});

test('adding a second sprite preserves the first (incremental, no rebuild)', async ({ page }) => {
  const gid = await openSceneRoom(page);
  const ref = await generateAsset(page, gid);
  // First sprite.
  await page.evaluate(
    ({ gid, ref }) => {
      const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
      send({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 1280, height: 720 } });
      send({ kind: 'addNode', id: 'a', type: 'Sprite', props: { position: { x: 400, y: 360 } } });
      send({ kind: 'addNode', id: 'texa', type: 'Texture', props: { src: ref } });
      send({ kind: 'connect', edgeId: 'e.a', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'a', port: 'parent' } });
      send({ kind: 'connect', edgeId: 'e.ta', type: 'data', from: { node: 'texa', port: 'data' }, to: { node: 'a', port: 'texture' } });
    },
    { gid, ref },
  );
  const frame = await (await page.getByTestId('game-engine-frame').elementHandle())!.contentFrame();
  await expect.poll(async () => frame!.evaluate(() => (window as any).__engineRenderer.onStage('a')), { timeout: 20000 }).toBe(true);
  // Second sprite — do NOT touch root.
  await page.evaluate(
    ({ gid, ref }) => {
      const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
      send({ kind: 'addNode', id: 'b', type: 'Sprite', props: { position: { x: 880, y: 360 } } });
      send({ kind: 'addNode', id: 'texb', type: 'Texture', props: { src: ref } });
      send({ kind: 'connect', edgeId: 'e.b', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'b', port: 'parent' } });
      send({ kind: 'connect', edgeId: 'e.tb', type: 'data', from: { node: 'texb', port: 'data' }, to: { node: 'b', port: 'texture' } });
    },
    { gid, ref },
  );
  await expect.poll(async () => frame!.evaluate(() => (window as any).__engineRenderer.onStage('b')), { timeout: 20000 }).toBe(true);
  expect(await frame!.evaluate(() => (window as any).__engineRenderer.onStage('a'))).toBe(true); // A preserved
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});

test('an unparented sprite binds its texture but is not on the stage', async ({ page }) => {
  const gid = await openSceneRoom(page);
  const ref = await generateAsset(page, gid);
  await page.evaluate(
    ({ gid, ref }) => {
      const send = (o: unknown) => (window as any).__gameApplyInbound('scene_op', { gameId: gid, op: o });
      send({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 1280, height: 720 } });
      send({ kind: 'addNode', id: 'orphan', type: 'Sprite' });
      send({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: ref } });
      send({ kind: 'connect', edgeId: 'e.data', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 'orphan', port: 'texture' } });
      // intentionally NO child edge
    },
    { gid, ref },
  );
  const frame = await (await page.getByTestId('game-engine-frame').elementHandle())!.contentFrame();
  await expect
    .poll(async () => frame!.evaluate(() => (window as any).__engineRenderer?.textureSizeOf('orphan')?.width ?? 0), { timeout: 20000 })
    .toBeGreaterThan(64);
  expect(await frame!.evaluate(() => (window as any).__engineRenderer.onStage('orphan'))).toBe(false);
});
```

- [ ] **Step 2: Bring up the replay stack and run the spec**

Start a replay backend (`PROVIDER_MODE=replay` on :8000 — or use `BLOOM_PORT_OFFSET`), then:

Run: `just e2e -- scene-correctness` (or `npx playwright test --config=studio/frontend/playwright.config.ts scene-correctness`)
Expected: 5 passed. If `generateAsset`'s selectors differ from the current asset pane, align them with `game-scene.spec.ts`.

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/e2e/scene-correctness.spec.ts
git commit -m "test(e2e): scene-graph correctness (wiring, rejection, incremental, orphan)"
```

---

## Task 8 (optional, manual): live smoke

Not a CI/automated test. Documented for on-demand validation of the skill against a live model.

- [ ] Start the live stack (real OpenRouter + ComfyUI). In a fresh game room, run `/generate-sprite a glowing phoenix` then `/design-scene center the phoenix on a 1280x720 stage`. Confirm: one sprite parented to root, texture bound, centered; no orphan warning in the run feed; re-running with a second sprite preserves the first.

---

## Self-Review

- **Spec coverage:** A1 typed edges → Task 1. A2 root guard → Task 2. A3 reachability + tool warning → Tasks 3, 4. B anchor 0.5 → Task 5. C skill prose → Task 6. D unit tests → Tasks 1–5; e2e → Task 7; live smoke → Task 8. All spec sections covered.
- **Lockstep:** Tasks 1–3 each edit `graphModel.ts` + `graph_model.py` (and `document.ts` + `document.py` for Task 3) with tests on both sides, in one commit.
- **Type consistency:** `unreachableNodes` (TS) / `unreachable_nodes` (Py); probes `anchorOf`/`onStage`/`textureSizeOf`; error codes `invalid_edge`, `bad_edge_type`, `cannot_remove_root`, `root_exists` used identically across both languages and the e2e.
- **Placeholders:** none — every code/test step shows concrete content.
