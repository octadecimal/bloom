# Property Inspector Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Bloom Studio plugin that shows the properties of the scene node currently selected in the scene-graph viewer, rendered as a nested expand/collapse JSON tree.

**Architecture:** A new `studio/frontend/src/plugins/property-inspector/` plugin, a sibling of `scene-graph`. A pure helper (`inspect.ts`) resolves the selected node from the live scene document and flattens its props into depth-tagged rows; a React pane (`InspectorPane.tsx`) renders a TYPE/ID header plus the rows with collapse carets; `state.ts` holds the per-path collapse map; `index.ts` registers the pane + command. The plugin reads two existing seams read-only — `sceneGraphSlice().selectedId` (selection) and `gameSlice().document` (scene doc) — and writes nothing.

**Tech Stack:** TypeScript (React 18 + dockview-react), `@hookstate/core` state, `lucide-react` icons, Tailwind utility classes mapped to the design-language tokens, Vitest + Testing Library, Nx.

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`IPropRow`, `IInspectorView`, `IPropertyInspectorState`) — repo coding standard.
- **No raw colors.** Only Tailwind utilities mapped to design-language tokens (`bg-surface`, `text-foreground`, `text-muted-foreground`, `text-faint`, `border-hairline`, …). No hex/`rgba()` literals — the no-raw-color guard test (`design-language.guard.spec.ts`) fails the build otherwise. Arbitrary **sizes** like `text-[10px]` are allowed (they are already used in the codebase); only colors are restricted.
- **Read-only.** No writes to the scene document, no backend/socket/protocol/client changes. The only cross-plugin imports are read-only: `../scene-graph/state` (selection) and `../game/state` (document + wire types).
- **Strictly v1 scope.** No prop editing, no node add/remove, no Assets/Data section, no data-edge rendering, no collapse-state persistence (`persist: false`).
- **TDD.** Every task is RED → GREEN → commit. All four frontend gates must pass before the PR: `node_modules/.bin/prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`.
- **Worktree.** All work happens in `C:/code/bloom.wt/property-inspector` (branch `feat/property-inspector`, `BLOOM_PORT_OFFSET=2`). Run gates from the worktree root.

---

## Setup (once, before Task 1)

The fresh worktree has no `node_modules`. From the worktree root install dependencies:

```bash
cd C:/code/bloom.wt/property-inspector && npm install
```

Sanity-check the toolchain runs before writing code:

```bash
cd C:/code/bloom.wt/property-inspector && npx nx test frontend
```

Expected: the existing frontend suite passes (green). If `npm install` or this command fails, stop and resolve the environment before proceeding — do not start Task 1 against a broken toolchain.

---

## Task 1: Pure helper `inspect.ts` (`inspectSelection`)

The fully unit-testable core: resolve the selected node and flatten its props into depth-tagged rows. No React, no hookstate.

**Files:**

- Create: `studio/frontend/src/plugins/property-inspector/inspect.ts`
- Test: `studio/frontend/src/plugins/property-inspector/inspect.spec.ts`

**Interfaces:**

- Consumes (read-only import): `IGameDocument`, `JsonValue`, `NodeType` from `../game/state`.
- Produces (later tasks rely on these exact names/types):
  - `interface IPropRow { path: string; key: string; depth: number; kind: 'scalar' | 'object' | 'array'; display?: string; hasChildren: boolean; count?: number }`
  - `interface IInspectorView { id: string; type: NodeType; rows: IPropRow[] }`
  - `function inspectSelection(doc: IGameDocument, selectedId: string | null, collapsed?: Record<string, boolean>): IInspectorView | null`

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/property-inspector/inspect.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { inspectSelection } from './inspect';
import type { IGameDocument } from '../game/state';

const doc: IGameDocument = {
  version: 1,
  nodes: {
    s1: {
      id: 's1',
      type: 'Sprite',
      props: {
        name: 'hero',
        x: 120,
        visible: true,
        nothing: null,
        tint: { r: 255, g: 0, b: 0 },
        frames: ['a', 'b'],
        empty: {},
      },
    },
  },
  edges: [],
};

