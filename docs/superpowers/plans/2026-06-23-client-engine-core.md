# Client Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone Bloom client engine — a node-graph runtime in `runtime/client/` that materializes a structured game document into a live Pixi scene and mutates it incrementally over a versioned `postMessage` protocol, with zero studio coupling.

**Architecture:** A pure `GraphModel` (the source of truth) applies validated ops and emits change records; a `Reconciler` turns change records into calls on a narrow `IRenderer` seam; `PixiRenderer` is the one Pixi implementation; a `ProtocolHost` exposes the engine over `postMessage` (handshake + ops + acks). The same bundle runs embedded in an iframe (driven by the protocol) or standalone (driven by a document file). This plan is **Plan 1 of 2** — Plan 2 (studio integration: backend `scene.*` tools + persistence, frontend iframe host + protocol bridge) consumes the protocol/op contract defined here.

**Tech Stack:** TypeScript (strict), Pixi.js v8, Vite, Vitest (unit), Playwright (e2e), Nx (TS project orchestration).

## Global Constraints

- **Component lives in `runtime/client/`** — a new Nx TS project. It MUST NOT import from `studio/` (platform dependency rule: nothing depends on `studio/`).
- **Zero AI, zero studio coupling** — the engine speaks only the op protocol; no socket.io, no backend URLs, no React.
- **TypeScript interfaces use the `I` prefix** (`IRenderer`, `INode`) per `docs/coding-standards.md`. Op/change discriminated-union member types use a descriptive name + `kind` field.
- **Pixi.js `^8`** — `Application.init()` is async; load textures via `Assets.load(url)` (not `Texture.from(url)`).
- **TDD mandatory** — RED → GREEN → REFACTOR per task; commit at each task boundary.
- **Browser e2e (Playwright) is NOT run in CI** — runs locally only. Unit tests (Vitest) are CI-affordable.
- **Prettier is a gate** — `npx prettier --check .` must pass before any commit (run `npx prettier --write .` on touched files first).
- **All commands run from the worktree** `C:\code\bloom.wt\client-engine` on branch `feat/client-engine`.
- **Protocol version is `1`** from day one; the envelope carries `v: 1`.

---

## File Structure

```
runtime/client/
├─ project.json                 # Nx project (name: "client")
├─ tsconfig.json                # references app + spec
├─ tsconfig.app.json
├─ tsconfig.spec.json
├─ vite.config.mts              # serve :4300, vitest config
├─ playwright.config.ts         # e2e (local only)
├─ index.html                   # engine entry page (mounts canvas, boots engine)
├─ src/
│  ├─ main.ts                   # bootstrap: wires model + renderer + reconciler + protocol; standalone load
│  ├─ model/
│  │  ├─ document.ts            # IGameDocument, INode, IEdge, IPortRef, NodeType, EdgeType, JsonValue, emptyDocument()
│  │  ├─ ops.ts                 # Op union, OpError
│  │  ├─ changes.ts             # IChange union
│  │  └─ graphModel.ts          # GraphModel (apply / applyBatch / load / read API / toDocument)
│  ├─ render/
│  │  ├─ renderer.ts            # IRenderer interface, ITextureHandle
│  │  ├─ mockRenderer.ts        # test double recording calls
│  │  ├─ reconciler.ts          # Reconciler.applyChanges()
│  │  └─ pixiRenderer.ts        # PixiRenderer implements IRenderer
│  └─ protocol/
│     ├─ messages.ts            # envelope types (Inbound/Outbound), PROTOCOL_VERSION
│     └─ protocolHost.ts        # ProtocolHost (handshake, intake, ack/error)
└─ e2e/
   ├─ harness.html              # parent page embedding the engine iframe (test fixture)
   └─ engine.e2e.spec.ts        # boot→ready, ops, standalone load
```

---

### Task 1: Scaffold the `runtime/client` Nx project

**Files:**

- Create: `runtime/client/project.json`
- Create: `runtime/client/tsconfig.json`, `runtime/client/tsconfig.app.json`, `runtime/client/tsconfig.spec.json`
- Create: `runtime/client/vite.config.mts`
- Create: `runtime/client/index.html`
- Create: `runtime/client/src/main.ts`
- Create: `runtime/client/src/smoke.spec.ts`
- Modify: `package.json` (root) — add `pixi.js`

**Interfaces:**

- Consumes: nothing.
- Produces: an Nx project named `client` with inferred `serve`/`build`/`typecheck` targets (via `@nx/vite/plugin`) and a `test` target running Vitest.

- [ ] **Step 1: Add Pixi to root deps**

Run from the worktree:

```bash
npm install pixi.js@^8
```

Expected: `pixi.js` appears under `dependencies` in root `package.json`; `package-lock.json` updates.

- [ ] **Step 2: Create the project config files**

`runtime/client/project.json`:

```json
{
  "name": "client",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "runtime/client/src",
  "projectType": "application",
  "tags": [],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "cwd": "runtime/client",
        "command": "npx vitest run"
      }
    }
  }
}
```

`runtime/client/tsconfig.json`:

```json
{
  "compilerOptions": {
    "allowJs": false,
    "esModuleInterop": false,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "types": ["vite/client"],
    "baseUrl": "."
  },
  "files": [],
  "include": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.spec.json" }],
  "extends": "../../tsconfig.base.json"
}
```

`runtime/client/tsconfig.app.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "../../dist/out-tsc",
    "types": ["node", "vite/client"]
  },
  "exclude": ["src/**/*.spec.ts", "src/**/*.test.ts"],
  "include": ["src/**/*.ts"]
}
```

`runtime/client/tsconfig.spec.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "../../dist/out-tsc",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.spec.ts", "src/**/*.test.ts", "e2e/**/*.ts"]
}
```

`runtime/client/vite.config.mts`:

```ts
/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/runtime/client',
  server: { port: 4300, host: '0.0.0.0' },
  preview: { port: 4300, host: '0.0.0.0' },
  plugins: [nxViteTsPaths()],
  build: {
    outDir: '../../dist/runtime/client',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{spec,test}.ts'],
    reporters: ['default'],
  },
}));
```

`runtime/client/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bloom Client Engine</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        background: #0b0b0c;
      }
      #stage {
        width: 100vw;
        height: 100vh;
      }
    </style>
  </head>
  <body>
    <div id="stage"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`runtime/client/src/main.ts` (placeholder for now — fleshed out in Task 13):

```ts
// Bootstrap is assembled in Task 13. Keep a no-op entry so `nx serve` works.
export {};
```

- [ ] **Step 3: Write the smoke test**

`runtime/client/src/smoke.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('client engine project', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Run the smoke test (expect PASS) and verify Nx sees the project**

Run:

```bash
npx nx test client
npx nx show project client --json
```

Expected: the test passes; `nx show project` lists inferred targets including `serve`, `build`, `typecheck`, plus the `test` target.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
npx prettier --check .
git add runtime/client package.json package-lock.json
git commit -m "feat(client): scaffold runtime/client Nx project with Pixi"
```

---

### Task 2: Document & op type definitions

**Files:**

- Create: `runtime/client/src/model/document.ts`
- Create: `runtime/client/src/model/ops.ts`
- Create: `runtime/client/src/model/changes.ts`
- Test: `runtime/client/src/model/document.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type NodeType = 'Root' | 'Container' | 'Sprite' | 'Texture'`
  - `type EdgeType = 'child' | 'data'`
  - `type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }`
  - `interface IPortRef { node: string; port: string }`
  - `interface INode { id: string; type: NodeType; props: Record<string, JsonValue> }`
  - `interface IEdge { id: string; type: EdgeType; from: IPortRef; to: IPortRef }`
  - `interface IGameDocument { version: number; nodes: Record<string, INode>; edges: IEdge[] }`
  - `function emptyDocument(): IGameDocument`
  - `type Op` (union, see code), `class OpError extends Error { code: string }`
  - `type IChange` (union, see code)

- [ ] **Step 1: Write the failing test**

`runtime/client/src/model/document.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyDocument } from './document';

