# Shared scene-store seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the live scene document mirror out of the `game` plugin into a new plugin-neutral `studio/frontend/src/scene/` module (wire types + pure reducers + state slice), consumed by both the `game` and `scene-graph` plugins so neither depends on the other.

**Architecture:** A new leaf module `scene/` owns the document domain and depends on nothing but shared state infra (`rootStore` / `makePluginHooks`). The `game` plugin keeps the socket client, protocol bridge, and session state, and writes the document into the shared slice. The `scene-graph` plugin reads the shared slice instead of importing `../game/state`. This is a **pure refactor** — no observable behavior change; correctness is proven by the existing unit suite + e2e staying green.

**Tech Stack:** TypeScript, React, `@hookstate/core`, nx + vitest, dockview. Spec: `docs/superpowers/specs/2026-06-25-shared-scene-store-seam-design.md`.

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`ISceneDocument`, `IPlugin`). Types already neutral (`INode`, `IEdge`, `IPortRef`, `NodeType`, `EdgeType`, `JsonValue`) keep their names.
- **The rename is `IGameDocument` → `ISceneDocument`.** No other type renames.
- **Pure refactor — zero behavior change.** No new UI, no backend/socket/protocol/runtime changes, no socket/bridge relocation, no UI→backend mutation path (that is #89).
- **Isolation boundary — do not touch:** `runtime/client`, backend `app/scene/*`, the wire protocol. The socket client + protocol bridge **stay in `plugins/game/`**.
- **Preserve dev-only e2e hooks** in `game/socketClient.ts` verbatim (`window.__gameSceneSnapshot`, `__gameApplyInbound`, `__gameJoinScene`) and in `game/actions.ts` (`__gameActiveId`).
- **All four frontend gates must pass before the PR:** `npx prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`. vitest passing alone does not prove types/build.
- Per-file test runs use vitest from the frontend project: `cd studio/frontend && npx vitest run <path-relative-to-studio/frontend>`.
- Commits use Conventional Commits; end the body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Setup (run once before Task 1)

This worktree (`C:/code/bloom.wt/scene-store-seam`) has **no `node_modules`** until installed (deps live in the primary checkout). From the worktree root:

```bash
npm install
```

Verify the baseline is green before changing anything:

```bash
npx nx test frontend
```

Expected: PASS (404 tests). This is the safety net the refactor must keep green.

---

## Task 1: Create the shared `scene/` module (types + reducers + store)

Additive only — nothing consumes the new module yet, so the existing `game`/`scene-graph` code is untouched and keeps compiling. The new module is fully unit-tested.

**Files:**

- Create: `studio/frontend/src/scene/types.ts`
- Create: `studio/frontend/src/scene/reducers.ts`
- Create: `studio/frontend/src/scene/sceneStore.ts`
- Test: `studio/frontend/src/scene/reducers.spec.ts`
- Test: `studio/frontend/src/scene/sceneStore.spec.ts`

**Interfaces:**

- Produces:
  - `scene/types.ts` → `ISceneDocument`, `INode`, `IEdge`, `IPortRef`, `NodeType`, `EdgeType`, `JsonValue`
  - `scene/reducers.ts` → `ISceneOp`, `emptyDocument(): ISceneDocument`, `applyOpToDocument(doc: ISceneDocument, op: ISceneOp): ISceneDocument`, `loadDocument(doc: ISceneDocument): ISceneDocument`
  - `scene/sceneStore.ts` → `SCENE_STORE_ID = 'scene'`, `ISceneStoreState = { document: ISceneDocument }`, `makeInitialSceneState(): ISceneStoreState`, `sceneHooks` (`makePluginHooks`), `sceneStore(): State<ISceneStoreState>`

- [ ] **Step 1: Create `scene/types.ts`**

```ts
// Structural copy of the engine wire shapes (runtime/client/src/model/document.ts).
// The protocol fixes these; keep them in lockstep with the engine. Plugin-neutral
// home for the scene document domain — consumed by both the game and scene-graph
// plugins so neither depends on the other.
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
export interface ISceneDocument {
  version: number;
  nodes: Record<string, INode>;
  edges: IEdge[];
}
```

- [ ] **Step 2: Create `scene/reducers.ts`** (moves the pure reducers + `emptyDocument` from `game/`, retyped to `ISceneDocument`)

```ts
import type { EdgeType, IEdge, INode, IPortRef, ISceneDocument, JsonValue, NodeType } from './types';

export type ISceneOp =
  | { kind: 'addNode'; id: string; type: NodeType; props?: Record<string, JsonValue> }
  | { kind: 'removeNode'; id: string }
  | { kind: 'setProp'; id: string; path: string; value: JsonValue }
  | { kind: 'connect'; edgeId: string; type: EdgeType; from: IPortRef; to: IPortRef }
  | { kind: 'disconnect'; edgeId: string };

export function emptyDocument(): ISceneDocument {
  return { version: 1, nodes: {}, edges: [] };
}

// Trusting structural applier: the backend has already validated. We only mirror
// the durable document so the iframe can be (re-)initialised from cache.
export function applyOpToDocument(doc: ISceneDocument, op: ISceneOp): ISceneDocument {
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
      // Guard: drop ops that could pollute Object.prototype (mirrors TS engine + Python guard)
      if (op.path.split('.').some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) return doc;
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

export function loadDocument(doc: ISceneDocument): ISceneDocument {
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

- [ ] **Step 3: Create `scene/reducers.spec.ts`** (the moved reducer suite; both helpers now imported from `./reducers`)

```ts
import { describe, it, expect } from 'vitest';
import { emptyDocument, applyOpToDocument } from './reducers';

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

  it('ignores prototype-pollution setProp paths (no Object.prototype mutation)', () => {
    let d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 's', type: 'Sprite' });
    d = applyOpToDocument(d, { kind: 'setProp', id: 's', path: '__proto__', value: { polluted: true } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(d.nodes.s.props).toEqual({});
  });

  it('ignores nested prototype-pollution setProp paths', () => {
    let d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 's', type: 'Sprite' });
    d = applyOpToDocument(d, { kind: 'setProp', id: 's', path: 'a.__proto__.x', value: 1 });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(d.nodes.s.props).toEqual({});
  });

  it('removeNode cascades incident edges', () => {
    let d = emptyDocument();
    for (const id of ['root', 's', 'tex'])
      d = applyOpToDocument(d, { kind: 'addNode', id, type: id === 'tex' ? 'Texture' : id === 'root' ? 'Root' : 'Sprite' });
    d = applyOpToDocument(d, { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } });
    d = applyOpToDocument(d, { kind: 'connect', edgeId: 'e2', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } });
    d = applyOpToDocument(d, { kind: 'removeNode', id: 's' });
    expect(d.nodes.s).toBeUndefined();
    expect(d.edges).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Create `scene/sceneStore.ts`** (the live slice + neutral accessors, mirroring the `gameSlice()`/`gameHooks` pattern)