describe('inspectSelection', () => {
  it('returns null when nothing is selected', () => {
    expect(inspectSelection(doc, null)).toBeNull();
  });

  it('returns null for a stale selection absent from nodes', () => {
    expect(inspectSelection(doc, 'gone')).toBeNull();
  });

  it('returns the node id and type for a valid selection', () => {
    const view = inspectSelection(doc, 's1');
    expect(view?.id).toBe('s1');
    expect(view?.type).toBe('Sprite');
  });

  it('formats scalar props (string quoted, number/boolean/null verbatim)', () => {
    const rows = inspectSelection(doc, 's1')!.rows;
    const by = (path: string) => rows.find((r) => r.path === path);
    expect(by('name')).toMatchObject({ key: 'name', depth: 0, kind: 'scalar', display: '"hero"', hasChildren: false });
    expect(by('x')?.display).toBe('120');
    expect(by('visible')?.display).toBe('true');
    expect(by('nothing')?.display).toBe('null');
  });

  it('emits a branch row for a nested object with its children at depth+1', () => {
    const rows = inspectSelection(doc, 's1')!.rows;
    const tint = rows.find((r) => r.path === 'tint');
    expect(tint).toMatchObject({ key: 'tint', depth: 0, kind: 'object', hasChildren: true, count: 3 });
    expect(rows.find((r) => r.path === 'tint.r')).toMatchObject({ key: 'r', depth: 1, display: '255' });
    expect(rows.find((r) => r.path === 'tint.g')).toBeTruthy();
    expect(rows.find((r) => r.path === 'tint.b')).toBeTruthy();
  });

  it('emits indexed rows for an array', () => {
    const rows = inspectSelection(doc, 's1')!.rows;
    expect(rows.find((r) => r.path === 'frames')).toMatchObject({ kind: 'array', hasChildren: true, count: 2 });
    expect(rows.find((r) => r.path === 'frames.0')).toMatchObject({ key: '0', display: '"a"' });
    expect(rows.find((r) => r.path === 'frames.1')).toMatchObject({ key: '1', display: '"b"' });
  });

  it('renders an empty object/array as a childless leaf', () => {
    const rows = inspectSelection(doc, 's1')!.rows;
    expect(rows.find((r) => r.path === 'empty')).toMatchObject({ kind: 'object', hasChildren: false, display: '{}' });
  });

  it('omits a branch’s descendants when collapsed', () => {
    const rows = inspectSelection(doc, 's1', { tint: true })!.rows;
    expect(rows.find((r) => r.path === 'tint')).toMatchObject({ hasChildren: true });
    expect(rows.find((r) => r.path === 'tint.r')).toBeUndefined();
  });

  it('does not loop on a cyclic/malformed value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cdoc: IGameDocument = {
      version: 1,
      nodes: { n: { id: 'n', type: 'Container', props: { c: cyclic as never } } },
      edges: [],
    };
    expect(() => inspectSelection(cdoc, 'n')).not.toThrow();
    expect(inspectSelection(cdoc, 'n')!.rows.find((r) => r.path === 'c')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/code/bloom.wt/property-inspector/studio/frontend && npx vitest run src/plugins/property-inspector/inspect.spec.ts`
Expected: FAIL — `inspect.ts` does not exist / `inspectSelection is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `studio/frontend/src/plugins/property-inspector/inspect.ts`:

```ts
import type { IGameDocument, JsonValue, NodeType } from '../game/state';

export interface IPropRow {
  path: string; // unique, stable: 'name' | 'tint.r' | 'frames.0' — React key + collapse key
  key: string; // the prop key or array index segment
  depth: number;
  kind: 'scalar' | 'object' | 'array';
  display?: string; // formatted scalar, or '{}' / '[]' for an empty branch
  hasChildren: boolean;
  count?: number; // entry count for a non-empty branch
}

export interface IInspectorView {
  id: string;
  type: NodeType;
  rows: IPropRow[];
}

function isPlainObject(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function formatScalar(v: JsonValue): string {
  // Strings are quoted ("hero"); number/boolean/null shown verbatim (120, true, null).
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

// Resolve the selected node and flatten its props into a pre-order, depth-tagged
// row list. Returns null when nothing is selected or the id is absent from the
// document (a stale selection). Pure: no React/hookstate. `collapsed[path] === true`
// hides a branch's descendants (the branch row is still emitted). Absent => expanded.
export function inspectSelection(doc: IGameDocument, selectedId: string | null, collapsed: Record<string, boolean> = {}): IInspectorView | null {
  if (selectedId === null) return null;
  const node = doc.nodes[selectedId];
  if (!node) return null;

  const rows: IPropRow[] = [];
  // Guard against cyclic / malformed in-flight values so the walk always
  // terminates. Valid JSON-over-the-wire is acyclic, so this only triggers on
  // degenerate runtime data; mirrors buildTree's visited-set robustness.
  const visited = new Set<object>();

  const walk = (key: string, path: string, value: JsonValue, depth: number): void => {
    const arr = Array.isArray(value);
    const obj = isPlainObject(value);
    if (arr || obj) {
      const entries: [string, JsonValue][] = arr ? (value as JsonValue[]).map((v, i) => [String(i), v]) : Object.entries(value as { [k: string]: JsonValue });
      const kind = arr ? 'array' : 'object';
      if (entries.length === 0) {
        rows.push({ path, key, depth, kind, display: arr ? '[]' : '{}', hasChildren: false });
        return;
      }
      if (visited.has(value as object)) {
        rows.push({ path, key, depth, kind, display: '…', hasChildren: false });
        return;
      }
      visited.add(value as object);
      rows.push({ path, key, depth, kind, hasChildren: true, count: entries.length });
      if (collapsed[path] === true) return;
      for (const [childKey, childVal] of entries) {
        walk(childKey, `${path}.${childKey}`, childVal, depth + 1);
      }
      return;
    }
    rows.push({ path, key, depth, kind: 'scalar', display: formatScalar(value), hasChildren: false });
  };

  for (const [key, value] of Object.entries(node.props)) {
    walk(key, key, value, 0);
  }

  return { id: node.id, type: node.type, rows };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/code/bloom.wt/property-inspector/studio/frontend && npx vitest run src/plugins/property-inspector/inspect.spec.ts`
Expected: PASS (all 9 tests green).

- [ ] **Step 5: Commit**

```bash
cd C:/code/bloom.wt/property-inspector
git add studio/frontend/src/plugins/property-inspector/inspect.ts studio/frontend/src/plugins/property-inspector/inspect.spec.ts
git commit -m "feat(inspector): pure inspectSelection prop-tree helper (#88)"
```

---

## Task 2: State slice + `InspectorPane.tsx`

The plugin's collapse-state slice and the React pane that renders the header, prop rows, and empty state. The slice is scaffolding the pane needs, so they ship together.

**Files:**

- Create: `studio/frontend/src/plugins/property-inspector/state.ts`
- Create: `studio/frontend/src/plugins/property-inspector/InspectorPane.tsx`
- Test: `studio/frontend/src/plugins/property-inspector/InspectorPane.spec.tsx`

**Interfaces:**

- Consumes: `inspectSelection`, `IPropRow` from `./inspect` (Task 1); `gameHooks`, `IGameDocument` from `../game/state`; `sceneGraphHooks` from `../scene-graph/state`; `bumpRenderCount` from `../../app/renderCount`; `makePluginHooks` from `../../state/makePluginHooks`; `rootStore` from `../../state/rootStore`.
- Produces (Task 3 relies on these): `PROPERTY_INSPECTOR_PLUGIN_ID` (`'property-inspector'`), `interface IPropertyInspectorState { collapsed: Record<string, boolean> }`, `function makeInitialState(): IPropertyInspectorState`, `propertyInspectorHooks`, `propertyInspectorSlice()`, and the React component `InspectorPane`.

- [ ] **Step 1: Create the state slice**

Create `studio/frontend/src/plugins/property-inspector/state.ts` (mirrors `scene-graph/state.ts`):

```ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const PROPERTY_INSPECTOR_PLUGIN_ID = 'property-inspector';

export interface IPropertyInspectorState {
  collapsed: Record<string, boolean>; // prop path -> true when collapsed; absent = expanded
}

export function makeInitialState(): IPropertyInspectorState {
  return { collapsed: {} };
}

export const propertyInspectorHooks = makePluginHooks<IPropertyInspectorState>(PROPERTY_INSPECTOR_PLUGIN_ID);

export function propertyInspectorSlice(): State<IPropertyInspectorState> {
  return rootStore.plugins.nested(PROPERTY_INSPECTOR_PLUGIN_ID) as unknown as State<IPropertyInspectorState>;
}
```

- [ ] **Step 2: Write the failing pane test**

Create `studio/frontend/src/plugins/property-inspector/InspectorPane.spec.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState as makeGameState, type IGameDocument } from '../game/state';
import { SCENE_GRAPH_PLUGIN_ID, sceneGraphSlice, makeInitialState as makeSceneGraphState } from '../scene-graph/state';
import { PROPERTY_INSPECTOR_PLUGIN_ID, makeInitialState } from './state';
import { InspectorPane } from './InspectorPane';

const fakeProps = {} as Parameters<typeof InspectorPane>[0];

const fixture: IGameDocument = {
  version: 1,
  nodes: {
    s1: { id: 's1', type: 'Sprite', props: { name: 'hero', x: 120, tint: { r: 255, g: 0, b: 0 } } },
  },
  edges: [],
};

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeGameState() as never);
  rootStore.plugins.nested(SCENE_GRAPH_PLUGIN_ID).set(makeSceneGraphState() as never);
  rootStore.plugins.nested(PROPERTY_INSPECTOR_PLUGIN_ID).set(makeInitialState() as never);
});

describe('InspectorPane', () => {
  it('shows an empty state when nothing is selected', () => {
    act(() => gameSlice().document.set(fixture as never));
    render(<InspectorPane {...fakeProps} />);
    expect(screen.getByTestId('inspector-empty')).toBeTruthy();
  });

  it('shows the selected node type, id, and scalar props', () => {
    act(() => gameSlice().document.set(fixture as never));
    act(() => sceneGraphSlice().selectedId.set('s1'));
    render(<InspectorPane {...fakeProps} />);
    expect(screen.getByTestId('inspector-type').textContent).toBe('Sprite');
    expect(screen.getByTestId('inspector-id').textContent).toBe('s1');
    expect(screen.getByTestId('inspector-prop-name').textContent).toContain('hero');
    expect(screen.getByTestId('inspector-prop-x').textContent).toContain('120');
  });

  it('renders nested children and collapses them on caret click', () => {
    act(() => gameSlice().document.set(fixture as never));
    act(() => sceneGraphSlice().selectedId.set('s1'));
    render(<InspectorPane {...fakeProps} />);
    expect(screen.getByTestId('inspector-prop-tint.r')).toBeTruthy();
    fireEvent.click(screen.getByTestId('inspector-toggle-tint'));
    expect(screen.queryByTestId('inspector-prop-tint.r')).toBeNull();
    expect(screen.getByTestId('inspector-prop-tint')).toBeTruthy(); // branch row itself still shown
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd C:/code/bloom.wt/property-inspector/studio/frontend && npx vitest run src/plugins/property-inspector/InspectorPane.spec.tsx`
Expected: FAIL — `InspectorPane` is not exported / module not found.

- [ ] **Step 4: Write the pane**

Create `studio/frontend/src/plugins/property-inspector/InspectorPane.tsx` (mirrors `SceneGraphPane.tsx` structure):

```tsx
import type { IDockviewPanelProps } from 'dockview-react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { gameHooks, type IGameDocument } from '../game/state';
import { sceneGraphHooks } from '../scene-graph/state';
import { propertyInspectorHooks } from './state';
import { inspectSelection, type IPropRow } from './inspect';
import { bumpRenderCount } from '../../app/renderCount';

export function InspectorPane(_props: IDockviewPanelProps) {
  const game = gameHooks.usePluginState();
  const sg = sceneGraphHooks.usePluginState();
  const pi = propertyInspectorHooks.usePluginState();
  bumpRenderCount('InspectorPane');

  const doc = game.document.get({ noproxy: true }) as IGameDocument;
  const selectedId = sg.selectedId.get();
  const collapsed = pi.collapsed.get({ noproxy: true }) as Record<string, boolean>;
  const view = inspectSelection(doc, selectedId, collapsed);

  if (!view) {
    return (
      <div data-testid="inspector-empty" className="flex h-full items-center justify-center bg-surface text-muted-foreground">
        No node selected.
      </div>
    );
  }

  const toggle = (path: string) => pi.collapsed.set((c) => ({ ...c, [path]: !c[path] }));

  return (
    <div data-testid="inspector-pane" className="h-full overflow-auto bg-surface text-sm">
      <div className="flex items-center gap-4 border-b border-hairline px-3 py-2">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Type</span>
          <span data-testid="inspector-type" className="text-foreground">
            {view.type}
          </span>
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Id</span>
          <span data-testid="inspector-id" className="truncate text-foreground">
            {view.id}
          </span>
        </div>
      </div>
      <div className="py-1">
        {view.rows.map((row) => (
          <PropRow key={row.path} row={row} collapsed={collapsed[row.path] === true} onToggle={toggle} />
        ))}
      </div>
    </div>
  );
}

function PropRow(props: { row: IPropRow; collapsed: boolean; onToggle: (path: string) => void }) {
  const { row, collapsed, onToggle } = props;
  const summary = row.kind === 'array' ? `[${row.count ?? 0}]` : `{${row.count ?? 0}}`;
  return (
    <div
      data-testid={`inspector-prop-${row.path}`}
      className="flex items-center gap-1 py-0.5 pr-2 text-foreground"
      style={{ paddingLeft: `${8 + row.depth * 14}px` }}
    >
      {row.hasChildren && row.count ? (
        <button
          data-testid={`inspector-toggle-${row.path}`}
          onClick={() => onToggle(row.path)}
          className="flex h-4 w-4 items-center justify-center"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      ) : (
        <span className="inline-block h-4 w-4" />
      )}
      <span className="text-muted-foreground">{row.key}</span>
      {row.hasChildren && row.count ? <span className="text-faint">{summary}</span> : <span className="truncate">{row.display}</span>}
    </div>
  );
}
```

Note: `row.hasChildren && row.count` gates the caret so an empty `{}`/`[]` leaf (which has `hasChildren: false`) shows its `display` instead, and a non-empty branch always has `count > 0`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd C:/code/bloom.wt/property-inspector/studio/frontend && npx vitest run src/plugins/property-inspector/InspectorPane.spec.tsx`
Expected: PASS (3 tests green).

- [ ] **Step 6: Commit**

```bash
cd C:/code/bloom.wt/property-inspector
git add studio/frontend/src/plugins/property-inspector/state.ts studio/frontend/src/plugins/property-inspector/InspectorPane.tsx studio/frontend/src/plugins/property-inspector/InspectorPane.spec.tsx
git commit -m "feat(inspector): collapse-state slice + InspectorPane (#88)"
```

---

## Task 3: Plugin definition + registration

Define the `IPlugin` and register it in the studio's `PLUGINS` array so the pane and command are available in the running app.

**Files:**

- Create: `studio/frontend/src/plugins/property-inspector/index.ts`
- Create: `studio/frontend/src/plugins/property-inspector/index.spec.ts`
- Modify: `studio/frontend/src/plugins/index.ts`

**Interfaces:**

- Consumes: `InspectorPane` from `./InspectorPane` (Task 2); `PROPERTY_INSPECTOR_PLUGIN_ID`, `makeInitialState`, `IPropertyInspectorState` from `./state` (Task 2); `IPlugin` from `../../host/types`.
- Produces: `export const propertyInspector: IPlugin<IPropertyInspectorState>` — appended to `PLUGINS`.

- [ ] **Step 1: Write the failing registration test**

Create `studio/frontend/src/plugins/property-inspector/index.spec.ts` (mirrors `scene-graph/index.spec.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { propertyInspector } from './index';

describe('propertyInspector plugin', () => {
  it('declares the expected id, pane, and command', () => {
    expect(propertyInspector.id).toBe('property-inspector');
    expect(propertyInspector.panes.map((p) => p.id)).toContain('property-inspector/panel');
    expect(propertyInspector.commands?.map((c) => c.id)).toContain('property-inspector/open');
  });

  it('seeds a non-persistent initial state', () => {
    expect(propertyInspector.persist).toBe(false);
    expect(propertyInspector.initialState).toEqual({ collapsed: {} });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/code/bloom.wt/property-inspector/studio/frontend && npx vitest run src/plugins/property-inspector/index.spec.ts`
Expected: FAIL — `./index` has no `propertyInspector` export.

- [ ] **Step 3: Write the plugin definition**

Create `studio/frontend/src/plugins/property-inspector/index.ts` (mirrors `scene-graph/index.ts`):

```ts
import type { IPlugin } from '../../host/types';
import { InspectorPane } from './InspectorPane';
import { PROPERTY_INSPECTOR_PLUGIN_ID, makeInitialState, type IPropertyInspectorState } from './state';

export const propertyInspector: IPlugin<IPropertyInspectorState> = {
  id: PROPERTY_INSPECTOR_PLUGIN_ID,
  title: 'Inspector',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'property-inspector/panel', title: 'Inspector', component: InspectorPane as never }],
  commands: [{ id: 'property-inspector/open', title: 'Open Inspector', run: (host) => host.openPane('property-inspector/panel') }],
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/code/bloom.wt/property-inspector/studio/frontend && npx vitest run src/plugins/property-inspector/index.spec.ts`
Expected: PASS (2 tests green).

- [ ] **Step 5: Register the plugin in the studio**

Modify `studio/frontend/src/plugins/index.ts`. Add the import alongside the other plugin imports:

```ts
import { propertyInspector } from './property-inspector';
```

And append it to the `PLUGINS` array (after `sceneGraph`):

```ts
export const PLUGINS: IPlugin[] = [demoCounter, demoScratch, llmChat, assets, gdd, game, simulator, tuner, sceneGraph, propertyInspector];
```

- [ ] **Step 6: Run the full frontend unit suite to verify nothing regressed**

Run: `cd C:/code/bloom.wt/property-inspector && npx nx test frontend`
Expected: PASS — the whole suite green, including the three new spec files.

- [ ] **Step 7: Commit**

```bash
cd C:/code/bloom.wt/property-inspector
git add studio/frontend/src/plugins/property-inspector/index.ts studio/frontend/src/plugins/property-inspector/index.spec.ts studio/frontend/src/plugins/index.ts
git commit -m "feat(inspector): register property-inspector plugin (#88)"
```

---

## Task 4: Run all four frontend gates + open PR

No new code — this task proves the slice is shippable and lands it.

**Files:** none (verification + PR).

- [ ] **Step 1: Prettier**

Run: `cd C:/code/bloom.wt/property-inspector && node_modules/.bin/prettier --check .`
Expected: "All matched files use Prettier code style!" If anything is flagged, run `node_modules/.bin/prettier --write .` on the flagged files, re-check, then `git add -A && git commit -m "style: prettier formatting (#88)"`. Use the pinned `node_modules/.bin/prettier`, NOT `npx prettier` (a fresh worktree's `npx` may pull a newer prettier that disagrees on markdown).

- [ ] **Step 2: Typecheck**

Run: `cd C:/code/bloom.wt/property-inspector && npx nx typecheck frontend`
Expected: PASS, zero type errors. (Vitest passing alone does not prove types are valid — this gate is mandatory.)

- [ ] **Step 3: Unit tests**

Run: `cd C:/code/bloom.wt/property-inspector && npx nx test frontend`
Expected: PASS — whole suite green.

- [ ] **Step 4: Build**

Run: `cd C:/code/bloom.wt/property-inspector && npx nx build frontend`
Expected: build succeeds (this also runs the no-raw-color guard / production build).

- [ ] **Step 5: Push and open the PR**

```bash
cd C:/code/bloom.wt/property-inspector
git push -u origin feat/property-inspector
gh pr create --fill --title "feat(inspector): read-only property-inspector plugin (#88)"
```

The PR body should note: implements issue #88 (deferred item 3 of the scene-graph design); read-only nested prop tree reading the `selectedId` + `gameSlice().document` seams; all four frontend gates green; browser e2e not run (per CI cost policy — this slice has no e2e specs and does not touch existing ones).

---

## Self-Review

**Spec coverage** (each spec section → task):

- Pane `property-inspector/panel` + command `property-inspector/open` → Task 3.
- `inspect.ts` `inspectSelection` (null cases, scalar formatting, nested object/array, empty leaf, collapse, cycle guard) → Task 1.
- `state.ts` `{ collapsed }` slice, `persist: false`, does not own `selectedId` → Task 2 (+ asserted in Task 3 index.spec).
- `InspectorPane.tsx` header (TYPE/ID), indented rows, carets, empty state, `bumpRenderCount` → Task 2.
- Two read-only imports (`../scene-graph/state`, `../game/state`) → Tasks 1–2.
- Registration in `plugins/index.ts` → Task 3.
- Testing matrix (inspect.spec / InspectorPane.spec / index.spec) → Tasks 1/2/3.
- Four frontend gates before PR → Task 4.
- Isolation boundary (no client/protocol/backend/scene-graph behavior changes) → honored: only new files + a one-line `PLUGINS` append.
- Out-of-scope items (editing, add/remove, Assets/Data, data edges, persistence) → not implemented, called out in Global Constraints.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. Clean.

**Type consistency:** `IPropRow` / `IInspectorView` / `inspectSelection` signatures defined in Task 1 are consumed verbatim in Task 2's pane; `PROPERTY_INSPECTOR_PLUGIN_ID`, `IPropertyInspectorState`, `makeInitialState`, `propertyInspectorHooks` defined in Task 2 are consumed verbatim in Task 3. `collapsed: Record<string, boolean>` is consistent across slice, helper param, and pane. Pane gates the caret on `row.hasChildren && row.count`, consistent with the helper emitting `count` only for non-empty branches and `hasChildren: false` for empty `{}`/`[]`.