describe('emptyDocument', () => {
  it('is version 1 with no nodes or edges', () => {
    const doc = emptyDocument();
    expect(doc.version).toBe(1);
    expect(doc.nodes).toEqual({});
    expect(doc.edges).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `Cannot find module './document'`.

- [ ] **Step 3: Write the types + factory**

`runtime/client/src/model/document.ts`:

```ts
export type NodeType = 'Root' | 'Container' | 'Sprite' | 'Texture';
export type EdgeType = 'child' | 'data';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

export function emptyDocument(): IGameDocument {
  return { version: 1, nodes: {}, edges: [] };
}

export const NODE_TYPES: readonly NodeType[] = ['Root', 'Container', 'Sprite', 'Texture'];
export const EDGE_TYPES: readonly EdgeType[] = ['child', 'data'];
```

`runtime/client/src/model/ops.ts`:

```ts
import type { EdgeType, IPortRef, JsonValue, NodeType } from './document';

export type Op =
  | { kind: 'addNode'; id: string; type: NodeType; props?: Record<string, JsonValue> }
  | { kind: 'removeNode'; id: string }
  | { kind: 'setProp'; id: string; path: string; value: JsonValue }
  | { kind: 'connect'; edgeId: string; type: EdgeType; from: IPortRef; to: IPortRef }
  | { kind: 'disconnect'; edgeId: string };

export class OpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpError';
  }
}
```

`runtime/client/src/model/changes.ts`:

```ts
import type { IEdge, INode, JsonValue } from './document';

export type IChange =
  | { kind: 'nodeCreated'; node: INode }
  | { kind: 'nodeRemoved'; id: string }
  | { kind: 'propSet'; id: string; path: string; value: JsonValue }
  | { kind: 'parentSet'; childId: string; parentId: string | null }
  | { kind: 'dataBound'; edge: IEdge }
  | { kind: 'dataUnbound'; edge: IEdge };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): document, op, and change type definitions"
```

---

### Task 3: GraphModel — addNode / removeNode

**Files:**

- Create: `runtime/client/src/model/graphModel.ts`
- Test: `runtime/client/src/model/graphModel.nodes.spec.ts`

**Interfaces:**

- Consumes: `Op`, `OpError` (Task 2); `IChange` (Task 2); `INode`, `IEdge`, `IGameDocument` (Task 2).
- Produces (partial `GraphModel`, extended in Tasks 4–6):
  - `class GraphModel`
  - `apply(op: Op): IChange[]` — validates, mutates, returns change records; throws `OpError` on invalid op (model unchanged).
  - `getNode(id: string): INode | undefined`
  - `toDocument(): IGameDocument`

- [ ] **Step 1: Write the failing test**

`runtime/client/src/model/graphModel.nodes.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from './graphModel';
import { OpError } from './ops';

describe('GraphModel addNode/removeNode', () => {
  it('adds a node and emits nodeCreated', () => {
    const m = new GraphModel();
    const changes = m.apply({ kind: 'addNode', id: 'sprite.a', type: 'Sprite', props: { alpha: 1 } });
    expect(changes).toEqual([{ kind: 'nodeCreated', node: { id: 'sprite.a', type: 'Sprite', props: { alpha: 1 } } }]);
    expect(m.getNode('sprite.a')).toEqual({ id: 'sprite.a', type: 'Sprite', props: { alpha: 1 } });
  });

  it('defaults props to {} when omitted', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 'root', type: 'Root' });
    expect(m.getNode('root')).toEqual({ id: 'root', type: 'Root', props: {} });
  });

  it('rejects a duplicate id without mutating', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 'x', type: 'Container' });
    expect(() => m.apply({ kind: 'addNode', id: 'x', type: 'Sprite' })).toThrow(OpError);
    expect(m.getNode('x')?.type).toBe('Container');
  });

  it('rejects an unknown node type', () => {
    const m = new GraphModel();
    expect(() => m.apply({ kind: 'addNode', id: 'x', type: 'Nope' as never })).toThrow(OpError);
  });

  it('removes a node and emits nodeRemoved', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 'x', type: 'Sprite' });
    const changes = m.apply({ kind: 'removeNode', id: 'x' });
    expect(changes).toEqual([{ kind: 'nodeRemoved', id: 'x' }]);
    expect(m.getNode('x')).toBeUndefined();
  });

  it('rejects removing an unknown node', () => {
    const m = new GraphModel();
    expect(() => m.apply({ kind: 'removeNode', id: 'ghost' })).toThrow(OpError);
  });

  it('toDocument reflects current nodes', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 'x', type: 'Sprite' });
    expect(m.toDocument()).toEqual({ version: 1, nodes: { x: { id: 'x', type: 'Sprite', props: {} } }, edges: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `Cannot find module './graphModel'`.

- [ ] **Step 3: Write the minimal implementation**

`runtime/client/src/model/graphModel.ts`:

```ts
import { NODE_TYPES, type IEdge, type IGameDocument, type INode } from './document';
import { OpError, type Op } from './ops';
import type { IChange } from './changes';

export class GraphModel {
  private nodes = new Map<string, INode>();
  private edges = new Map<string, IEdge>();

  apply(op: Op): IChange[] {
    switch (op.kind) {
      case 'addNode':
        return this.addNode(op.id, op.type, op.props);
      case 'removeNode':
        return this.removeNode(op.id);
      default:
        throw new OpError('unknown_op', `unknown op kind: ${(op as { kind: string }).kind}`);
    }
  }

  getNode(id: string): INode | undefined {
    return this.nodes.get(id);
  }

  toDocument(): IGameDocument {
    const nodes: Record<string, INode> = {};
    for (const [id, n] of this.nodes) nodes[id] = { id: n.id, type: n.type, props: { ...n.props } };
    return { version: 1, nodes, edges: [...this.edges.values()].map((e) => ({ ...e })) };
  }

  private addNode(id: string, type: INode['type'], props?: INode['props']): IChange[] {
    if (this.nodes.has(id)) throw new OpError('duplicate_id', `node already exists: ${id}`);
    if (!NODE_TYPES.includes(type)) throw new OpError('bad_type', `unknown node type: ${type}`);
    const node: INode = { id, type, props: { ...(props ?? {}) } };
    this.nodes.set(id, node);
    return [{ kind: 'nodeCreated', node: { id, type, props: { ...node.props } } }];
  }

  private removeNode(id: string): IChange[] {
    if (!this.nodes.has(id)) throw new OpError('unknown_node', `no such node: ${id}`);
    this.nodes.delete(id);
    return [{ kind: 'nodeRemoved', id }];
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): GraphModel addNode/removeNode with validation"
```

---

### Task 4: GraphModel — setProp (nested paths)

**Files:**

- Modify: `runtime/client/src/model/graphModel.ts`
- Test: `runtime/client/src/model/graphModel.props.spec.ts`

**Interfaces:**

- Consumes: `GraphModel` (Task 3).
- Produces: `apply({kind:'setProp', id, path, value})` returns `[{kind:'propSet', id, path, value}]`; supports dotted nested paths (e.g. `position.x`), creating intermediate objects; throws `OpError('unknown_node')` for a missing node.

- [ ] **Step 1: Write the failing test**

`runtime/client/src/model/graphModel.props.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from './graphModel';
import { OpError } from './ops';

describe('GraphModel setProp', () => {
  it('sets a top-level prop and emits propSet', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 's', type: 'Sprite' });
    const changes = m.apply({ kind: 'setProp', id: 's', path: 'alpha', value: 0.5 });
    expect(changes).toEqual([{ kind: 'propSet', id: 's', path: 'alpha', value: 0.5 }]);
    expect(m.getNode('s')?.props.alpha).toBe(0.5);
  });

  it('sets a nested prop, creating intermediate objects', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 's', type: 'Sprite' });
    m.apply({ kind: 'setProp', id: 's', path: 'position.x', value: 240 });
    expect(m.getNode('s')?.props.position).toEqual({ x: 240 });
  });

  it('rejects setProp on a missing node', () => {
    const m = new GraphModel();
    expect(() => m.apply({ kind: 'setProp', id: 'ghost', path: 'alpha', value: 1 })).toThrow(OpError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `setProp` not handled (throws `unknown_op`).

- [ ] **Step 3: Add the setProp branch**

In `graphModel.ts`, add `case 'setProp': return this.setProp(op.id, op.path, op.value);` to the `apply` switch, and add:

```ts
  private setProp(id: string, path: string, value: import('./document').JsonValue): IChange[] {
    const node = this.nodes.get(id);
    if (!node) throw new OpError('unknown_node', `no such node: ${id}`);
    const keys = path.split('.');
    let cursor = node.props as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (typeof cursor[k] !== 'object' || cursor[k] === null) cursor[k] = {};
      cursor = cursor[k] as Record<string, unknown>;
    }
    cursor[keys[keys.length - 1]] = value;
    return [{ kind: 'propSet', id, path, value }];
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): GraphModel setProp with nested path support"
```

---

### Task 5: GraphModel — connect / disconnect (typed edges) + read API

**Files:**

- Modify: `runtime/client/src/model/graphModel.ts`
- Test: `runtime/client/src/model/graphModel.edges.spec.ts`

**Interfaces:**

- Consumes: `GraphModel` (Tasks 3–4).
- Produces:
  - `apply({kind:'connect', edgeId, type, from, to})`:
    - `child` edge (`from` = parent `children` port, `to` = child `parent` port) → `[{kind:'parentSet', childId: to.node, parentId: from.node}]`.
    - `data` edge → `[{kind:'dataBound', edge}]`.
  - `apply({kind:'disconnect', edgeId})`:
    - `child` edge → `[{kind:'parentSet', childId, parentId: null}]`.
    - `data` edge → `[{kind:'dataUnbound', edge}]`.
  - Validation (throws `OpError`): unknown `from`/`to` node; duplicate `edgeId`; child cycle (a node cannot become its own ancestor); a child node already having a parent.
  - `removeNode` now cascades: emits a disconnect-change for every incident edge, then `nodeRemoved`.
  - Read API: `getEdge(id)`, `edgesBySource(nodeId, port?)`, `edgesByTarget(nodeId, port?)`; `toDocument()` includes edges.

- [ ] **Step 1: Write the failing test**

`runtime/client/src/model/graphModel.edges.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from './graphModel';
import { OpError } from './ops';

function withNodes(): GraphModel {
  const m = new GraphModel();
  m.apply({ kind: 'addNode', id: 'root', type: 'Root' });
  m.apply({ kind: 'addNode', id: 'box', type: 'Container' });
  m.apply({ kind: 'addNode', id: 's', type: 'Sprite' });
  m.apply({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: 'asset:1' } });
  return m;
}
const child = (id: string, parent: string, kid: string) =>
  ({ kind: 'connect', edgeId: id, type: 'child', from: { node: parent, port: 'children' }, to: { node: kid, port: 'parent' } }) as const;
const data = (id: string, src: string, dst: string) =>
  ({ kind: 'connect', edgeId: id, type: 'data', from: { node: src, port: 'data' }, to: { node: dst, port: 'texture' } }) as const;

describe('GraphModel connect/disconnect', () => {
  it('child connect emits parentSet', () => {
    const m = withNodes();
    expect(m.apply(child('e1', 'root', 'box'))).toEqual([{ kind: 'parentSet', childId: 'box', parentId: 'root' }]);
  });

  it('data connect emits dataBound', () => {
    const m = withNodes();
    const changes = m.apply(data('e2', 'tex', 's'));
    expect(changes).toEqual([{ kind: 'dataBound', edge: { id: 'e2', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } } }]);
  });

  it('child disconnect emits parentSet null', () => {
    const m = withNodes();
    m.apply(child('e1', 'root', 'box'));
    expect(m.apply({ kind: 'disconnect', edgeId: 'e1' })).toEqual([{ kind: 'parentSet', childId: 'box', parentId: null }]);
  });

  it('data disconnect emits dataUnbound', () => {
    const m = withNodes();
    m.apply(data('e2', 'tex', 's'));
    expect(m.apply({ kind: 'disconnect', edgeId: 'e2' })).toEqual([
      { kind: 'dataUnbound', edge: { id: 'e2', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } } },
    ]);
  });

  it('rejects an edge to an unknown node', () => {
    const m = withNodes();
    expect(() => m.apply(child('e1', 'root', 'ghost'))).toThrow(OpError);
  });

  it('rejects a duplicate edge id', () => {
    const m = withNodes();
    m.apply(child('e1', 'root', 'box'));
    expect(() => m.apply(child('e1', 'box', 's'))).toThrow(OpError);
  });

  it('rejects a node gaining two parents', () => {
    const m = withNodes();
    m.apply(child('e1', 'root', 's'));
    expect(() => m.apply(child('e2', 'box', 's'))).toThrow(OpError);
  });

  it('rejects a child cycle', () => {
    const m = withNodes();
    m.apply(child('e1', 'root', 'box'));
    expect(() => m.apply(child('e2', 'box', 'root'))).toThrow(OpError);
  });

  it('removeNode cascades incident edges', () => {
    const m = withNodes();
    m.apply(child('e1', 'root', 'box'));
    m.apply(data('e2', 'tex', 's'));
    m.apply(child('e3', 'box', 's'));
    const changes = m.apply({ kind: 'removeNode', id: 's' });
    expect(changes).toContainEqual({ kind: 'parentSet', childId: 's', parentId: null });
    expect(changes).toContainEqual({
      kind: 'dataUnbound',
      edge: { id: 'e2', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } },
    });
    expect(changes[changes.length - 1]).toEqual({ kind: 'nodeRemoved', id: 's' });
    expect(m.getEdge('e2')).toBeUndefined();
    expect(m.getEdge('e3')).toBeUndefined();
  });

  it('edgesBySource / edgesByTarget filter by node and port', () => {
    const m = withNodes();
    m.apply(data('e2', 'tex', 's'));
    expect(m.edgesBySource('tex', 'data').map((e) => e.id)).toEqual(['e2']);
    expect(m.edgesByTarget('s', 'texture').map((e) => e.id)).toEqual(['e2']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — connect/disconnect not handled.

- [ ] **Step 3: Implement edges + cascade + read API**

In `graphModel.ts`: add `import type { IEdge, IPortRef } from './document';` (extend existing import), add `connect`/`disconnect` cases to `apply`, replace `removeNode` with the cascading version, and add the helpers:

```ts
  // in apply():
  //   case 'connect':    return this.connect(op.edgeId, op.type, op.from, op.to);
  //   case 'disconnect': return this.disconnect(op.edgeId);

  getEdge(id: string): IEdge | undefined {
    return this.edges.get(id);
  }

  edgesBySource(nodeId: string, port?: string): IEdge[] {
    return [...this.edges.values()].filter((e) => e.from.node === nodeId && (port === undefined || e.from.port === port));
  }

  edgesByTarget(nodeId: string, port?: string): IEdge[] {
    return [...this.edges.values()].filter((e) => e.to.node === nodeId && (port === undefined || e.to.port === port));
  }

  private connect(edgeId: string, type: IEdge['type'], from: IPortRef, to: IPortRef): IChange[] {
    if (this.edges.has(edgeId)) throw new OpError('duplicate_edge', `edge already exists: ${edgeId}`);
    if (!this.nodes.has(from.node)) throw new OpError('unknown_node', `no such node: ${from.node}`);
    if (!this.nodes.has(to.node)) throw new OpError('unknown_node', `no such node: ${to.node}`);
    if (type === 'child') {
      const childId = to.node;
      const parentId = from.node;
      if (this.parentOf(childId) !== null) throw new OpError('already_parented', `node already has a parent: ${childId}`);
      if (childId === parentId || this.isAncestor(childId, parentId)) throw new OpError('cycle', `child edge would create a cycle`);
    }
    const edge: IEdge = { id: edgeId, type, from: { ...from }, to: { ...to } };
    this.edges.set(edgeId, edge);
    return [this.edgeChange(edge, true)];
  }

  private disconnect(edgeId: string): IChange[] {
    const edge = this.edges.get(edgeId);
    if (!edge) throw new OpError('unknown_edge', `no such edge: ${edgeId}`);
    this.edges.delete(edgeId);
    return [this.edgeChange(edge, false)];
  }

  private edgeChange(edge: IEdge, bound: boolean): IChange {
    if (edge.type === 'child') return { kind: 'parentSet', childId: edge.to.node, parentId: bound ? edge.from.node : null };
    return bound ? { kind: 'dataBound', edge: { ...edge } } : { kind: 'dataUnbound', edge: { ...edge } };
  }

  private parentOf(childId: string): string | null {
    const e = [...this.edges.values()].find((x) => x.type === 'child' && x.to.node === childId);
    return e ? e.from.node : null;
  }

  private isAncestor(maybeAncestor: string, node: string): boolean {
    let cur: string | null = node;
    while (cur !== null) {
      if (cur === maybeAncestor) return true;
      cur = this.parentOf(cur);
    }
    return false;
  }
```

Replace `removeNode` with the cascading version:

```ts
  private removeNode(id: string): IChange[] {
    if (!this.nodes.has(id)) throw new OpError('unknown_node', `no such node: ${id}`);
    const incident = [...this.edges.values()].filter((e) => e.from.node === id || e.to.node === id);
    const changes: IChange[] = [];
    for (const e of incident) {
      this.edges.delete(e.id);
      changes.push(this.edgeChange(e, false));
    }
    this.nodes.delete(id);
    changes.push({ kind: 'nodeRemoved', id });
    return changes;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS (all edge tests + earlier node/prop tests still green).

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): GraphModel typed edges (connect/disconnect) + cascade + read API"
```

---

### Task 6: GraphModel — applyBatch (transactional) + load(document)

**Files:**

- Modify: `runtime/client/src/model/graphModel.ts`
- Test: `runtime/client/src/model/graphModel.batch.spec.ts`

**Interfaces:**

- Consumes: `GraphModel` (Tasks 3–5).
- Produces:
  - `applyBatch(ops: Op[]): IChange[]` — validates+applies all ops or none (on any `OpError`, restore prior state and rethrow); returns the concatenated change records.
  - `load(doc: IGameDocument): IChange[]` — resets the model, then applies the document as a batch (all `addNode` first, then `connect` for each edge), returning all change records (used for cold/standalone load).

- [ ] **Step 1: Write the failing test**

`runtime/client/src/model/graphModel.batch.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from './graphModel';
import { OpError } from './ops';
import type { IGameDocument } from './document';

describe('GraphModel applyBatch', () => {
  it('applies all ops and concatenates changes', () => {
    const m = new GraphModel();
    const changes = m.applyBatch([
      { kind: 'addNode', id: 'root', type: 'Root' },
      { kind: 'addNode', id: 's', type: 'Sprite' },
      { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } },
    ]);
    expect(changes).toHaveLength(3);
    expect(m.getNode('s')).toBeDefined();
  });

  it('is transactional: a bad op rolls back the whole batch', () => {
    const m = new GraphModel();
    expect(() =>
      m.applyBatch([
        { kind: 'addNode', id: 'a', type: 'Sprite' },
        { kind: 'addNode', id: 'a', type: 'Sprite' }, // duplicate -> throws
      ]),
    ).toThrow(OpError);
    expect(m.getNode('a')).toBeUndefined(); // first op rolled back
  });
});

describe('GraphModel load', () => {
  it('loads a document into an empty scene', () => {
    const doc: IGameDocument = {
      version: 1,
      nodes: {
        root: { id: 'root', type: 'Root', props: { width: 800, height: 600 } },
        s: { id: 's', type: 'Sprite', props: { alpha: 1 } },
      },
      edges: [{ id: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } }],
    };
    const m = new GraphModel();
    const changes = m.load(doc);
    expect(changes.some((c) => c.kind === 'nodeCreated')).toBe(true);
    expect(changes.some((c) => c.kind === 'parentSet')).toBe(true);
    expect(m.toDocument()).toEqual(doc);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `applyBatch`/`load` not defined.

- [ ] **Step 3: Implement applyBatch + load**

Add to `GraphModel`:

```ts
  applyBatch(ops: Op[]): IChange[] {
    const snapshot = this.toDocument();
    const changes: IChange[] = [];
    try {
      for (const op of ops) changes.push(...this.apply(op));
      return changes;
    } catch (err) {
      this.restore(snapshot);
      throw err;
    }
  }

  load(doc: IGameDocument): IChange[] {
    this.nodes.clear();
    this.edges.clear();
    const ops: Op[] = [];
    for (const node of Object.values(doc.nodes)) ops.push({ kind: 'addNode', id: node.id, type: node.type, props: node.props });
    for (const e of doc.edges) ops.push({ kind: 'connect', edgeId: e.id, type: e.type, from: e.from, to: e.to });
    return this.applyBatch(ops);
  }

  private restore(doc: IGameDocument): void {
    this.nodes.clear();
    this.edges.clear();
    for (const node of Object.values(doc.nodes)) this.nodes.set(node.id, { id: node.id, type: node.type, props: { ...node.props } });
    for (const e of doc.edges) this.edges.set(e.id, { ...e });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): GraphModel transactional applyBatch + document load"
```

---

### Task 7: IRenderer seam + MockRenderer

**Files:**

- Create: `runtime/client/src/render/renderer.ts`
- Create: `runtime/client/src/render/mockRenderer.ts`
- Test: `runtime/client/src/render/mockRenderer.spec.ts`

**Interfaces:**

- Consumes: `NodeType`, `JsonValue` (Task 2).
- Produces:
  - `type ITextureHandle = unknown`
  - `interface IRenderer` with: `mount(rootId: string, opts: { width: number; height: number }): void | Promise<void>`; `createObject(id: string, type: NodeType): void`; `destroyObject(id: string): void`; `setParent(childId: string, parentId: string | null): void`; `setProp(id: string, path: string, value: JsonValue): void`; `loadTexture(src: string): Promise<ITextureHandle>`; `assignTexture(spriteId: string, texture: ITextureHandle | null): void`.
  - `class MockRenderer implements IRenderer` recording every call into a public `calls: Array<[string, ...unknown[]]>`, with `loadTexture` returning `{ src }`.

- [ ] **Step 1: Write the failing test**

`runtime/client/src/render/mockRenderer.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MockRenderer } from './mockRenderer';

describe('MockRenderer', () => {
  it('records calls and returns a texture handle', async () => {
    const r = new MockRenderer();
    r.mount('root', { width: 100, height: 100 });
    r.createObject('s', 'Sprite');
    r.setProp('s', 'alpha', 0.5);
    const tex = await r.loadTexture('asset:1');
    r.assignTexture('s', tex);
    expect(tex).toEqual({ src: 'asset:1' });
    expect(r.calls).toEqual([
      ['mount', 'root', { width: 100, height: 100 }],
      ['createObject', 's', 'Sprite'],
      ['setProp', 's', 'alpha', 0.5],
      ['loadTexture', 'asset:1'],
      ['assignTexture', 's', { src: 'asset:1' }],
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the seam + mock**

`runtime/client/src/render/renderer.ts`:

```ts
import type { JsonValue, NodeType } from '../model/document';

export type ITextureHandle = unknown;

export interface IRenderer {
  mount(rootId: string, opts: { width: number; height: number }): void | Promise<void>;
  createObject(id: string, type: NodeType): void;
  destroyObject(id: string): void;
  setParent(childId: string, parentId: string | null): void;
  setProp(id: string, path: string, value: JsonValue): void;
  loadTexture(src: string): Promise<ITextureHandle>;
  assignTexture(spriteId: string, texture: ITextureHandle | null): void;
}
```

`runtime/client/src/render/mockRenderer.ts`:

```ts
import type { JsonValue, NodeType } from '../model/document';
import type { IRenderer, ITextureHandle } from './renderer';

export class MockRenderer implements IRenderer {
  calls: Array<[string, ...unknown[]]> = [];

  mount(rootId: string, opts: { width: number; height: number }): void {
    this.calls.push(['mount', rootId, opts]);
  }
  createObject(id: string, type: NodeType): void {
    this.calls.push(['createObject', id, type]);
  }
  destroyObject(id: string): void {
    this.calls.push(['destroyObject', id]);
  }
  setParent(childId: string, parentId: string | null): void {
    this.calls.push(['setParent', childId, parentId]);
  }
  setProp(id: string, path: string, value: JsonValue): void {
    this.calls.push(['setProp', id, path, value]);
  }
  async loadTexture(src: string): Promise<ITextureHandle> {
    this.calls.push(['loadTexture', src]);
    return { src };
  }
  assignTexture(spriteId: string, texture: ITextureHandle | null): void {
    this.calls.push(['assignTexture', spriteId, texture]);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): IRenderer seam and MockRenderer test double"
```

---

### Task 8: Reconciler — node lifecycle + hierarchy

**Files:**

- Create: `runtime/client/src/render/reconciler.ts`
- Test: `runtime/client/src/render/reconciler.nodes.spec.ts`

**Interfaces:**

- Consumes: `GraphModel` (Tasks 3–6), `IRenderer` (Task 7), `IChange` (Task 2).
- Produces:
  - `class Reconciler { constructor(renderer: IRenderer, model: GraphModel); applyChanges(changes: IChange[]): Promise<void> }`
  - Behavior this task:
    - `nodeCreated` for `Root` → `renderer.mount(node.id, {width, height})` reading `props.width`/`props.height` (default `800`/`600`), then apply remaining props (handled in Task 9).
    - `nodeCreated` for `Container`/`Sprite` → `renderer.createObject(id, type)`, then apply each prop (Task 9).
    - `nodeCreated` for `Texture` → no renderer call (data-only node).
    - `nodeRemoved` → `renderer.destroyObject(id)`.
    - `parentSet` → `renderer.setParent(childId, parentId)`.

- [ ] **Step 1: Write the failing test**

`runtime/client/src/render/reconciler.nodes.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from './mockRenderer';
import { Reconciler } from './reconciler';

describe('Reconciler node lifecycle + hierarchy', () => {
  it('mounts Root, creates display objects, skips Texture, parents children', async () => {
    const model = new GraphModel();
    const r = new MockRenderer();
    const rec = new Reconciler(r, model);

    await rec.applyChanges(model.apply({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 1280, height: 720 } }));
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 's', type: 'Sprite' }));
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: 'asset:1' } }));
    await rec.applyChanges(
      model.apply({ kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } }),
    );

    expect(r.calls).toContainEqual(['mount', 'root', { width: 1280, height: 720 }]);
    expect(r.calls).toContainEqual(['createObject', 's', 'Sprite']);
    expect(r.calls.find((c) => c[0] === 'createObject' && c[1] === 'tex')).toBeUndefined();
    expect(r.calls).toContainEqual(['setParent', 's', 'root']);
  });

  it('destroys on nodeRemoved', async () => {
    const model = new GraphModel();
    const r = new MockRenderer();
    const rec = new Reconciler(r, model);
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 's', type: 'Sprite' }));
    await rec.applyChanges(model.apply({ kind: 'removeNode', id: 's' }));
    expect(r.calls).toContainEqual(['destroyObject', 's']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `Reconciler` missing.

- [ ] **Step 3: Implement the reconciler (lifecycle + hierarchy)**

`runtime/client/src/render/reconciler.ts`:

```ts
import type { GraphModel } from '../model/graphModel';
import type { IChange } from '../model/changes';
import type { INode, JsonValue } from '../model/document';
import type { IRenderer } from './renderer';

export class Reconciler {
  constructor(
    private readonly renderer: IRenderer,
    private readonly model: GraphModel,
  ) {}

  async applyChanges(changes: IChange[]): Promise<void> {
    for (const change of changes) await this.applyOne(change);
  }

  private async applyOne(change: IChange): Promise<void> {
    switch (change.kind) {
      case 'nodeCreated':
        return this.created(change.node);
      case 'nodeRemoved':
        this.renderer.destroyObject(change.id);
        return;
      case 'parentSet':
        this.renderer.setParent(change.childId, change.parentId);
        return;
      // 'propSet' / 'dataBound' / 'dataUnbound' handled in Tasks 9–10
      default:
        return;
    }
  }

  private async created(node: INode): Promise<void> {
    if (node.type === 'Texture') return; // data-only node, no display object
    if (node.type === 'Root') {
      const width = numProp(node.props.width, 800);
      const height = numProp(node.props.height, 600);
      await this.renderer.mount(node.id, { width, height });
    } else {
      this.renderer.createObject(node.id, node.type);
    }
  }
}

function numProp(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): Reconciler node lifecycle and hierarchy"
```

---

### Task 9: Reconciler — initial props + propSet

**Files:**

- Modify: `runtime/client/src/render/reconciler.ts`
- Test: `runtime/client/src/render/reconciler.props.spec.ts`

**Interfaces:**

- Consumes: `Reconciler` (Task 8).
- Produces: after `createObject` for a `Container`/`Sprite`, each entry in `node.props` is applied via `renderer.setProp(id, key, value)`. A `propSet` change on a non-Texture node calls `renderer.setProp(id, path, value)`. (Texture `propSet` reactivity is Task 10.)

- [ ] **Step 1: Write the failing test**

`runtime/client/src/render/reconciler.props.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from './mockRenderer';
import { Reconciler } from './reconciler';

describe('Reconciler props', () => {
  it('applies initial props on create', async () => {
    const model = new GraphModel();
    const r = new MockRenderer();
    const rec = new Reconciler(r, model);
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 's', type: 'Sprite', props: { alpha: 0.5, zIndex: 2 } }));
    expect(r.calls).toContainEqual(['setProp', 's', 'alpha', 0.5]);
    expect(r.calls).toContainEqual(['setProp', 's', 'zIndex', 2]);
  });

  it('forwards a later propSet', async () => {
    const model = new GraphModel();
    const r = new MockRenderer();
    const rec = new Reconciler(r, model);
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 's', type: 'Sprite' }));
    await rec.applyChanges(model.apply({ kind: 'setProp', id: 's', path: 'position.x', value: 240 }));
    expect(r.calls).toContainEqual(['setProp', 's', 'position.x', 240]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — initial props not applied; `propSet` not forwarded.

- [ ] **Step 3: Implement props handling**

In `reconciler.ts`: in `created()`, after `createObject`, apply props; and add a `propSet` case to `applyOne`.

```ts
    } else {
      this.renderer.createObject(node.id, node.type);
      for (const [key, value] of Object.entries(node.props)) this.renderer.setProp(node.id, key, value);
    }
