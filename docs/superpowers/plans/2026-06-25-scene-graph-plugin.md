# Scene Graph Viewer Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Bloom Studio plugin that renders the active game's scene as a Unity-style hierarchy tree, with a `selectedId` selection seam for a future inspector.

**Architecture:** A new sibling plugin at `studio/frontend/src/plugins/scene-graph/`, following the existing `IPlugin` conventions. A pure `buildTree` function turns the `game` plugin's already-synced `IGameDocument` into a depth-tagged row list by walking `child` edges from the `Root` node. A React pane renders the rows, tracks collapse state, and records `selectedId`. The plugin's only coupling is a read-only import of the `game` plugin's state accessor and wire types from `../game/state`.

**Tech Stack:** TypeScript, React, `@hookstate/core` (via `makePluginHooks`), `dockview-react` (pane host), `lucide-react` (icons), Tailwind (theme tokens), Vitest + `@testing-library/react`.

## Global Constraints

- **Read-only.** No node add/remove/edit; no sockets, no backend calls, no writes outside this plugin's own state slice.
- **Isolation — do NOT touch:** `runtime/client`, `studio/frontend/src/plugins/game/protocolBridge.ts`, the backend `studio/backend/app/scene/*`, or the wire protocol. The only cross-plugin reference is a read-only import from `studio/frontend/src/plugins/game/state.ts`.
- **Plugin id:** `scene-graph`. **Pane id:** `scene-graph/tree` (title "Scene Graph"). **Command id:** `scene-graph/open` (title "Open Scene Graph").
- **Child-edge direction (fixed by the protocol):** a `child` edge has `from.node` = parent, `to.node` = child. Data-only nodes (e.g. `Texture` wired via a `data` edge) are intentionally excluded from the v1 tree.
- **All four frontend CI gates must pass before the branch is done** (vitest green alone does not prove types/build): `npx prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`. Run from the repo root of the worktree `C:/code/bloom.wt/scene-graph-plugin`.
- **Theme tokens (verified to exist):** `bg-surface`, `bg-selection`, `text-selection-text`, `hover:bg-raised-hover`, `text-foreground`, `text-muted-foreground`. Do not invent new tokens.
- **Commit frequently** — each task ends with a commit. Commit message trailers are not required for this branch; keep messages conventional (`feat:` / `test:`).

---

### Task 1: `buildTree` pure function

The heart of the plugin: a pure, fully-tested function that converts an `IGameDocument` into an ordered, depth-tagged row list following `child` edges from `Root`. No React, no hookstate.

**Files:**
- Create: `studio/frontend/src/plugins/scene-graph/buildTree.ts`
- Test: `studio/frontend/src/plugins/scene-graph/buildTree.spec.ts`

**Interfaces:**
- Consumes: `IGameDocument`, `NodeType` from `../game/state` (existing wire types: `IGameDocument = { version, nodes: Record<string, INode>, edges: IEdge[] }`; `INode = { id, type: NodeType, props: Record<string, JsonValue> }`; `IEdge = { id, type: 'child' | 'data', from: { node, port }, to: { node, port } }`).
- Produces: `export interface ITreeRow { id: string; type: NodeType; depth: number; name?: string; hasChildren: boolean }` and `export function buildTree(doc: IGameDocument, collapsed?: Record<string, boolean>): ITreeRow[]`. `collapsed[id] === true` hides that node's descendants (its row still reports `hasChildren: true`); an absent entry means expanded.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/scene-graph/buildTree.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { IGameDocument } from '../game/state';
import { buildTree } from './buildTree';

function doc(partial: Partial<IGameDocument>): IGameDocument {
  return { version: 1, nodes: {}, edges: [], ...partial };
}

// child edge: from = parent, to = child
function childEdge(id: string, parent: string, child: string) {
  return { id, type: 'child' as const, from: { node: parent, port: 'children' }, to: { node: child, port: 'parent' } };
}