```ts
import type { State } from '@hookstate/core';
import { rootStore } from '../state/rootStore';
import { makePluginHooks } from '../state/makePluginHooks';
import { emptyDocument } from './reducers';
import type { ISceneDocument } from './types';

export const SCENE_STORE_ID = 'scene';

export interface ISceneStoreState {
  document: ISceneDocument;
}

export function makeInitialSceneState(): ISceneStoreState {
  return { document: emptyDocument() };
}

export const sceneHooks = makePluginHooks<ISceneStoreState>(SCENE_STORE_ID);

export function sceneStore(): State<ISceneStoreState> {
  return rootStore.plugins.nested(SCENE_STORE_ID) as unknown as State<ISceneStoreState>;
}
```

- [ ] **Step 5: Write the failing `scene/sceneStore.spec.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { rootStore } from '../state/rootStore';
import { SCENE_STORE_ID, sceneStore, makeInitialSceneState } from './sceneStore';
import { emptyDocument } from './reducers';

beforeEach(() => {
  rootStore.plugins.nested(SCENE_STORE_ID).set(makeInitialSceneState() as never);
});

describe('sceneStore', () => {
  it('makeInitialSceneState wraps an empty document', () => {
    expect(makeInitialSceneState()).toEqual({ document: { version: 1, nodes: {}, edges: [] } });
  });

  it('seeds an empty document into the slice', () => {
    expect(sceneStore().document.get({ noproxy: true })).toEqual(emptyDocument());
  });

  it('holds a document set through the slice', () => {
    sceneStore().document.set({ version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] } as never);
    expect(sceneStore().document.nodes.get({ noproxy: true })).toHaveProperty('root');
  });
});
```