```

Add to the `applyOne` switch (before `default`):

```ts
      case 'propSet': {
        const node = this.model.getNode(change.id);
        if (node && node.type === 'Texture') return; // reactivity handled in Task 10
        this.renderer.setProp(change.id, change.path, change.value);
        return;
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): Reconciler initial props and propSet forwarding"
```

---

### Task 10: Reconciler — texture data edges + one-hop reactive push

**Files:**

- Modify: `runtime/client/src/render/reconciler.ts`
- Test: `runtime/client/src/render/reconciler.texture.spec.ts`

**Interfaces:**

- Consumes: `Reconciler` (Tasks 8–9), `GraphModel.edgesBySource` (Task 5).
- Produces:
  - `dataBound{edge}` (Texture→Sprite.texture) → resolve the source Texture node's `src` via `renderer.loadTexture`, then `renderer.assignTexture(edge.to.node, handle)`.
  - `dataUnbound{edge}` → `renderer.assignTexture(edge.to.node, null)`.
  - `propSet` on a `Texture` node whose `path === 'src'` → re-resolve and `assignTexture` to **every** sprite bound from that texture node (`model.edgesBySource(textureId, 'data')`).

- [ ] **Step 1: Write the failing test**

`runtime/client/src/render/reconciler.texture.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from './mockRenderer';
import { Reconciler } from './reconciler';