describe('buildTree', () => {
  it('returns [] for an empty document', () => {
    expect(buildTree(doc({}))).toEqual([]);
  });

  it('returns [] when there is no Root node', () => {
    const d = doc({ nodes: { s: { id: 's', type: 'Sprite', props: {} } } });
    expect(buildTree(d)).toEqual([]);
  });

  it('returns a single row for a lone Root', () => {
    const d = doc({ nodes: { root: { id: 'root', type: 'Root', props: {} } } });
    expect(buildTree(d)).toEqual([{ id: 'root', type: 'Root', depth: 0, name: undefined, hasChildren: false }]);
  });

  it('walks child edges pre-order with depth and hasChildren', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        c1: { id: 'c1', type: 'Container', props: {} },
        s1: { id: 's1', type: 'Sprite', props: {} },
      },
      edges: [childEdge('e1', 'root', 'c1'), childEdge('e2', 'c1', 's1')],
    });
    expect(buildTree(d)).toEqual([
      { id: 'root', type: 'Root', depth: 0, name: undefined, hasChildren: true },
      { id: 'c1', type: 'Container', depth: 1, name: undefined, hasChildren: true },
      { id: 's1', type: 'Sprite', depth: 2, name: undefined, hasChildren: false },
    ]);
  });

  it('orders siblings by child-edge order', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        a: { id: 'a', type: 'Sprite', props: {} },
        b: { id: 'b', type: 'Sprite', props: {} },
      },
      edges: [childEdge('e1', 'root', 'b'), childEdge('e2', 'root', 'a')],
    });
    expect(buildTree(d).map((r) => r.id)).toEqual(['root', 'b', 'a']);
  });

  it('excludes data-only nodes (Texture wired by a data edge)', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        s1: { id: 's1', type: 'Sprite', props: {} },
        t1: { id: 't1', type: 'Texture', props: {} },
      },
      edges: [
        childEdge('e1', 'root', 's1'),
        { id: 'e2', type: 'data', from: { node: 't1', port: 'out' }, to: { node: 's1', port: 'texture' } },
      ],
    });
    expect(buildTree(d).map((r) => r.id)).toEqual(['root', 's1']);
  });

  it('skips child edges that point at a missing node', () => {
    const d = doc({
      nodes: { root: { id: 'root', type: 'Root', props: {} } },
      edges: [childEdge('e1', 'root', 'ghost')],
    });
    expect(buildTree(d).map((r) => r.id)).toEqual(['root']);
  });

  it('guards against cycles', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        a: { id: 'a', type: 'Container', props: {} },
      },
      edges: [childEdge('e1', 'root', 'a'), childEdge('e2', 'a', 'root')],
    });
    // root, a — and root is not re-emitted under a
    expect(buildTree(d).map((r) => r.id)).toEqual(['root', 'a']);
  });

  it('uses a string name prop, ignoring non-string names', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: { name: 'Stage' } },
        s1: { id: 's1', type: 'Sprite', props: { name: 42 } },
      },
      edges: [childEdge('e1', 'root', 's1')],
    });
    const rows = buildTree(d);
    expect(rows[0].name).toBe('Stage');
    expect(rows[1].name).toBeUndefined();
  });

  it('hides descendants of a collapsed node but keeps hasChildren', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        c1: { id: 'c1', type: 'Container', props: {} },
        s1: { id: 's1', type: 'Sprite', props: {} },
      },
      edges: [childEdge('e1', 'root', 'c1'), childEdge('e2', 'c1', 's1')],
    });
    const rows = buildTree(d, { c1: true });
    expect(rows.map((r) => r.id)).toEqual(['root', 'c1']);
    expect(rows.find((r) => r.id === 'c1')?.hasChildren).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/scene-graph/buildTree.spec.ts`
Expected: FAIL — cannot resolve `./buildTree` / `buildTree is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/scene-graph/buildTree.ts`:

```ts
import type { IGameDocument, NodeType } from '../game/state';

export interface ITreeRow {
  id: string;
  type: NodeType;
  depth: number;
  name?: string;
  hasChildren: boolean;
}