- [ ] **Step 6: Run the new scene tests**

Run: `cd studio/frontend && npx vitest run src/scene/reducers.spec.ts src/scene/sceneStore.spec.ts`
Expected: PASS (all reducer + sceneStore tests green).

- [ ] **Step 7: Typecheck (the new module must compile)**

Run: `npx nx typecheck frontend`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add studio/frontend/src/scene
git commit -m "refactor(scene): add shared scene store module (types, reducers, slice)"
```

---

## Task 2: Register the headless `scene` plugin to seed the slice

A seed-only `IPlugin` (no panes/commands) registered via the existing `boot.ts` path so the `scene` slice exists before the game socket writes the first snapshot.

**Files:**

- Create: `studio/frontend/src/scene/plugin.ts`
- Test: `studio/frontend/src/scene/plugin.spec.ts`
- Modify: `studio/frontend/src/plugins/index.ts`

**Interfaces:**

- Consumes: `SCENE_STORE_ID`, `makeInitialSceneState`, `ISceneStoreState` from `scene/sceneStore` (Task 1); `IPlugin` from `host/types`.
- Produces: `sceneStorePlugin: IPlugin<ISceneStoreState>`.

- [ ] **Step 1: Write the failing `scene/plugin.spec.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { sceneStorePlugin } from './plugin';