async function sceneWithBoundTexture() {
  const model = new GraphModel();
  const r = new MockRenderer();
  const rec = new Reconciler(r, model);
  await rec.applyChanges(model.apply({ kind: 'addNode', id: 's', type: 'Sprite' }));
  await rec.applyChanges(model.apply({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: 'asset:1' } }));
  await rec.applyChanges(model.apply({ kind: 'connect', edgeId: 'e1', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } }));
  return { model, r, rec };
}

describe('Reconciler texture data edges', () => {
  it('loads and assigns texture on dataBound', async () => {
    const { r } = await sceneWithBoundTexture();
    expect(r.calls).toContainEqual(['loadTexture', 'asset:1']);
    expect(r.calls).toContainEqual(['assignTexture', 's', { src: 'asset:1' }]);
  });

  it('clears texture on dataUnbound', async () => {
    const { model, r, rec } = await sceneWithBoundTexture();
    await rec.applyChanges(model.apply({ kind: 'disconnect', edgeId: 'e1' }));
    expect(r.calls).toContainEqual(['assignTexture', 's', null]);
  });

  it('re-pushes to bound sprites when Texture.src changes', async () => {
    const { model, r, rec } = await sceneWithBoundTexture();
    r.calls.length = 0;
    await rec.applyChanges(model.apply({ kind: 'setProp', id: 'tex', path: 'src', value: 'asset:2' }));
    expect(r.calls).toContainEqual(['loadTexture', 'asset:2']);
    expect(r.calls).toContainEqual(['assignTexture', 's', { src: 'asset:2' }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — data edge changes not handled.

- [ ] **Step 3: Implement texture binding + reactive push**

In `reconciler.ts`, add cases to `applyOne` (before `default`) and a helper:

```ts
      case 'dataBound': {
        if (change.edge.to.port === 'texture') await this.bindTexture(change.edge.from.node, change.edge.to.node);
        return;
      }
      case 'dataUnbound': {
        if (change.edge.to.port === 'texture') this.renderer.assignTexture(change.edge.to.node, null);
        return;
      }
```

Extend the `propSet` case to handle a Texture `src` change:

```ts
      case 'propSet': {
        const node = this.model.getNode(change.id);
        if (node && node.type === 'Texture') {
          if (change.path === 'src') {
            for (const e of this.model.edgesBySource(change.id, 'data')) {
              if (e.to.port === 'texture') await this.bindTexture(change.id, e.to.node);
            }
          }
          return;
        }
        this.renderer.setProp(change.id, change.path, change.value);
        return;
      }
```

Add the helper method:

```ts
  private async bindTexture(textureNodeId: string, spriteId: string): Promise<void> {
    const tex = this.model.getNode(textureNodeId);
    const src = tex && typeof tex.props.src === 'string' ? tex.props.src : null;
    const handle = src ? await this.renderer.loadTexture(src) : null;
    this.renderer.assignTexture(spriteId, handle);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): Reconciler texture binding with one-hop reactive push"
```

---

### Task 11: PixiRenderer (the one Pixi implementation)

**Files:**

- Create: `runtime/client/src/render/pixiRenderer.ts`
- Test: `runtime/client/src/render/pixiRenderer.spec.ts`

**Interfaces:**

- Consumes: `IRenderer`, `ITextureHandle` (Task 7), Pixi v8.
- Produces: `class PixiRenderer implements IRenderer { constructor(host: HTMLElement) }`.
  - `mount(rootId, {width,height})` — `new Application()`, `await app.init({ width, height, background: '#0b0b0c' })`, append `app.canvas` to `host`, register `rootId → app.stage` (with `sortableChildren = true`).
  - `createObject(id, 'Container'|'Sprite')` — create the Pixi object, store in an id→object map; set `sortableChildren = true` on containers.
  - `destroyObject(id)` — `removeFromParent()` + `destroy()`, delete from map.
  - `setParent(childId, parentId)` — `addChild` to parent (or to stage when `parentId` is the root id) / `removeChild` when `parentId` is `null`.
  - `setProp(id, path, value)` — map `position`/`position.x`/`position.y`, `scale`/`scale.x`/`scale.y`, `anchor`/`anchor.x`/`anchor.y`, `rotation`, `alpha`, `visible`, `zIndex` onto the object.
  - `loadTexture(src)` — `await Assets.load(resolveSrc(src))` (where `resolveSrc` strips an `asset:`/`media:` scheme to a URL via a constructor-supplied resolver; default identity).
  - `assignTexture(spriteId, handle)` — set `sprite.texture = handle ?? Texture.EMPTY`.

> **Note on testing Pixi:** WebGL is unavailable in jsdom, so this task's unit test asserts only the **construction contract and prop-mapping math** by injecting a fake object map — the real rendering is covered by the Task 14 e2e. Keep `setProp`'s value-mapping in a pure exported helper `applyPixiProp(obj, path, value)` so it is unit-testable without a GPU.

- [ ] **Step 1: Write the failing test (pure prop-mapping helper)**

`runtime/client/src/render/pixiRenderer.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyPixiProp } from './pixiRenderer';

function fakeObj() {
  return {
    position: {
      x: 0,
      y: 0,
      set(x: number, y: number) {
        this.x = x;
        this.y = y;
      },
    },
    scale: {
      x: 1,
      y: 1,
      set(x: number, y: number) {
        this.x = x;
        this.y = y;
      },
    },
    anchor: {
      x: 0,
      y: 0,
      set(x: number, y: number) {
        this.x = x;
        this.y = y;
      },
    },
    rotation: 0,
    alpha: 1,
    visible: true,
    zIndex: 0,
  };
}

describe('applyPixiProp', () => {
  it('maps nested position', () => {
    const o = fakeObj();
    applyPixiProp(o as never, 'position.x', 240);
    expect(o.position.x).toBe(240);
  });
  it('maps whole position object', () => {
    const o = fakeObj();
    applyPixiProp(o as never, 'position', { x: 10, y: 20 });
    expect(o.position).toMatchObject({ x: 10, y: 20 });
  });
  it('maps scalars', () => {
    const o = fakeObj();
    applyPixiProp(o as never, 'alpha', 0.5);
    applyPixiProp(o as never, 'zIndex', 7);
    applyPixiProp(o as never, 'visible', false);
    expect(o.alpha).toBe(0.5);
    expect(o.zIndex).toBe(7);
    expect(o.visible).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `applyPixiProp` not exported.

- [ ] **Step 3: Implement PixiRenderer + applyPixiProp**

`runtime/client/src/render/pixiRenderer.ts`:

```ts
import { Application, Assets, Container, Sprite, Texture } from 'pixi.js';
import type { JsonValue, NodeType } from '../model/document';
import type { IRenderer, ITextureHandle } from './renderer';

type DisplayObject = Container | Sprite;
type Vec2 = { x?: number; y?: number };

export function applyPixiProp(obj: DisplayObject, path: string, value: JsonValue): void {
  switch (path) {
    case 'position':
    case 'scale':
    case 'anchor': {
      const v = (value ?? {}) as Vec2;
      const target = (obj as unknown as Record<string, { set(x: number, y: number): void }>)[path];
      target.set(v.x ?? 0, v.y ?? 0);
      return;
    }
    case 'position.x':
      (obj as unknown as { position: Vec2 }).position.x = value as number;
      return;
    case 'position.y':
      (obj as unknown as { position: Vec2 }).position.y = value as number;
      return;
    case 'scale.x':
      (obj as unknown as { scale: Vec2 }).scale.x = value as number;
      return;
    case 'scale.y':
      (obj as unknown as { scale: Vec2 }).scale.y = value as number;
      return;
    case 'anchor.x':
      (obj as unknown as { anchor: Vec2 }).anchor.x = value as number;
      return;
    case 'anchor.y':
      (obj as unknown as { anchor: Vec2 }).anchor.y = value as number;
      return;
    case 'rotation':
      (obj as { rotation: number }).rotation = value as number;
      return;
    case 'alpha':
      (obj as { alpha: number }).alpha = value as number;
      return;
    case 'visible':
      (obj as { visible: boolean }).visible = value as boolean;
      return;
    case 'zIndex':
      (obj as { zIndex: number }).zIndex = value as number;
      return;
    default:
      return; // unknown props are ignored (forward-compatible)
  }
}

export type SrcResolver = (src: string) => string;

export class PixiRenderer implements IRenderer {
  private app: Application | null = null;
  private rootId: string | null = null;
  private objects = new Map<string, DisplayObject>();

  constructor(
    private readonly host: HTMLElement,
    private readonly resolveSrc: SrcResolver = (s) => s,
  ) {}

  async mount(rootId: string, opts: { width: number; height: number }): Promise<void> {
    const app = new Application();
    await app.init({ width: opts.width, height: opts.height, background: '#0b0b0c', antialias: true });
    this.host.appendChild(app.canvas);
    app.stage.sortableChildren = true;
    this.app = app;
    this.rootId = rootId;
    this.objects.set(rootId, app.stage as unknown as Container);
  }

  createObject(id: string, type: NodeType): void {
    if (type === 'Sprite') {
      this.objects.set(id, new Sprite());
    } else if (type === 'Container') {
      const c = new Container();
      c.sortableChildren = true;
      this.objects.set(id, c);
    }
  }

  destroyObject(id: string): void {
    const obj = this.objects.get(id);
    if (!obj || id === this.rootId) return;
    obj.removeFromParent();
    obj.destroy();
    this.objects.delete(id);
  }

  setParent(childId: string, parentId: string | null): void {
    const child = this.objects.get(childId);
    if (!child) return;
    child.removeFromParent();
    if (parentId === null) return;
    const parent = this.objects.get(parentId);
    if (parent) (parent as Container).addChild(child);
  }

  setProp(id: string, path: string, value: JsonValue): void {
    const obj = this.objects.get(id);
    if (obj) applyPixiProp(obj, path, value);
  }

  async loadTexture(src: string): Promise<ITextureHandle> {
    return Assets.load(this.resolveSrc(src));
  }

  assignTexture(spriteId: string, texture: ITextureHandle | null): void {
    const obj = this.objects.get(spriteId);
    if (obj instanceof Sprite) obj.texture = (texture as Texture) ?? Texture.EMPTY;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS (the pure helper test). Also run `npx nx typecheck client` and expect no type errors.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): PixiRenderer implementing the IRenderer seam"
```

---

### Task 12: ProtocolHost — envelope, handshake, intake, ack/error

**Files:**

- Create: `runtime/client/src/protocol/messages.ts`
- Create: `runtime/client/src/protocol/protocolHost.ts`
- Test: `runtime/client/src/protocol/protocolHost.spec.ts`

**Interfaces:**

- Consumes: `Op` (Task 2), `IGameDocument` (Task 2), `GraphModel` (Tasks 3–6), `Reconciler` (Tasks 8–10).
- Produces:
  - `messages.ts`: `const PROTOCOL_VERSION = 1`; `type InboundMessage = { v: 1; kind: 'init'; id: string; document?: IGameDocument } | { v: 1; kind: 'op'; id: string; op: Op } | { v: 1; kind: 'batch'; id: string; ops: Op[] }`; `type OutboundMessage = { v: 1; kind: 'ready'; protocolVersion: 1 } | { v: 1; kind: 'ack'; id: string } | { v: 1; kind: 'error'; id: string; code: string; message: string }`.
  - `protocolHost.ts`: `class ProtocolHost { constructor(deps: { model: GraphModel; reconciler: Reconciler; post: (msg: OutboundMessage) => void }); start(): void; handle(msg: InboundMessage): Promise<void> }`.
    - `start()` posts `{v:1,kind:'ready',protocolVersion:1}`.
    - `handle(init)` → `model.load(document ?? emptyDocument)`, reconcile, post `ack`.
    - `handle(op)` → `model.apply`, reconcile, post `ack`; on `OpError`, post `error{code}` (model already untouched).
    - `handle(batch)` → `model.applyBatch`, reconcile, post `ack`; on error post `error`.
    - Ignores malformed messages (no `v`/`kind`) silently.

- [ ] **Step 1: Write the failing test**

`runtime/client/src/protocol/protocolHost.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from '../render/mockRenderer';
import { Reconciler } from '../render/reconciler';
import { ProtocolHost } from './protocolHost';
import type { OutboundMessage } from './messages';

function setup() {
  const model = new GraphModel();
  const renderer = new MockRenderer();
  const reconciler = new Reconciler(renderer, model);
  const sent: OutboundMessage[] = [];
  const host = new ProtocolHost({ model, reconciler, post: (m) => sent.push(m) });
  return { model, renderer, host, sent };
}

describe('ProtocolHost', () => {
  it('emits ready on start', () => {
    const { host, sent } = setup();
    host.start();
    expect(sent).toEqual([{ v: 1, kind: 'ready', protocolVersion: 1 }]);
  });

  it('applies an op and acks', async () => {
    const { host, sent, model } = setup();
    await host.handle({ v: 1, kind: 'op', id: 'm1', op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    expect(model.getNode('s')).toBeDefined();
    expect(sent).toContainEqual({ v: 1, kind: 'ack', id: 'm1' });
  });

  it('errors (not throws) on an invalid op, leaving the model untouched', async () => {
    const { host, sent, model } = setup();
    await host.handle({ v: 1, kind: 'op', id: 'm2', op: { kind: 'removeNode', id: 'ghost' } });
    expect(model.getNode('ghost')).toBeUndefined();
    expect(sent.some((m) => m.kind === 'error' && m.id === 'm2' && m.code === 'unknown_node')).toBe(true);
  });

  it('loads a document on init and acks', async () => {
    const { host, sent, renderer } = setup();
    await host.handle({
      v: 1,
      kind: 'init',
      id: 'm3',
      document: { version: 1, nodes: { root: { id: 'root', type: 'Root', props: { width: 800, height: 600 } } }, edges: [] },
    });
    expect(renderer.calls).toContainEqual(['mount', 'root', { width: 800, height: 600 }]);
    expect(sent).toContainEqual({ v: 1, kind: 'ack', id: 'm3' });
  });

  it('applies a batch and acks', async () => {
    const { host, sent, model } = setup();
    await host.handle({
      v: 1,
      kind: 'batch',
      id: 'm4',
      ops: [
        { kind: 'addNode', id: 'a', type: 'Container' },
        { kind: 'addNode', id: 'b', type: 'Sprite' },
      ],
    });
    expect(model.getNode('a')).toBeDefined();
    expect(model.getNode('b')).toBeDefined();
    expect(sent).toContainEqual({ v: 1, kind: 'ack', id: 'm4' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — protocol modules missing.

- [ ] **Step 3: Implement messages + ProtocolHost**

`runtime/client/src/protocol/messages.ts`:

```ts
import type { IGameDocument } from '../model/document';
import type { Op } from '../model/ops';

export const PROTOCOL_VERSION = 1 as const;

export type InboundMessage =
  | { v: 1; kind: 'init'; id: string; document?: IGameDocument }
  | { v: 1; kind: 'op'; id: string; op: Op }
  | { v: 1; kind: 'batch'; id: string; ops: Op[] };

export type OutboundMessage =
  | { v: 1; kind: 'ready'; protocolVersion: 1 }
  | { v: 1; kind: 'ack'; id: string }
  | { v: 1; kind: 'error'; id: string; code: string; message: string };
```

`runtime/client/src/protocol/protocolHost.ts`:

```ts
import { emptyDocument } from '../model/document';
import { OpError } from '../model/ops';
import type { GraphModel } from '../model/graphModel';
import type { Reconciler } from '../render/reconciler';
import { PROTOCOL_VERSION, type InboundMessage, type OutboundMessage } from './messages';

export interface IProtocolDeps {
  model: GraphModel;
  reconciler: Reconciler;
  post: (msg: OutboundMessage) => void;
}

export class ProtocolHost {
  constructor(private readonly deps: IProtocolDeps) {}

  start(): void {
    this.deps.post({ v: 1, kind: 'ready', protocolVersion: PROTOCOL_VERSION });
  }

  async handle(msg: InboundMessage): Promise<void> {
    if (!msg || msg.v !== PROTOCOL_VERSION || typeof msg.kind !== 'string') return;
    try {
      if (msg.kind === 'init') {
        const changes = this.deps.model.load(msg.document ?? emptyDocument());
        await this.deps.reconciler.applyChanges(changes);
      } else if (msg.kind === 'op') {
        const changes = this.deps.model.apply(msg.op);
        await this.deps.reconciler.applyChanges(changes);
      } else if (msg.kind === 'batch') {
        const changes = this.deps.model.applyBatch(msg.ops);
        await this.deps.reconciler.applyChanges(changes);
      } else {
        return;
      }
      this.deps.post({ v: 1, kind: 'ack', id: msg.id });
    } catch (err) {
      const code = err instanceof OpError ? err.code : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      this.deps.post({ v: 1, kind: 'error', id: msg.id, code, message });
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): ProtocolHost handshake, intake, ack/error"
```

---

### Task 13: Engine bootstrap + standalone load + window message wiring

**Files:**

- Modify: `runtime/client/src/main.ts`
- Create: `runtime/client/src/engine.ts`
- Test: `runtime/client/src/engine.spec.ts`

**Interfaces:**

- Consumes: `GraphModel`, `Reconciler`, `PixiRenderer`, `ProtocolHost`, `messages`.
- Produces:
  - `engine.ts`: `function createEngine(deps: { renderer: IRenderer; post: (m: OutboundMessage) => void }): { host: ProtocolHost; model: GraphModel }` — wires `GraphModel` + `Reconciler` + `ProtocolHost`. (Renderer injected so the wiring is unit-testable with `MockRenderer`.)
  - `function attachWindowTransport(host: ProtocolHost): void` — adds a `message` listener that forwards `event.data` to `host.handle`, replying via `event.source ?? window.parent`; calls `host.start()` posting `ready` to the parent.
  - `main.ts`: instantiates `PixiRenderer(document.getElementById('stage')!)`, builds the engine with `post → window.parent.postMessage`, attaches the window transport, and — for **standalone mode** — if a `?doc=<url>` query param is present, fetches that JSON and `host.handle({v:1,kind:'init',id:'standalone',document})`.
  - Test-only observability: `main.ts` sets `(window as any).__engineModel = model` so e2e can read `model.toDocument()`.

- [ ] **Step 1: Write the failing test**

`runtime/client/src/engine.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MockRenderer } from './render/mockRenderer';
import { createEngine } from './engine';
import type { OutboundMessage } from './protocol/messages';

describe('createEngine', () => {
  it('wires model + reconciler + protocol so ops reconcile and ack', async () => {
    const renderer = new MockRenderer();
    const sent: OutboundMessage[] = [];
    const { host, model } = createEngine({ renderer, post: (m) => sent.push(m) });
    host.start();
    await host.handle({ v: 1, kind: 'op', id: '1', op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    expect(sent[0]).toEqual({ v: 1, kind: 'ready', protocolVersion: 1 });
    expect(renderer.calls).toContainEqual(['mount', 'root', { width: 640, height: 480 }]);
    expect(model.getNode('root')).toBeDefined();
    expect(sent).toContainEqual({ v: 1, kind: 'ack', id: '1' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `./engine` missing.

- [ ] **Step 3: Implement engine.ts + main.ts**

`runtime/client/src/engine.ts`:

```ts
import { GraphModel } from './model/graphModel';
import { Reconciler } from './render/reconciler';
import type { IRenderer } from './render/renderer';
import { ProtocolHost } from './protocol/protocolHost';
import type { InboundMessage, OutboundMessage } from './protocol/messages';

export function createEngine(deps: { renderer: IRenderer; post: (m: OutboundMessage) => void }): {
  host: ProtocolHost;
  model: GraphModel;
} {
  const model = new GraphModel();
  const reconciler = new Reconciler(deps.renderer, model);
  const host = new ProtocolHost({ model, reconciler, post: deps.post });
  return { host, model };
}

export function attachWindowTransport(host: ProtocolHost): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as InboundMessage;
    const reply = (m: OutboundMessage) => {
      const target = (event.source as Window | null) ?? window.parent;
      target?.postMessage(m, '*');
    };
    // Rebind post per-incoming-source so acks return to the sender.
    void host.handle(data);
    void reply; // post is bound at construction in main.ts; see note below.
  });
}
```

> **Implementation note for the engine wiring:** the simplest correct binding is to construct the `ProtocolHost` with `post` targeting `window.parent` (the studio embeds the engine, so the parent is the sender). `attachWindowTransport` then only needs to forward inbound `message` events to `host.handle`. Use this simpler form in `main.ts`:

`runtime/client/src/main.ts`:

```ts
import { PixiRenderer } from './render/pixiRenderer';
import { createEngine } from './engine';
import type { InboundMessage, OutboundMessage } from './protocol/messages';

const stage = document.getElementById('stage');
if (!stage) throw new Error('missing #stage element');

const post = (m: OutboundMessage) => window.parent?.postMessage(m, '*');
const renderer = new PixiRenderer(stage);
const { host, model } = createEngine({ renderer, post });

// Test/standalone observability.
(window as unknown as { __engineModel: typeof model }).__engineModel = model;

window.addEventListener('message', (event: MessageEvent) => {
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

Then simplify `engine.ts` by **removing** the unused `attachWindowTransport` export (keep only `createEngine`) so there is no dead code:

```ts
import { GraphModel } from './model/graphModel';
import { Reconciler } from './render/reconciler';
import type { IRenderer } from './render/renderer';
import { ProtocolHost } from './protocol/protocolHost';
import type { OutboundMessage } from './protocol/messages';

export function createEngine(deps: { renderer: IRenderer; post: (m: OutboundMessage) => void }): {
  host: ProtocolHost;
  model: GraphModel;
} {
  const model = new GraphModel();
  const reconciler = new Reconciler(deps.renderer, model);
  const host = new ProtocolHost({ model, reconciler, post: deps.post });
  return { host, model };
}
```

- [ ] **Step 4: Run to verify it passes + typecheck + serve smoke**

Run:

```bash
npx nx test client
npx nx typecheck client
```

Expected: tests PASS; typecheck clean. Then manually smoke `npx nx serve client`, open `http://localhost:4300`, confirm a dark canvas mounts with no console errors (Ctrl-C to stop).

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "feat(client): engine bootstrap, window transport, standalone load"
```

---

### Task 14: End-to-end (Playwright) — boot, live mutation, standalone load

**Files:**

- Create: `runtime/client/playwright.config.ts`
- Create: `runtime/client/e2e/harness.html`
- Create: `runtime/client/e2e/engine.e2e.spec.ts`
- Create: `runtime/client/e2e/fixtures/two-sprite.json`

**Interfaces:**

- Consumes: the running engine (`nx serve client` on :4300) and the protocol contract.
- Produces: a local-only Playwright suite proving observable behavior: handshake `ready`, live ops mutate the scene with no reload, and standalone `?doc=` load builds the scene.

> **Per repo policy this suite runs locally, never in CI.** The Playwright config starts the Vite dev server via `webServer`.

- [ ] **Step 1: Write the Playwright config + harness + fixture**

`runtime/client/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4300', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx nx serve client',
    url: 'http://localhost:4300',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

`runtime/client/e2e/harness.html` (a parent page embedding the engine iframe — exercises the real cross-frame postMessage path):

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>engine harness</title>
  </head>
  <body>
    <iframe id="engine" src="http://localhost:4300/" width="640" height="480" style="border:0"></iframe>
    <script>
      window.__sent = [];
      window.__inbound = [];
      const frame = document.getElementById('engine');
      window.addEventListener('message', (e) => window.__inbound.push(e.data));
      window.send = (msg) => {
        window.__sent.push(msg);
        frame.contentWindow.postMessage(msg, '*');
      };
      window.engineModel = () => frame.contentWindow.__engineModel.toDocument();
    </script>
  </body>
</html>
```

`runtime/client/e2e/fixtures/two-sprite.json`:

```json
{
  "version": 1,
  "nodes": {
    "root": { "id": "root", "type": "Root", "props": { "width": 640, "height": 480 } },
    "s1": { "id": "s1", "type": "Sprite", "props": { "position": { "x": 100, "y": 100 } } }
  },
  "edges": [{ "id": "e1", "type": "child", "from": { "node": "root", "port": "children" }, "to": { "node": "s1", "port": "parent" } }]
}
```

> The harness loads via the dev server too. Add the fixture path note: serve the harness through Vite by placing it under the served root. Since Vite serves the project root, reference the harness in the test with `page.goto('/e2e/harness.html')` — Vite serves files from the project root in dev, so `e2e/harness.html` and `e2e/fixtures/two-sprite.json` are reachable. If Vite restricts the path, the test falls back to `page.setContent(<harness html>)`; the spec below uses `setContent` to avoid any served-path ambiguity.

- [ ] **Step 2: Write the e2e spec**

`runtime/client/e2e/engine.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

const HARNESS = `
  <iframe id="engine" src="http://localhost:4300/" width="640" height="480" style="border:0"></iframe>
  <script>
    window.__inbound = [];
    const frame = document.getElementById('engine');
    window.addEventListener('message', (e) => window.__inbound.push(e.data));
    window.send = (msg) => frame.contentWindow.postMessage(msg, '*');
    window.engineModel = () => frame.contentWindow.__engineModel.toDocument();
  </script>`;

test('engine handshakes, accepts live ops, and reflects them in the model', async ({ page }) => {
  await page.goto('http://localhost:4300/');
  await page.setContent(HARNESS);

  // Handshake: the iframe posts `ready` to the parent.
  await expect.poll(() => page.evaluate(() => (window as any).__inbound.some((m: any) => m.kind === 'ready'))).toBe(true);

  // Live ops: build a root + sprite with no reload.
  await page.evaluate(() => {
    (window as any).send({ v: 1, kind: 'op', id: '1', op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    (window as any).send({ v: 1, kind: 'op', id: '2', op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    (window as any).send({
      v: 1,
      kind: 'op',
      id: '3',
      op: { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } },
    });
  });

  await expect.poll(() => page.evaluate(() => (window as any).__inbound.filter((m: any) => m.kind === 'ack').length)).toBeGreaterThanOrEqual(3);
  const doc = await page.evaluate(() => (window as any).engineModel());
  expect(doc.nodes.s).toBeTruthy();
  expect(doc.edges).toHaveLength(1);
});

test('standalone mode builds a scene from ?doc=', async ({ page }) => {
  // Serve the fixture inline via a data URL passed to ?doc=.
  const doc = encodeURIComponent(
    JSON.stringify({
      version: 1,
      nodes: { root: { id: 'root', type: 'Root', props: { width: 640, height: 480 } }, s1: { id: 's1', type: 'Sprite', props: {} } },
      edges: [{ id: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's1', port: 'parent' } }],
    }),
  );
  await page.goto(`http://localhost:4300/?doc=data:application/json,${doc}`);
  await expect.poll(() => page.evaluate(() => (window as any).__engineModel?.toDocument().nodes.s1 != null)).toBe(true);
});
```

- [ ] **Step 3: Run the e2e suite**

Run (engine server auto-starts via `webServer`):

```bash
npx nx e2e client
```

Expected: both tests PASS. (If `nx e2e` is not inferred, run `npx playwright test --config runtime/client/playwright.config.ts`.)

- [ ] **Step 4: Verify the full unit suite + typecheck still green**

Run:

```bash
npx nx test client
npx nx typecheck client
```

Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
npx prettier --write runtime/client
git add runtime/client
git commit -m "test(client): e2e for handshake, live mutation, standalone load"
```

---

## Plan 2 (next plan) — Studio integration (not in this plan)

Built after Plan 1 lands; consumes this plan's op vocabulary (`src/model/ops.ts`) and protocol envelope (`src/protocol/messages.ts`):

- **Backend:** `GameSceneStore` (Mongo `game_scenes` collection) persisting one `IGameDocument` per game; `scene.add_node` / `scene.set_prop` / `scene.connect` / `scene.disconnect` / `scene.remove_node` / `scene.apply_batch` agent tools (registered in `app/agent_tools.py` `_BUILDERS`); a `scene_snapshot` / `scene_op` socket broadcast; a `design-scene` skill YAML in `skills/`.
- **Frontend:** a `game` plugin (`studio/frontend/src/plugins/game/`) with a `GamePreviewPane` hosting the engine `<iframe src="http://localhost:4300">`, a `ProtocolBridge` (postMessage to the iframe, waits for `ready`), a `socketClient` that applies inbound ops to the canonical hookstate model + forwards them to the iframe, and persistence via the backend.

---

## Self-Review

**1. Spec coverage (against `2026-06-23-client-engine-design.md`):**

- §1 one-engine-two-drivers, `runtime/client` placement → Tasks 1, 13 (standalone + embedded transport). ✓
- §2 components (GraphModel, Reconciler, IRenderer, PixiRenderer, materializers, ProtocolHost) → Tasks 3–6, 8–10, 7, 11, (materializer behavior folded into Reconciler+PixiRenderer), 12. ✓
- §2 Approach-3 thin seam, pure core testable w/ mock → Tasks 7–10 (MockRenderer). ✓
- §3 document schema (4 node types, typed edges, semantic ids) → Tasks 2, 5. ✓
- §4 op vocabulary (6 ops incl. applyBatch) → Tasks 3–6. ✓
- §5 protocol envelope + handshake, versioned, origin → Task 12 (envelope/handshake/ack/error); origin: messages from any source handled, replies to parent — **note:** strict origin allow-listing is deferred to Plan 2's bridge (studio knows the engine origin); recorded in Open Decisions below.
- §6 ownership / standalone load → Task 13 (standalone); studio-side canonical model is Plan 2. ✓
- §8 reconcile + one-hop reactive push, immediate apply → Tasks 9–10. ✓
- §9 error handling (reject + untouched, batch transactional, texture placeholder) → Tasks 5, 6, 12; texture placeholder = `Texture.EMPTY` on failed/empty src (Task 11 `assignTexture`). ✓
- §10 testing (unit no-WebGL + e2e authoritative) → all unit tasks + Task 14. ✓
- §11 scope (in: 4 nodes/6 ops/protocol/engine/standalone/tests) → covered; agent tools + Mongo persistence are explicitly Plan 2 (studio integration), consistent with the two-plan split. ✓

**2. Placeholder scan:** No TBD/TODO; every code step contains full code. The only deferred items are explicitly labeled as Plan 2. ✓

**3. Type consistency:** `IChange`, `Op`, `IRenderer`, `INode`, `IEdge`, `IGameDocument` names are used identically across tasks. `GraphModel` methods (`apply`, `applyBatch`, `load`, `getNode`, `getEdge`, `edgesBySource`, `edgesByTarget`, `toDocument`) are introduced before use. `Reconciler(renderer, model)` and `ProtocolHost({model, reconciler, post})` signatures match across Tasks 8–13. `applyPixiProp` / `loadTexture` / `assignTexture` names consistent. ✓

**Open decision (carried to Plan 2):** strict `postMessage` origin allow-listing. This plan accepts messages from any origin and replies to `window.parent` (fine for the trusted same-machine dev embed and standalone). Plan 2's studio `ProtocolBridge` sets the engine iframe `src` to a known origin and should pin `targetOrigin`; the engine can then be tightened to verify `event.origin`.