// Walks `child` edges out from the single Root node, producing a pre-order,
// depth-tagged row list. Pure: no React/hookstate. `collapsed[id] === true`
// hides a node's descendants (the row still reports hasChildren). Absent =>
// expanded. Data-only nodes (reachable only via `data` edges) are excluded.
export function buildTree(doc: IGameDocument, collapsed: Record<string, boolean> = {}): ITreeRow[] {
  const root = Object.values(doc.nodes).find((n) => n.type === 'Root');
  if (!root) return [];

  // parent id -> ordered child ids, from `child` edges (from = parent, to = child).
  const childrenOf = new Map<string, string[]>();
  for (const e of doc.edges) {
    if (e.type !== 'child') continue;
    if (!doc.nodes[e.to.node]) continue; // skip dangling edges
    const list = childrenOf.get(e.from.node) ?? [];
    list.push(e.to.node);
    childrenOf.set(e.from.node, list);
  }

  const rows: ITreeRow[] = [];
  const visited = new Set<string>();
  const walk = (id: string, depth: number): void => {
    if (visited.has(id)) return; // cycle / diamond guard
    visited.add(id);
    const node = doc.nodes[id];
    if (!node) return;
    const kids = childrenOf.get(id) ?? [];
    const nameProp = node.props.name;
    rows.push({
      id,
      type: node.type,
      depth,
      name: typeof nameProp === 'string' ? nameProp : undefined,
      hasChildren: kids.length > 0,
    });
    if (collapsed[id] === true) return;
    for (const kid of kids) walk(kid, depth + 1);
  };
  walk(root.id, 0);
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/scene-graph/buildTree.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/scene-graph/buildTree.ts studio/frontend/src/plugins/scene-graph/buildTree.spec.ts
git commit -m "feat: add scene-graph buildTree hierarchy builder"
```

---

### Task 2: State slice + `SceneGraphPane`

The plugin's own state (selection + collapse) and the React pane that reads the `game` document, renders the tree, and records selection. Includes `state.ts` as scaffolding the pane needs.

**Files:**
- Create: `studio/frontend/src/plugins/scene-graph/state.ts`
- Create: `studio/frontend/src/plugins/scene-graph/SceneGraphPane.tsx`
- Test: `studio/frontend/src/plugins/scene-graph/SceneGraphPane.spec.tsx`

**Interfaces:**
- Consumes: `buildTree`, `ITreeRow` from `./buildTree`; `gameHooks`, `IGameDocument`, `NodeType` from `../game/state`; `makePluginHooks` from `../../state/makePluginHooks`; `rootStore` from `../../state/rootStore`; `bumpRenderCount` from `../../app/renderCount`.
- Produces: `export const SCENE_GRAPH_PLUGIN_ID = 'scene-graph'`; `export interface ISceneGraphState { selectedId: string | null; collapsed: Record<string, boolean> }`; `export function makeInitialState(): ISceneGraphState`; `export const sceneGraphHooks`; `export function sceneGraphSlice(): State<ISceneGraphState>`; `export function SceneGraphPane(props: IDockviewPanelProps)`.

- [ ] **Step 1: Write the state module (scaffolding for the pane + its test)**

Create `studio/frontend/src/plugins/scene-graph/state.ts`:

```ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const SCENE_GRAPH_PLUGIN_ID = 'scene-graph';

export interface ISceneGraphState {
  selectedId: string | null;
  collapsed: Record<string, boolean>; // node id -> true when collapsed; absent = expanded
}

export function makeInitialState(): ISceneGraphState {
  return { selectedId: null, collapsed: {} };
}

export const sceneGraphHooks = makePluginHooks<ISceneGraphState>(SCENE_GRAPH_PLUGIN_ID);

export function sceneGraphSlice(): State<ISceneGraphState> {
  return rootStore.plugins.nested(SCENE_GRAPH_PLUGIN_ID) as unknown as State<ISceneGraphState>;
}
```

- [ ] **Step 2: Write the failing pane test**

Create `studio/frontend/src/plugins/scene-graph/SceneGraphPane.spec.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState as makeGameState, type IGameDocument } from '../game/state';
import { SCENE_GRAPH_PLUGIN_ID, sceneGraphSlice, makeInitialState } from './state';
import { SceneGraphPane } from './SceneGraphPane';

const fakeProps = {} as Parameters<typeof SceneGraphPane>[0];

const fixture: IGameDocument = {
  version: 1,
  nodes: {
    root: { id: 'root', type: 'Root', props: { name: 'Stage' } },
    c1: { id: 'c1', type: 'Container', props: {} },
    s1: { id: 's1', type: 'Sprite', props: {} },
  },
  edges: [
    { id: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'c1', port: 'parent' } },
    { id: 'e2', type: 'child', from: { node: 'c1', port: 'children' }, to: { node: 's1', port: 'parent' } },
  ],
};

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeGameState() as never);
  rootStore.plugins.nested(SCENE_GRAPH_PLUGIN_ID).set(makeInitialState() as never);
});