describe('sceneStorePlugin', () => {
  it('is a headless, seed-only plugin for the scene slice', () => {
    expect(sceneStorePlugin.id).toBe('scene');
    expect(sceneStorePlugin.panes).toEqual([]);
    expect(sceneStorePlugin.commands).toBeUndefined();
    expect(sceneStorePlugin.persist).toBe(false);
    expect(sceneStorePlugin.initialState).toEqual({ document: { version: 1, nodes: {}, edges: [] } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd studio/frontend && npx vitest run src/scene/plugin.spec.ts`
Expected: FAIL (`Cannot find module './plugin'`).

- [ ] **Step 3: Create `scene/plugin.ts`**

```ts
import type { IPlugin } from '../host/types';
import { SCENE_STORE_ID, makeInitialSceneState, type ISceneStoreState } from './sceneStore';

// Headless plugin: owns no panes/commands, only seeds the shared scene document
// slice via boot()'s standard initialState path. Registered before `game` so the
// slice exists before the game socket writes the first snapshot.
export const sceneStorePlugin: IPlugin<ISceneStoreState> = {
  id: SCENE_STORE_ID,
  title: 'Scene',
  persist: false,
  initialState: makeInitialSceneState(),
  panes: [],
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd studio/frontend && npx vitest run src/scene/plugin.spec.ts`
Expected: PASS.

- [ ] **Step 5: Register the plugin in `studio/frontend/src/plugins/index.ts`**

Add the import (with the other plugin imports) and prepend `sceneStorePlugin` to the `PLUGINS` array so it seeds before `game`:

```ts
import type { IPlugin } from '../host/types';
import { sceneStorePlugin } from '../scene/plugin';
import { demoCounter } from './demo-counter';
import { demoScratch } from './demo-scratch';
import { llmChat } from './llm-chat';
import { assets } from './assets';
import { gdd } from './gdd';
import { game } from './game';
import { simulator } from './simulator';
import { tuner } from './tuner';
import { sceneGraph } from './scene-graph';

export const PLUGINS: IPlugin[] = [sceneStorePlugin, demoCounter, demoScratch, llmChat, assets, gdd, game, simulator, tuner, sceneGraph];
```

- [ ] **Step 6: Run the full frontend suite (nothing should regress)**

Run: `npx nx test frontend`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/src/scene/plugin.ts studio/frontend/src/scene/plugin.spec.ts studio/frontend/src/plugins/index.ts
git commit -m "refactor(scene): register headless scene-store plugin to seed the slice"
```

---

## Task 3: Migrate the `game` plugin onto the shared store

Atomic switch: `IGameState` drops `document`, the socket/actions/pane/bridge read/write `sceneStore().document`, and the duplicated types/reducers in `game/` are deleted. Must land together to typecheck. Behavior is unchanged.

**Files:**

- Modify: `studio/frontend/src/plugins/game/state.ts`
- Modify: `studio/frontend/src/plugins/game/socketClient.ts`
- Modify: `studio/frontend/src/plugins/game/actions.ts`
- Modify: `studio/frontend/src/plugins/game/GamePreviewPane.tsx`
- Modify: `studio/frontend/src/plugins/game/protocolBridge.ts`
- Delete: `studio/frontend/src/plugins/game/reducers.ts`
- Delete: `studio/frontend/src/plugins/game/reducers.spec.ts`
- Modify: `studio/frontend/src/plugins/game/socketClient.spec.ts`
- Modify: `studio/frontend/src/plugins/game/protocolBridge.spec.ts`

**Interfaces:**

- Consumes: `sceneStore`, `SCENE_STORE_ID`, `makeInitialSceneState` from `scene/sceneStore`; `applyOpToDocument`, `loadDocument`, `emptyDocument`, `ISceneOp` from `scene/reducers`; `ISceneDocument` from `scene/types`.
- Produces: `IGameState = { connection, activeGameId, status }` (no `document`); `gameSlice()`/`gameHooks`/`makeInitialState`/`GAME_PLUGIN_ID` unchanged in name.

- [ ] **Step 1: Update the game tests first (red)** — point them at the shared store.

In `studio/frontend/src/plugins/game/socketClient.spec.ts`, replace the imports + `beforeEach` and the three `gameSlice().document` assertions:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState } from './state';
import { SCENE_STORE_ID, sceneStore, makeInitialSceneState } from '../../scene/sceneStore';
import { applyInbound } from './socketClient';
import { setBridge, ProtocolBridge } from './protocolBridge';

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeInitialState() as never);
  rootStore.plugins.nested(SCENE_STORE_ID).set(makeInitialSceneState() as never);
  gameSlice().activeGameId.set('g1');
});
```

Then change each `expect(gameSlice().document...)` to `expect(sceneStore().document...)` (three occurrences — the `toHaveProperty('root')`, `toHaveProperty('s')`, and `not.toHaveProperty('s')` lines).

In `studio/frontend/src/plugins/game/protocolBridge.spec.ts`, change line 3 only:

```ts
import { emptyDocument } from '../../scene/reducers';
```

- [ ] **Step 2: Run the game tests to verify they fail**

Run: `cd studio/frontend && npx vitest run src/plugins/game/socketClient.spec.ts src/plugins/game/protocolBridge.spec.ts`
Expected: FAIL (`sceneStore`/`../../scene/reducers` resolve, but `socketClient`/`actions` still write `gameSlice().document`, so the `sceneStore().document` assertions fail; types may also error because `IGameState` still has `document`).

- [ ] **Step 3: Trim `game/state.ts`** to session-only state (remove wire types, `emptyDocument`, and the `document` field)

```ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const GAME_PLUGIN_ID = 'game';

export interface IGameState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  status: 'idle' | 'loading' | 'error';
}

export function makeInitialState(): IGameState {
  return {
    connection: 'disconnected',
    activeGameId: null,
    status: 'idle',
  };
}

export const gameHooks = makePluginHooks<IGameState>(GAME_PLUGIN_ID);

export function gameSlice(): State<IGameState> {
  return rootStore.plugins.nested(GAME_PLUGIN_ID) as unknown as State<IGameState>;
}
```

- [ ] **Step 4: Delete the moved reducer files**

```bash
git rm studio/frontend/src/plugins/game/reducers.ts studio/frontend/src/plugins/game/reducers.spec.ts
```

- [ ] **Step 5: Rewrite `game/socketClient.ts`** to read/write the shared store (the `createGameSocket`/`gameSock` block below the rewrite is unchanged — keep the dev-only `window.__*` hooks verbatim)

Replace the imports and `applyInbound`:

```ts
import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { gameSlice } from './state';
import { sceneStore } from '../../scene/sceneStore';
import type { ISceneDocument } from '../../scene/types';
import { applyOpToDocument, loadDocument, type ISceneOp } from '../../scene/reducers';
import { getBridge } from './protocolBridge';

let sock: Socket | null = null;

function isActive(gameId: string): boolean {
  return gameSlice().activeGameId.get() === gameId;
}

export function applyInbound(event: 'scene_snapshot' | 'scene_op', payload: unknown): void {
  if (event === 'scene_snapshot') {
    const p = payload as { gameId: string; document: ISceneDocument };
    if (!isActive(p.gameId)) return;
    const doc = loadDocument(p.document);
    sceneStore().document.set(doc as never);
    const bridge = getBridge();
    bridge?.init(doc);
  } else {
    const p = payload as { gameId: string; op: ISceneOp };
    if (!isActive(p.gameId)) return;
    const current = sceneStore().document.get({ noproxy: true }) as ISceneDocument;
    sceneStore().document.set(applyOpToDocument(current, p.op) as never);
    getBridge()?.op(p.op);
  }
}
```

Leave everything from `export function createGameSocket()` to the end of the file unchanged.

- [ ] **Step 6: Rewrite `game/actions.ts`** to reset the shared document

```ts
import { gameSlice } from './state';
import { sceneStore } from '../../scene/sceneStore';
import { emptyDocument } from '../../scene/reducers';
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
  if (!import.meta.env.PROD) (window as unknown as { __gameActiveId?: string | null }).__gameActiveId = gameId;
  sceneStore().document.set(emptyDocument() as never);
  s.status.set('loading');
  gameSock().joinScene(gameId); // snapshot arrives over the socket
  s.status.set('idle');
}

export function closeGame(): void {
  const s = gameSlice();
  const prev = s.activeGameId.get();
  if (prev) gameSock().leaveScene(prev);
  s.activeGameId.set(null);
  if (!import.meta.env.PROD) (window as unknown as { __gameActiveId?: string | null }).__gameActiveId = null;
  sceneStore().document.set(emptyDocument() as never);
  s.status.set('idle');
}
```

- [ ] **Step 7: Update `game/GamePreviewPane.tsx`** — read the document from the shared store (session state still via `gameHooks`)

Change the import on line 3:

```ts
import { gameHooks } from './state';
import { sceneStore } from '../../scene/sceneStore';
import type { ISceneDocument } from '../../scene/types';
```

And inside the `onMessage` handler change the document read:

```ts
const doc = sceneStore().document.get({ noproxy: true }) as ISceneDocument;
```

(Everything else — `gameHooks.usePluginState()`, `activeGameId`, the iframe `src`, the effect — is unchanged.)

- [ ] **Step 8: Update `game/protocolBridge.ts`** imports (types only; behavior unchanged)

Change lines 1–2:

```ts
import type { ISceneDocument } from '../../scene/types';
import type { ISceneOp } from '../../scene/reducers';
```

Then replace the two `IGameDocument` references with `ISceneDocument` (the `init` envelope member `document?: IGameDocument` and the `init(document: IGameDocument)` method signature).

- [ ] **Step 9: Run the game tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/plugins/game`
Expected: PASS (socketClient, protocolBridge, GamePreviewPane, index, config specs all green).

- [ ] **Step 10: Typecheck the whole frontend**

Run: `npx nx typecheck frontend`
Expected: PASS. (`scene-graph` still imports `../game/state` types here — those names no longer exist in `game/state.ts`, so this WILL report errors in `buildTree.ts` / `SceneGraphPane.tsx` / their specs. That is expected and fixed in Task 4. Confirm the ONLY errors are in `scene-graph/`; if any error is inside `game/` or `scene/`, fix it before committing.)

- [ ] **Step 11: Commit**

```bash
git add studio/frontend/src/plugins/game
git commit -m "refactor(game): consume shared scene store; drop document from game slice"
```

---

## Task 4: Migrate the `scene-graph` plugin onto the shared store

Removes the last `../game/state` import. The plugin's own slice (`selectedId`/`collapsed`) is untouched.

**Files:**

- Modify: `studio/frontend/src/plugins/scene-graph/buildTree.ts`
- Modify: `studio/frontend/src/plugins/scene-graph/SceneGraphPane.tsx`
- Modify: `studio/frontend/src/plugins/scene-graph/buildTree.spec.ts`
- Modify: `studio/frontend/src/plugins/scene-graph/SceneGraphPane.spec.tsx`

**Interfaces:**

- Consumes: `ISceneDocument`, `NodeType` from `scene/types`; `sceneHooks`, `sceneStore`, `SCENE_STORE_ID`, `makeInitialSceneState` from `scene/sceneStore`.

- [ ] **Step 1: Update the scene-graph tests first (red)**

In `studio/frontend/src/plugins/scene-graph/buildTree.spec.ts`, change line 2:

```ts
import type { ISceneDocument } from '../../scene/types';
```

and the helper signature:

```ts
function doc(partial: Partial<ISceneDocument>): ISceneDocument {
  return { version: 1, nodes: {}, edges: [], ...partial };
}
```

In `studio/frontend/src/plugins/scene-graph/SceneGraphPane.spec.tsx`, replace the game imports/seeding with the shared store. New header through `beforeEach`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { SCENE_STORE_ID, sceneStore, makeInitialSceneState } from '../../scene/sceneStore';
import type { ISceneDocument } from '../../scene/types';
import { SCENE_GRAPH_PLUGIN_ID, sceneGraphSlice, makeInitialState } from './state';
import { SceneGraphPane } from './SceneGraphPane';

const fakeProps = {} as Parameters<typeof SceneGraphPane>[0];

const fixture: ISceneDocument = {
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
  rootStore.plugins.nested(SCENE_STORE_ID).set(makeInitialSceneState() as never);
  rootStore.plugins.nested(SCENE_GRAPH_PLUGIN_ID).set(makeInitialState() as never);
});
```

Then change the three `act(() => gameSlice().document.set(fixture as never));` lines to `act(() => sceneStore().document.set(fixture as never));`.

- [ ] **Step 2: Run the scene-graph tests to verify they fail**

Run: `cd studio/frontend && npx vitest run src/plugins/scene-graph`
Expected: FAIL (`SceneGraphPane.tsx` still reads `gameHooks`, so the rendered rows are empty against the new `sceneStore` fixture; `buildTree.ts` type import may also error).

- [ ] **Step 3: Update `buildTree.ts`** import + signature

Change line 1:

```ts
import type { ISceneDocument, NodeType } from '../../scene/types';
```

and the signature:

```ts
export function buildTree(doc: ISceneDocument, collapsed: Record<string, boolean> = {}): ITreeRow[] {
```

(The body is unchanged.)

- [ ] **Step 4: Update `SceneGraphPane.tsx`** to read the shared store

Change the imports on line 3 (remove `../game/state`):

```ts
import { sceneHooks } from '../../scene/sceneStore';
import type { ISceneDocument, NodeType } from '../../scene/types';
```

Then in the component body replace the game read:

```ts
const scene = sceneHooks.usePluginState();
const sg = sceneGraphHooks.usePluginState();
bumpRenderCount('SceneGraphPane');

const doc = scene.document.get({ noproxy: true }) as ISceneDocument;
```

(`NodeType` is still used by the `ICON` map; everything else in the file is unchanged.)

- [ ] **Step 5: Run the scene-graph tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/plugins/scene-graph`
Expected: PASS (empty-state, row render, select, collapse all green).

- [ ] **Step 6: Confirm the `../game/state` import is gone from scene-graph**

Run: `grep -rn "game/state" studio/frontend/src/plugins/scene-graph` (or the Grep tool)
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/src/plugins/scene-graph
git commit -m "refactor(scene-graph): consume shared scene store; drop game import"
```

---

## Task 5: Whole-suite verification + format

No new code — prove the refactor is complete and invisible.

**Files:** none (verification only; a format-only commit if prettier rewrites anything).

- [ ] **Step 1: Confirm no stale references remain**

Run (Grep tool, scope `studio/frontend/src`):

- `IGameDocument` → expect **no matches**.
- `gameSlice().document` → expect **no matches**.
- `plugins/game/reducers` → expect **no matches**.

If any match exists, fix it before proceeding.

- [ ] **Step 2: Run all four frontend gates from the worktree root**

```bash
npx prettier --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
```

Expected: all PASS. `nx test frontend` should report the same total as the Setup baseline minus the deleted `game/reducers.spec.ts` count plus the new `scene/reducers.spec.ts` + `scene/sceneStore.spec.ts` + `scene/plugin.spec.ts` (net increase; suite green).

- [ ] **Step 3: If prettier flagged files, format and commit**

```bash
npx prettier --write .
git add -A
git commit -m "style(scene): prettier-format scene-store seam"
```

(Skip this commit if `prettier --check` already passed.)

- [ ] **Step 4: Run the e2e suite (real-user proof the mirror relocation is invisible)**

Start a replay backend, then run the Playwright suite (see `docs/worktrees.md` for the per-worktree port offset — this worktree is offset 1, backend `:8001`):

```bash
# terminal A (worktree root)
just backend-serve-replay
# terminal B (worktree root), once /health is reachable
just e2e
```

Expected: PASS. The game-preview and scene-graph client flows are the authoritative proof that moving the document mirror changed nothing observable.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin refactor/scene-store-seam
gh pr create --fill
```

The PR body should note: closes #86; pure refactor (shared `scene/` module); socket/bridge stay in `game`; follow-ups #87/#88/#89 unaffected.

---

## Self-Review

**Spec coverage:**

- Shared `scene/` module (types + reducers + slice) → Task 1. ✓
- `ISceneDocument` rename → Task 1 (defined) + Tasks 3–4 (consumers). ✓
- Headless `scene` plugin seeding via `boot.ts`, ordered before `game` → Task 2. ✓
- `game` keeps socket/bridge/session, writes shared slice; `IGameState` drops `document` → Task 3. ✓
- `scene-graph` consumes `scene/`, drops `../game/state` → Task 4. ✓
- Pure-refactor proof (unit suite + four gates + e2e) → Setup baseline + Task 5. ✓
- Dev-only e2e hooks preserved → Task 3 Steps 5–6 (explicit "keep verbatim"). ✓
- Isolation boundary (no runtime/backend/protocol, socket/bridge stay) → Global Constraints + Task 3 scope. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete content. ✓

**Type consistency:** `ISceneDocument`/`ISceneOp`/`ISceneStoreState`/`SCENE_STORE_ID`/`sceneStore`/`sceneHooks`/`makeInitialSceneState`/`sceneStorePlugin` used identically across Tasks 1–4. `gameSlice`/`gameHooks`/`makeInitialState`/`GAME_PLUGIN_ID` retain their names. Import path from `plugins/game/*` and `plugins/scene-graph/*` to the new module is `../../scene/*`; from `scene/*` to state infra is `../state/*`. ✓