describe('SceneGraphPane', () => {
  it('shows an empty state when no scene is loaded', () => {
    render(<SceneGraphPane {...fakeProps} />);
    expect(screen.getByTestId('scene-graph-empty')).toBeTruthy();
  });

  it('renders a row per hierarchy node, showing name or id', () => {
    act(() => gameSlice().document.set(fixture as never));
    render(<SceneGraphPane {...fakeProps} />);
    expect(screen.getByTestId('scene-row-root').textContent).toContain('Stage');
    expect(screen.getByTestId('scene-row-c1')).toBeTruthy();
    expect(screen.getByTestId('scene-row-s1').textContent).toContain('s1');
  });

  it('records selectedId when a row is clicked', () => {
    act(() => gameSlice().document.set(fixture as never));
    render(<SceneGraphPane {...fakeProps} />);
    fireEvent.click(screen.getByTestId('scene-row-c1'));
    expect(sceneGraphSlice().selectedId.get()).toBe('c1');
    expect(screen.getByTestId('scene-row-c1').getAttribute('data-selected')).toBe('true');
  });

  it('collapses a node, hiding its descendants', () => {
    act(() => gameSlice().document.set(fixture as never));
    render(<SceneGraphPane {...fakeProps} />);
    fireEvent.click(screen.getByTestId('scene-toggle-c1'));
    expect(screen.queryByTestId('scene-row-s1')).toBeNull();
    expect(screen.getByTestId('scene-row-c1')).toBeTruthy(); // c1 itself still shown
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/scene-graph/SceneGraphPane.spec.tsx`
Expected: FAIL — cannot resolve `./SceneGraphPane`.

- [ ] **Step 4: Write the pane**

Create `studio/frontend/src/plugins/scene-graph/SceneGraphPane.tsx`:

```tsx
import type { IDockviewPanelProps } from 'dockview-react';
import { ChevronDown, ChevronRight, Box, Image, Layers, type LucideIcon } from 'lucide-react';
import { gameHooks, type IGameDocument, type NodeType } from '../game/state';
import { sceneGraphHooks } from './state';
import { buildTree, type ITreeRow } from './buildTree';
import { bumpRenderCount } from '../../app/renderCount';

const ICON: Record<NodeType, LucideIcon> = {
  Root: Layers,
  Container: Layers,
  Sprite: Box,
  Texture: Image,
};

export function SceneGraphPane(_props: IDockviewPanelProps) {
  const game = gameHooks.usePluginState();
  const sg = sceneGraphHooks.usePluginState();
  bumpRenderCount('SceneGraphPane');

  const doc = game.document.get({ noproxy: true }) as IGameDocument;
  const collapsed = sg.collapsed.get({ noproxy: true }) as Record<string, boolean>;
  const selectedId = sg.selectedId.get();
  const rows = buildTree(doc, collapsed);

  if (rows.length === 0) {
    return (
      <div data-testid="scene-graph-empty" className="flex h-full items-center justify-center bg-surface text-muted-foreground">
        No scene loaded.
      </div>
    );
  }

  const select = (id: string) => sg.selectedId.set(id);
  const toggle = (id: string) => sg.collapsed.set((c) => ({ ...c, [id]: !c[id] }));

  return (
    <div data-testid="scene-graph-pane" className="h-full overflow-auto bg-surface py-1 text-sm">
      {rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          selected={row.id === selectedId}
          collapsed={collapsed[row.id] === true}
          onSelect={select}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

function Row(props: {
  row: ITreeRow;
  selected: boolean;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { row, selected, collapsed, onSelect, onToggle } = props;
  const Icon = ICON[row.type];
  return (
    <div
      data-testid={`scene-row-${row.id}`}
      data-selected={selected ? 'true' : undefined}
      role="treeitem"
      aria-selected={selected}
      onClick={() => onSelect(row.id)}
      className={`flex cursor-pointer items-center gap-1 py-0.5 pr-2 ${
        selected ? 'bg-selection text-selection-text' : 'text-foreground hover:bg-raised-hover'
      }`}
      style={{ paddingLeft: `${8 + row.depth * 14}px` }}
    >
      {row.hasChildren ? (
        <button
          data-testid={`scene-toggle-${row.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row.id);
          }}
          className="flex h-4 w-4 items-center justify-center"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      ) : (
        <span className="inline-block h-4 w-4" />
      )}
      <Icon size={13} className="shrink-0 text-muted-foreground" />
      <span className="truncate">{row.name ?? row.id}</span>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/scene-graph/SceneGraphPane.spec.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/scene-graph/state.ts studio/frontend/src/plugins/scene-graph/SceneGraphPane.tsx studio/frontend/src/plugins/scene-graph/SceneGraphPane.spec.tsx
git commit -m "feat: add scene-graph pane and state slice"
```

---

### Task 3: Plugin definition + registration + full gate run

Wire the plugin into the studio app via its `IPlugin` definition and the `PLUGINS` array, then prove the whole branch is green against all four CI gates.

**Files:**
- Create: `studio/frontend/src/plugins/scene-graph/index.ts`
- Test: `studio/frontend/src/plugins/scene-graph/index.spec.ts`
- Modify: `studio/frontend/src/plugins/index.ts`

**Interfaces:**
- Consumes: `IPlugin` from `../../host/types`; `IPluginHost` (for the command's `run`); `SceneGraphPane` from `./SceneGraphPane`; `ISceneGraphState`, `SCENE_GRAPH_PLUGIN_ID`, `makeInitialState` from `./state`.
- Produces: `export const sceneGraph: IPlugin<ISceneGraphState>` with `id: 'scene-graph'`, pane `scene-graph/tree`, command `scene-graph/open`.

- [ ] **Step 1: Write the failing registration test**

Create `studio/frontend/src/plugins/scene-graph/index.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sceneGraph } from './index';

describe('sceneGraph plugin', () => {
  it('declares the expected id, pane, and command', () => {
    expect(sceneGraph.id).toBe('scene-graph');
    expect(sceneGraph.panes.map((p) => p.id)).toContain('scene-graph/tree');
    expect(sceneGraph.commands?.map((c) => c.id)).toContain('scene-graph/open');
  });

  it('seeds a non-persistent initial state', () => {
    expect(sceneGraph.persist).toBe(false);
    expect(sceneGraph.initialState).toEqual({ selectedId: null, collapsed: {} });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/scene-graph/index.spec.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Write the plugin definition**

Create `studio/frontend/src/plugins/scene-graph/index.ts`:

```ts
import type { IPlugin } from '../../host/types';
import { SceneGraphPane } from './SceneGraphPane';
import { SCENE_GRAPH_PLUGIN_ID, makeInitialState, type ISceneGraphState } from './state';

export const sceneGraph: IPlugin<ISceneGraphState> = {
  id: SCENE_GRAPH_PLUGIN_ID,
  title: 'Scene Graph',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'scene-graph/tree', title: 'Scene Graph', component: SceneGraphPane as never }],
  commands: [{ id: 'scene-graph/open', title: 'Open Scene Graph', run: (host) => host.openPane('scene-graph/tree') }],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/scene-graph/index.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the plugin in the studio**

Modify `studio/frontend/src/plugins/index.ts` — add the import and append to the `PLUGINS` array:

```ts
import type { IPlugin } from '../host/types';
import { demoCounter } from './demo-counter';
import { demoScratch } from './demo-scratch';
import { llmChat } from './llm-chat';
import { assets } from './assets';
import { gdd } from './gdd';
import { game } from './game';
import { simulator } from './simulator';
import { tuner } from './tuner';
import { sceneGraph } from './scene-graph';

export const PLUGINS: IPlugin[] = [demoCounter, demoScratch, llmChat, assets, gdd, game, simulator, tuner, sceneGraph];
```

- [ ] **Step 6: Run all four CI gates (the real bar for "done")**

From the worktree root `C:/code/bloom.wt/scene-graph-plugin`:

Run: `npx prettier --check .`
Expected: PASS (no files listed). If it complains about the new files, run `npx prettier --write studio/frontend/src/plugins/scene-graph` and re-check, then re-stage.

Run: `npx nx typecheck frontend`
Expected: PASS — no type errors.

Run: `npx nx test frontend`
Expected: PASS — the full frontend suite including the three new spec files.

Run: `npx nx build frontend`
Expected: PASS — production build succeeds.

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/src/plugins/scene-graph/index.ts studio/frontend/src/plugins/scene-graph/index.spec.ts studio/frontend/src/plugins/index.ts
git commit -m "feat: register scene-graph viewer plugin in studio"
```

---

## Manual verification (optional, after gates pass)

1. Start the studio frontend + backend (e.g. `just serve-frontend` plus the backend) and open a game that has a scene.
2. Run the **Open Scene Graph** command (command palette) — the "Scene Graph" pane appears.
3. Confirm the hierarchy mirrors the live scene: nodes nest under their parents, the type icons match, and `Texture` nodes are absent (expected — deferred to todo #87).
4. Click a node — the row highlights. Toggle a caret — descendants collapse/expand.
5. As the agent mutates the scene (e.g. adds a node), the tree updates live (it re-renders on each `scene_op`).

## Deferred work (already filed; do not implement here)

- #86 — shared scene-store seam replacing the read-only `../game/state` import.
- #87 — "Assets / Data" section for data-only / unparented nodes.
- #88 — standalone property-inspector plugin reading `selectedId`.
- #89 — UI→backend mutation path enabling node add/remove.
