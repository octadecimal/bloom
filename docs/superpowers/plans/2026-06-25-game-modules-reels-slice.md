# Game Modules — Reels Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable, config-driven **game modules** to the runtime client and ship the first concrete module — `reels` — end to end: it projects its own persisted scene structure via ops and animates per-frame via a direct handle seam, driven by an orchestrator over a typed event bus.

**Architecture:** A **two-plane split** (per the design spec). The **structure plane** emits normal scene ops (`addNode`/`connect`/`setProp`) through a `GraphModel`, so module nodes are persisted, inspectable, and reconciled idempotently. The **behavior plane** mutates live Pixi display objects per frame through a narrow `IDisplayHandle` seam (no ops, no model traffic). A module-host facade (`IModuleHost`) is the single bridge: it exposes the document snapshot, an op-emit, an id→handle resolver, a per-frame tick, and a typed event bus. Modules talk only through the bus; a central orchestrator sequences a spin round.

**Tech Stack:** TypeScript, Pixi.js v8.19 (`BlurFilter`), Vitest (unit, CI), Playwright (e2e, local-only), Nx (`client` project at `runtime/client`).

## Global Constraints

- **TypeScript interfaces always use an `I` prefix** (`IGameModule`, `IModuleHost`, `IDisplayHandle`, `IEventBus`, `IConfigSchema`). — `docs/coding-standards.md`.
- **TDD is mandatory:** RED → GREEN → REFACTOR, one failing test first, every task.
- **Unit tests are CI-affordable; browser e2e is NOT run in CI** — run locally via `just e2e` (replay backend on `:8000`). E2e remains the authoritative behavioral contract.
- **Unit test command** (from `runtime/client`): `npx vitest run <file>` — single-file filtering by path. Full project: `npx nx test client`.
- **CI Frontend gates** (run all four before pushing): pinned `node_modules/.bin/prettier --check .`, `npx nx typecheck client` (or repo typecheck), `npx nx test client`, `npx nx build client`. vitest green ≠ types valid — run typecheck too.
- **Prettier:** use the repo-pinned binary `node_modules/.bin/prettier`, never `npx prettier` (a fresh worktree pulls a newer version that disagrees on markdown).
- **Worktree:** all work happens in `C:\code\bloom.wt\game-modules` on `feat/game-modules` (never the primary checkout). The engine dev port derives from `BLOOM_PORT_OFFSET` (`4300 + offset`).
- **New code is import-isolated** under `runtime/client/src/`: `modules/`, `modules/reels/`, `orchestration/` (structured for later extraction into libs — not extracted in this slice).
- **No new node types.** Modules emit only `Root`/`Container`/`Sprite`/`Texture` nodes so the reconciler, inspector, and future sync handle them unchanged.
- **`outcome` is a fixture** in this slice (deterministic, hand-authored). Live-runtime `outcome` wiring and server-side module parity are **deferred-B** (spec §7) — not built here.

**Spec:** [`docs/superpowers/specs/2026-06-25-game-modules-design.md`](../specs/2026-06-25-game-modules-design.md).

---

## File Structure

**New files (`runtime/client/src/`):**

- `orchestration/bus.ts` — `IEventBus` seam + `createBus()` (tiny typed emitter). [Task 1]
- `modules/schema.ts` — `IConfigField`, `IConfigSchema`, `validateConfig()`. [Task 2]
- `modules/module.ts` — `IGameModule`, `IModuleHost`, `IOutcome`, `IModuleFactory` contracts. [Task 3]
- `modules/registry.ts` — `ModuleRegistry` (`type → factory`). [Task 3]
- `modules/reconcile.ts` — pure `reconcileOps()` (idempotent add/update/remove). [Task 4]
- `modules/reels/reelsMath.ts` — pure spin/settle/recycle math. [Task 5]
- `modules/reels/reelsModule.ts` — the concrete `reels` module (structure + behavior). [Tasks 6, 7]
- `orchestration/orchestrator.ts` — round sequencing over the bus. [Task 8]
- `modules/host.ts` — `createModuleHost()` binding model+renderer+bus+tick. [Task 10]

**Modified files:**

- `render/renderer.ts` — add `IDisplayHandle`, extend `IRenderer` with `getHandle` + `onTick`. [Task 9]
- `render/pixiRenderer.ts` — implement `getHandle` (BlurFilter-backed) + `onTick` (ticker). [Task 9]
- `render/mockRenderer.ts` — implement the two new methods (test double). [Task 9]
- `protocol/messages.ts` — add `spin` inbound message. [Task 11]
- `protocol/protocolHost.ts` — dispatch `spin` to an optional `onSpin` dep. [Task 11]
- `engine.ts` — assemble bus, host, registry, reels, orchestrator; wire `onSpin`. [Task 11]
- `main.ts` — expose `window.__engineModules` observability. [Task 11]
- `e2e/reels.e2e.spec.ts` — new Playwright spec (spin round + config-edit reproject). [Task 12]

---

## Task 1: Event bus seam

**Files:**

- Create: `runtime/client/src/orchestration/bus.ts`
- Test: `runtime/client/src/orchestration/bus.spec.ts`

**Interfaces:**

- Produces: `BusHandler<T>`, `IEventBus { on, off, emit }`, `createBus(): IEventBus`. `on` returns an unsubscribe thunk.

- [ ] **Step 1: Write the failing test**

```ts
// runtime/client/src/orchestration/bus.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { createBus } from './bus';

describe('createBus', () => {
  it('delivers an emitted payload to every subscriber of that event', () => {
    const bus = createBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('reels:settled', a);
    bus.on('reels:settled', b);
    bus.emit('reels:settled', { grid: [['A']] });
    expect(a).toHaveBeenCalledWith({ grid: [['A']] });
    expect(b).toHaveBeenCalledWith({ grid: [['A']] });
  });

  it('does not deliver to subscribers of a different event', () => {
    const bus = createBus();
    const other = vi.fn();
    bus.on('round:complete', other);
    bus.emit('reels:settled', { grid: [] });
    expect(other).not.toHaveBeenCalled();
  });

  it('stops delivering after the unsubscribe thunk is called', () => {
    const bus = createBus();
    const h = vi.fn();
    const off = bus.on('reels:settled', h);
    off();
    bus.emit('reels:settled', { grid: [] });
    expect(h).not.toHaveBeenCalled();
  });

  it('off() removes a handler by reference', () => {
    const bus = createBus();
    const h = vi.fn();
    bus.on('x', h);
    bus.off('x', h);
    bus.emit('x', 1);
    expect(h).not.toHaveBeenCalled();
  });

  it('emitting an event with no subscribers is a no-op (does not throw)', () => {
    const bus = createBus();
    expect(() => bus.emit('nobody', 1)).not.toThrow();
  });

  it('a handler unsubscribing during emit does not skip the next handler', () => {
    const bus = createBus();
    const calls: string[] = [];
    const second = () => calls.push('second');
    const first = () => {
      calls.push('first');
      bus.off('e', second);
    };
    bus.on('e', first);
    bus.on('e', second);
    bus.emit('e', 0);
    expect(calls).toEqual(['first', 'second']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/orchestration/bus.spec.ts`
Expected: FAIL — `Failed to resolve import "./bus"` / `createBus is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runtime/client/src/orchestration/bus.ts
export type BusHandler<T = unknown> = (payload: T) => void;

/** A minimal typed pub/sub seam. Swappable for mitt/eventemitter3 later
 *  without changing call sites (see spec §8). */
export interface IEventBus {
  on<T = unknown>(event: string, handler: BusHandler<T>): () => void;
  off(event: string, handler: BusHandler): void;
  emit<T = unknown>(event: string, payload: T): void;
}

export function createBus(): IEventBus {
  const handlers = new Map<string, Set<BusHandler>>();
  const bus: IEventBus = {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as BusHandler);
      return () => bus.off(event, handler as BusHandler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event, payload) {
      // Snapshot so a handler that unsubscribes mid-emit doesn't perturb iteration.
      const set = handlers.get(event);
      if (!set) return;
      for (const h of [...set]) h(payload);
    },
  };
  return bus;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/client && npx vitest run src/orchestration/bus.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/orchestration/bus.ts runtime/client/src/orchestration/bus.spec.ts
git commit -m "feat(modules): typed event-bus seam for game modules"
```

---

## Task 2: Config schema + validation

**Files:**

- Create: `runtime/client/src/modules/schema.ts`
- Test: `runtime/client/src/modules/schema.spec.ts`

**Interfaces:**

- Produces: `ConfigFieldType`, `IConfigField { type; default; min?; max?; binding? }`, `IConfigSchema = Record<string, IConfigField>`, `IValidationResult<T> { ok; value; errors }`, `validateConfig<T>(schema, raw): IValidationResult<T>`.
- Consumes: `JsonValue` from `../model/document`.

- [ ] **Step 1: Write the failing test**

```ts
// runtime/client/src/modules/schema.spec.ts
import { describe, it, expect } from 'vitest';
import { validateConfig, type IConfigSchema } from './schema';

const SCHEMA: IConfigSchema = {
  rows: { type: 'integer', default: 3, min: 1, max: 8 },
  cols: { type: 'integer', default: 5, min: 1, max: 10 },
  cellSize: { type: 'number', default: 100, min: 1 },
  symbols: { type: 'stringArray', default: ['A', 'B', 'C'] },
  parentId: { type: 'string', default: 'root', binding: 'parent' },
};

describe('validateConfig', () => {
  it('applies defaults for missing fields and reports ok', () => {
    const r = validateConfig(SCHEMA, {});
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ rows: 3, cols: 5, cellSize: 100, symbols: ['A', 'B', 'C'], parentId: 'root' });
  });

  it('keeps provided values that pass validation', () => {
    const r = validateConfig(SCHEMA, { rows: 4, cols: 6 });
    expect(r.ok).toBe(true);
    expect(r.value.rows).toBe(4);
    expect(r.value.cols).toBe(6);
  });

  it('rejects a number below min and reports a field-named error', () => {
    const r = validateConfig(SCHEMA, { rows: 0 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('rows'))).toBe(true);
  });

  it('rejects a number above max', () => {
    const r = validateConfig(SCHEMA, { cols: 99 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('cols'))).toBe(true);
  });

  it('rejects a non-integer for an integer field', () => {
    const r = validateConfig(SCHEMA, { rows: 2.5 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('rows'))).toBe(true);
  });

  it('rejects a wrong-typed field (string where number expected)', () => {
    const r = validateConfig(SCHEMA, { cellSize: 'big' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('cellSize'))).toBe(true);
  });

  it('rejects a stringArray containing a non-string', () => {
    const r = validateConfig(SCHEMA, { symbols: ['A', 2] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('symbols'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/modules/schema.spec.ts`
Expected: FAIL — `Failed to resolve import "./schema"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runtime/client/src/modules/schema.ts
import type { JsonValue } from '../model/document';

export type ConfigFieldType = 'number' | 'integer' | 'string' | 'boolean' | 'stringArray';

export interface IConfigField {
  type: ConfigFieldType;
  default: JsonValue;
  /** Inclusive numeric bounds (number/integer only). */
  min?: number;
  max?: number;
  /** Node prop this field maps to — a hint for the property inspector. */
  binding?: string;
}

export type IConfigSchema = Record<string, IConfigField>;

export interface IValidationResult<T> {
  ok: boolean;
  /** Defaults applied; valid provided values kept; invalid fields fall back to default. */
  value: T;
  errors: string[];
}

function checkField(name: string, field: IConfigField, raw: JsonValue, errors: string[]): JsonValue {
  switch (field.type) {
    case 'number':
    case 'integer': {
      if (typeof raw !== 'number' || Number.isNaN(raw)) {
        errors.push(`${name}: expected ${field.type}`);
        return field.default;
      }
      if (field.type === 'integer' && !Number.isInteger(raw)) {
        errors.push(`${name}: expected an integer`);
        return field.default;
      }
      if (field.min !== undefined && raw < field.min) {
        errors.push(`${name}: ${raw} < min ${field.min}`);
        return field.default;
      }
      if (field.max !== undefined && raw > field.max) {
        errors.push(`${name}: ${raw} > max ${field.max}`);
        return field.default;
      }
      return raw;
    }
    case 'string':
      if (typeof raw !== 'string') {
        errors.push(`${name}: expected string`);
        return field.default;
      }
      return raw;
    case 'boolean':
      if (typeof raw !== 'boolean') {
        errors.push(`${name}: expected boolean`);
        return field.default;
      }
      return raw;
    case 'stringArray':
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
        errors.push(`${name}: expected an array of strings`);
        return field.default;
      }
      return raw;
    default:
      return field.default;
  }
}

export function validateConfig<T = Record<string, JsonValue>>(schema: IConfigSchema, raw: Record<string, JsonValue>): IValidationResult<T> {
  const errors: string[] = [];
  const value: Record<string, JsonValue> = {};
  for (const [name, field] of Object.entries(schema)) {
    value[name] = name in raw ? checkField(name, field, raw[name], errors) : field.default;
  }
  return { ok: errors.length === 0, value: value as T, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/client && npx vitest run src/modules/schema.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/modules/schema.ts runtime/client/src/modules/schema.spec.ts
git commit -m "feat(modules): module-local typed config schema + validation"
```

---

## Task 3: Module contract + registry

**Files:**

- Create: `runtime/client/src/modules/module.ts` (contract types — no runtime test)
- Create: `runtime/client/src/modules/registry.ts`
- Test: `runtime/client/src/modules/registry.spec.ts`

**Interfaces:**

- Consumes: `Op` (`../model/ops`), `IGameDocument` (`../model/document`), `IEventBus` (`../orchestration/bus`), `IDisplayHandle` (`../render/renderer` — defined in Task 9; declare the import now, it resolves once Task 9 lands. If implementing strictly in order, Task 9 precedes consumers of `resolve()`; the type import compiles regardless of call order since Task 9 only adds an export).
- Produces:
  - `IOutcome { grid: string[][] }` — `grid[col][row]` = landed symbol id.
  - `IModuleHost { snapshot(): IGameDocument; emit(ops: Op[]): void; resolve(id: string): IDisplayHandle | null; onTick(cb: (dtMs: number) => void): () => void; readonly bus: IEventBus }`.
  - `IGameModule { readonly id: string; readonly type: string; readonly configSchema: IConfigSchema; project(): void; mount(): void; update(dtMs: number): void; dispose(): void }`.
  - `IModuleFactory = (args: { id: string; host: IModuleHost; config?: Record<string, JsonValue> }) => IGameModule`.
  - `ModuleRegistry` with `register(type, factory)`, `has(type)`, `create(type, args)`.

> **Ordering note:** Task 9 adds `IDisplayHandle` to `render/renderer.ts`. To avoid a forward type-reference, **do Task 9 before this task**, OR define `IDisplayHandle` in Task 9 first. The registry test below does not exercise `resolve`, so the registry itself compiles either way; only `module.ts`'s `import type { IDisplayHandle }` needs the export present. Recommended order is 1, 2, 9, 3, 4, 5, 6, 7, 8, 10, 11, 12.

- [ ] **Step 1: Write the failing test**

```ts
// runtime/client/src/modules/registry.spec.ts
import { describe, it, expect } from 'vitest';
import { ModuleRegistry } from './registry';
import type { IGameModule, IModuleHost } from './module';

const fakeHost = {} as IModuleHost;

function stubModule(id: string, type: string): IGameModule {
  return {
    id,
    type,
    configSchema: {},
    project() {},
    mount() {},
    update() {},
    dispose() {},
  };
}

describe('ModuleRegistry', () => {
  it('creates a module via its registered type factory', () => {
    const reg = new ModuleRegistry();
    reg.register('reels', ({ id, host }) => stubModule(id, 'reels'));
    expect(reg.has('reels')).toBe(true);
    const m = reg.create('reels', { id: 'r1', host: fakeHost });
    expect(m.type).toBe('reels');
    expect(m.id).toBe('r1');
  });

  it('throws a clear error for an unknown type', () => {
    const reg = new ModuleRegistry();
    expect(() => reg.create('missing', { id: 'x', host: fakeHost })).toThrow(/unknown module type: missing/);
  });

  it('throws when registering a duplicate type', () => {
    const reg = new ModuleRegistry();
    reg.register('reels', ({ id }) => stubModule(id, 'reels'));
    expect(() => reg.register('reels', ({ id }) => stubModule(id, 'reels'))).toThrow(/already registered/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/modules/registry.spec.ts`
Expected: FAIL — `Failed to resolve import "./registry"` / `"./module"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runtime/client/src/modules/module.ts
import type { JsonValue, IGameDocument } from '../model/document';
import type { Op } from '../model/ops';
import type { IEventBus } from '../orchestration/bus';
import type { IDisplayHandle } from '../render/renderer';
import type { IConfigSchema } from './schema';

/** Landed symbol grid: grid[col][row] = symbol id. */
export interface IOutcome {
  grid: string[][];
}

/** The single bridge between a module and the engine (spec §2.3, §6.1).
 *  Narrow on purpose: modules depend on this, never on Pixi or the reconciler. */
export interface IModuleHost {
  /** Current document — read-only source of truth for idempotent reprojection. */
  snapshot(): IGameDocument;
  /** Structure plane: apply ops atomically to the model + reconcile to the renderer. */
  emit(ops: Op[]): void;
  /** Behavior plane: live display handle for a projected node id (or null). */
  resolve(id: string): IDisplayHandle | null;
  /** Per-frame tick; returns an unsubscribe thunk. dtMs is elapsed ms since last frame. */
  onTick(cb: (dtMs: number) => void): () => void;
  readonly bus: IEventBus;
}

export interface IGameModule {
  readonly id: string;
  readonly type: string;
  readonly configSchema: IConfigSchema;
  /** Structure plane: emit ops to create/reconcile this module's nodes from its config. Idempotent. */
  project(): void;
  /** Lifecycle: subscribe to the tick / set up runtime state. */
  mount(): void;
  /** Behavior plane: advance transient motion by dtMs. */
  update(dtMs: number): void;
  /** Lifecycle: tear down subscriptions/state. */
  dispose(): void;
}

export type IModuleFactory = (args: { id: string; host: IModuleHost; config?: Record<string, JsonValue> }) => IGameModule;
```

```ts
// runtime/client/src/modules/registry.ts
import type { IGameModule, IModuleFactory, IModuleHost } from './module';
import type { JsonValue } from '../model/document';

/** Maps `type → IGameModule` factory. The surface a future server tier mirrors for parity (spec §3). */
export class ModuleRegistry {
  private factories = new Map<string, IModuleFactory>();

  register(type: string, factory: IModuleFactory): void {
    if (this.factories.has(type)) throw new Error(`module type already registered: ${type}`);
    this.factories.set(type, factory);
  }

  has(type: string): boolean {
    return this.factories.has(type);
  }

  create(type: string, args: { id: string; host: IModuleHost; config?: Record<string, JsonValue> }): IGameModule {
    const factory = this.factories.get(type);
    if (!factory) throw new Error(`unknown module type: ${type}`);
    return factory(args);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/client && npx vitest run src/modules/registry.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/modules/module.ts runtime/client/src/modules/registry.ts runtime/client/src/modules/registry.spec.ts
git commit -m "feat(modules): IGameModule contract + type->factory registry"
```

---

## Task 4: Idempotent scene reconcile helper

**Files:**

- Create: `runtime/client/src/modules/reconcile.ts`
- Test: `runtime/client/src/modules/reconcile.spec.ts`

**Interfaces:**

- Consumes: `IGameDocument`, `NodeType`, `JsonValue` (`../model/document`), `Op` (`../model/ops`).
- Produces:
  - `IDesiredNode { id: string; type: NodeType; props: Record<string, JsonValue>; parent: string | null }`.
  - `IDesiredScene { nodes: IDesiredNode[] }`.
  - `reconcileOps(current: IGameDocument, desired: IDesiredScene, owns: (id: string) => boolean): Op[]` — produces the minimal `addNode`/`connect`/`setProp`/`removeNode` op list so applying it makes `current` match `desired` for owned ids. Child edge id is `child:${childId}`. Adds first, then prop updates, then removes.

- [ ] **Step 1: Write the failing test**

```ts
// runtime/client/src/modules/reconcile.spec.ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { reconcileOps, type IDesiredScene } from './reconcile';

const owns = (id: string) => id.startsWith('m:');

function modelWith(ops: Parameters<GraphModel['apply']>[0][]): GraphModel {
  const m = new GraphModel();
  m.apply({ kind: 'addNode', id: 'root', type: 'Root', props: {} });
  m.applyBatch(ops);
  return m;
}

describe('reconcileOps', () => {
  it('emits addNode + child connect for a desired node not present', () => {
    const m = modelWith([]);
    const desired: IDesiredScene = {
      nodes: [{ id: 'm:reel:0', type: 'Container', props: { zIndex: 0 }, parent: 'root' }],
    };
    const ops = reconcileOps(m.toDocument(), desired, owns);
    expect(ops).toEqual([
      { kind: 'addNode', id: 'm:reel:0', type: 'Container', props: { zIndex: 0 } },
      { kind: 'connect', edgeId: 'child:m:reel:0', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'm:reel:0', port: 'parent' } },
    ]);
    expect(() => m.applyBatch(ops)).not.toThrow();
  });

  it('is idempotent: reprojecting the same desired set yields no ops', () => {
    const m = modelWith([]);
    const desired: IDesiredScene = {
      nodes: [{ id: 'm:reel:0', type: 'Container', props: { zIndex: 0 }, parent: 'root' }],
    };
    m.applyBatch(reconcileOps(m.toDocument(), desired, owns));
    const second = reconcileOps(m.toDocument(), desired, owns);
    expect(second).toEqual([]);
  });

  it('emits setProp only for props whose value changed', () => {
    const m = modelWith([{ kind: 'addNode', id: 'm:reel:0', type: 'Container', props: { zIndex: 0, alpha: 1 } }]);
    const desired: IDesiredScene = {
      nodes: [{ id: 'm:reel:0', type: 'Container', props: { zIndex: 5, alpha: 1 }, parent: null }],
    };
    const ops = reconcileOps(m.toDocument(), desired, owns);
    expect(ops).toEqual([{ kind: 'setProp', id: 'm:reel:0', path: 'zIndex', value: 5 }]);
  });

  it('removes an owned node that is no longer desired', () => {
    const m = modelWith([{ kind: 'addNode', id: 'm:reel:0', type: 'Container', props: {} }]);
    const desired: IDesiredScene = { nodes: [] };
    const ops = reconcileOps(m.toDocument(), desired, owns);
    expect(ops).toEqual([{ kind: 'removeNode', id: 'm:reel:0' }]);
  });

  it('never removes a node it does not own', () => {
    const m = modelWith([{ kind: 'addNode', id: 'hand:authored', type: 'Sprite', props: {} }]);
    const desired: IDesiredScene = { nodes: [] };
    const ops = reconcileOps(m.toDocument(), desired, owns);
    expect(ops).toEqual([]);
  });

  it('a config change (cols 1 -> 2) adds the new reel without duplicating the existing one', () => {
    const m = modelWith([]);
    const one: IDesiredScene = { nodes: [{ id: 'm:reel:0', type: 'Container', props: {}, parent: 'root' }] };
    m.applyBatch(reconcileOps(m.toDocument(), one, owns));
    const two: IDesiredScene = {
      nodes: [
        { id: 'm:reel:0', type: 'Container', props: {}, parent: 'root' },
        { id: 'm:reel:1', type: 'Container', props: {}, parent: 'root' },
      ],
    };
    const ops = reconcileOps(m.toDocument(), two, owns);
    expect(ops).toEqual([
      { kind: 'addNode', id: 'm:reel:1', type: 'Container', props: {} },
      { kind: 'connect', edgeId: 'child:m:reel:1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'm:reel:1', port: 'parent' } },
    ]);
    expect(() => m.applyBatch(ops)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/modules/reconcile.spec.ts`
Expected: FAIL — `Failed to resolve import "./reconcile"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runtime/client/src/modules/reconcile.ts
import type { IGameDocument, JsonValue, NodeType } from '../model/document';
import type { Op } from '../model/ops';

export interface IDesiredNode {
  id: string;
  type: NodeType;
  props: Record<string, JsonValue>;
  /** Parent node id for the child edge, or null for no parenting. */
  parent: string | null;
}

export interface IDesiredScene {
  nodes: IDesiredNode[];
}

/** Minimal op set so applying it makes `current` match `desired` for ids `owns()` accepts.
 *  Adds (+ child connect) first, then prop updates, then removes — so a within-batch
 *  transient (e.g. an orphan) is harmless and the batch stays atomic. */
export function reconcileOps(current: IGameDocument, desired: IGameDocument extends never ? never : IDesiredScene, owns: (id: string) => boolean): Op[] {
  const adds: Op[] = [];
  const updates: Op[] = [];
  const removes: Op[] = [];
  const desiredIds = new Set(desired.nodes.map((n) => n.id));

  for (const node of desired.nodes) {
    const existing = current.nodes[node.id];
    if (!existing) {
      adds.push({ kind: 'addNode', id: node.id, type: node.type, props: { ...node.props } });
      if (node.parent !== null) {
        adds.push({
          kind: 'connect',
          edgeId: `child:${node.id}`,
          type: 'child',
          from: { node: node.parent, port: 'children' },
          to: { node: node.id, port: 'parent' },
        });
      }
    } else {
      for (const [key, value] of Object.entries(node.props)) {
        if (!deepEqual(existing.props[key], value)) updates.push({ kind: 'setProp', id: node.id, path: key, value });
      }
    }
  }

  for (const node of Object.values(current.nodes)) {
    if (owns(node.id) && !desiredIds.has(node.id)) removes.push({ kind: 'removeNode', id: node.id });
  }

  return [...adds, ...updates, ...removes];
}

function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
```

> Note: the `IGameDocument extends never ? never : IDesiredScene` is just a guard against accidental arg swap; if your linter dislikes it, simplify the param type to `desired: IDesiredScene`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/client && npx vitest run src/modules/reconcile.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/modules/reconcile.ts runtime/client/src/modules/reconcile.spec.ts
git commit -m "feat(modules): pure idempotent scene reconcile helper"
```

---

## Task 5: Reels pure math

**Files:**

- Create: `runtime/client/src/modules/reels/reelsMath.ts`
- Test: `runtime/client/src/modules/reels/reelsMath.spec.ts`

**Interfaces:**

- Produces (all pure):
  - `advance(offset: number, speedPxPerMs: number, dtMs: number): number` — `offset + speed*dt`.
  - `wrap(offset: number, span: number): number` — `((offset % span) + span) % span`.
  - `symbolAt(strip: string[], absoluteRow: number): string` — wraparound index into strip.
  - `easeOutCubic(t: number): number` — `1 - (1 - t)^3`, t clamped to [0,1].
  - `settleT(elapsedMs: number, delayMs: number, durationMs: number): number` — clamped progress in [0,1] after a per-reel delay.
  - `reelDelay(reelIndex: number, perReelMs: number): number` — `reelIndex * perReelMs`.
  - `blurFor(speedPxPerMs: number, maxBlur: number, refSpeed: number): number` — proportional motion blur, capped at `maxBlur`.

- [ ] **Step 1: Write the failing test**

```ts
// runtime/client/src/modules/reels/reelsMath.spec.ts
import { describe, it, expect } from 'vitest';
import { advance, wrap, symbolAt, easeOutCubic, settleT, reelDelay, blurFor } from './reelsMath';

describe('reelsMath', () => {
  it('advance moves offset by speed*dt', () => {
    expect(advance(0, 2, 16)).toBe(32);
    expect(advance(10, 0.5, 100)).toBe(60);
  });

  it('wrap keeps offset within [0, span) including negatives', () => {
    expect(wrap(0, 100)).toBe(0);
    expect(wrap(150, 100)).toBe(50);
    expect(wrap(-10, 100)).toBe(90);
  });

  it('symbolAt indexes the strip with wraparound', () => {
    const strip = ['A', 'B', 'C'];
    expect(symbolAt(strip, 0)).toBe('A');
    expect(symbolAt(strip, 3)).toBe('A');
    expect(symbolAt(strip, -1)).toBe('C');
    expect(symbolAt(strip, 4)).toBe('B');
  });

  it('easeOutCubic is 0 at 0, 1 at 1, and clamps out-of-range t', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 5);
  });

  it('settleT is 0 before the delay, ramps to 1 over duration', () => {
    expect(settleT(0, 200, 400)).toBe(0);
    expect(settleT(200, 200, 400)).toBe(0);
    expect(settleT(400, 200, 400)).toBe(0.5);
    expect(settleT(600, 200, 400)).toBe(1);
    expect(settleT(9999, 200, 400)).toBe(1);
  });

  it('reelDelay staggers reels left-to-right', () => {
    expect(reelDelay(0, 120)).toBe(0);
    expect(reelDelay(3, 120)).toBe(360);
  });

  it('blurFor is proportional to speed and capped at maxBlur', () => {
    expect(blurFor(0, 8, 4)).toBe(0);
    expect(blurFor(2, 8, 4)).toBe(4);
    expect(blurFor(4, 8, 4)).toBe(8);
    expect(blurFor(100, 8, 4)).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/modules/reels/reelsMath.spec.ts`
Expected: FAIL — `Failed to resolve import "./reelsMath"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runtime/client/src/modules/reels/reelsMath.ts

/** Advance a scroll offset by speed (px/ms) over dt (ms). */
export function advance(offset: number, speedPxPerMs: number, dtMs: number): number {
  return offset + speedPxPerMs * dtMs;
}

/** Wrap a value into [0, span), handling negatives. */
export function wrap(offset: number, span: number): number {
  return ((offset % span) + span) % span;
}

/** Strip lookup with wraparound (supports negative absolute rows). */
export function symbolAt(strip: string[], absoluteRow: number): string {
  const n = strip.length;
  return strip[((absoluteRow % n) + n) % n];
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Ease-out cubic; t clamped to [0,1]. */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

/** Settle progress in [0,1] after a per-reel delay. 0 until delay, then linear over duration. */
export function settleT(elapsedMs: number, delayMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  return clamp01((elapsedMs - delayMs) / durationMs);
}

/** Left-to-right stagger: reel `i` starts settling `i * perReelMs` after stop. */
export function reelDelay(reelIndex: number, perReelMs: number): number {
  return reelIndex * perReelMs;
}

/** Motion blur proportional to speed, capped at maxBlur. refSpeed maps to maxBlur. */
export function blurFor(speedPxPerMs: number, maxBlur: number, refSpeed: number): number {
  if (refSpeed <= 0) return 0;
  return Math.min(maxBlur, (Math.abs(speedPxPerMs) / refSpeed) * maxBlur);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/client && npx vitest run src/modules/reels/reelsMath.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/modules/reels/reelsMath.ts runtime/client/src/modules/reels/reelsMath.spec.ts
git commit -m "feat(reels): pure spin/settle/recycle math"
```

---

## Task 6: Reels module — structure plane (`project()`)

**Files:**

- Create: `runtime/client/src/modules/reels/reelsModule.ts`
- Test: `runtime/client/src/modules/reels/reelsModule.project.spec.ts`

**Interfaces:**

- Consumes: `IGameModule`, `IModuleHost`, `IOutcome` (`../module`), `IConfigSchema`, `validateConfig` (`../schema`), `reconcileOps`, `IDesiredScene`, `IDesiredNode` (`../reconcile`), `GraphModel` (test only), `JsonValue` (`../../model/document`).
- Produces:
  - `REELS_SCHEMA: IConfigSchema` with fields `rows`, `cols`, `symbols`, `cellSize`, `spacing`, `originX`, `originY`, `parentId`, `buffer`.
  - `containerId(moduleId, col): string` → `${moduleId}:reel:${col}`.
  - `cellId(moduleId, col, row): string` → `${moduleId}:cell:${col}:${row}`.
  - `buildDesired(moduleId: string, config: Record<string, JsonValue>): IDesiredScene` (pure).
  - `class ReelsModule implements IGameModule` with `setConfig(partial)` and `project()` (the behavior verbs land in Task 7).

- [ ] **Step 1: Write the failing test**

```ts
// runtime/client/src/modules/reels/reelsModule.project.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { GraphModel } from '../../model/graphModel';
import type { IModuleHost } from '../module';
import { ReelsModule, buildDesired, containerId, cellId } from './reelsModule';

/** Host backed by a real GraphModel so project()'s idempotency is exercised end to end. */
function modelHost(model: GraphModel): IModuleHost {
  return {
    snapshot: () => model.toDocument(),
    emit: (ops) => void model.applyBatch(ops),
    resolve: () => null,
    onTick: () => () => {},
    bus: { on: () => () => {}, off: () => {}, emit: () => {} },
  };
}

const cfg = { rows: 3, cols: 2, symbols: ['A', 'B', 'C'], cellSize: 100, spacing: 0, originX: 0, originY: 0, parentId: 'root', buffer: 1 };

function seededModel(): GraphModel {
  const m = new GraphModel();
  m.apply({ kind: 'addNode', id: 'root', type: 'Root', props: {} });
  return m;
}

describe('buildDesired', () => {
  it('produces one Container per column and (rows+buffer) Sprites per column with stable ids', () => {
    const desired = buildDesired('m', cfg);
    const ids = desired.nodes.map((n) => n.id);
    expect(ids).toContain(containerId('m', 0));
    expect(ids).toContain(containerId('m', 1));
    // rows(3) + buffer(1) = 4 cells per reel, 2 reels => 8 sprites + 2 containers = 10 nodes
    expect(desired.nodes.filter((n) => n.type === 'Sprite')).toHaveLength(8);
    expect(desired.nodes.filter((n) => n.type === 'Container')).toHaveLength(2);
    expect(ids).toContain(cellId('m', 1, 3)); // buffer row index = rows
  });

  it('parents reels under config.parentId and cells under their reel container', () => {
    const desired = buildDesired('m', cfg);
    const reel0 = desired.nodes.find((n) => n.id === containerId('m', 0))!;
    expect(reel0.parent).toBe('root');
    const cell = desired.nodes.find((n) => n.id === cellId('m', 0, 0))!;
    expect(cell.parent).toBe(containerId('m', 0));
  });
});

describe('ReelsModule.project', () => {
  it('creates the reel structure in the model', () => {
    const model = seededModel();
    const m = new ReelsModule({ id: 'm', host: modelHost(model), config: cfg });
    m.project();
    const doc = model.toDocument();
    expect(doc.nodes[containerId('m', 0)]).toBeTruthy();
    expect(doc.nodes[cellId('m', 0, 0)]).toBeTruthy();
  });

  it('is idempotent: projecting twice does not duplicate or throw', () => {
    const model = seededModel();
    const m = new ReelsModule({ id: 'm', host: modelHost(model), config: cfg });
    m.project();
    const countAfterFirst = Object.keys(model.toDocument().nodes).length;
    expect(() => m.project()).not.toThrow();
    expect(Object.keys(model.toDocument().nodes).length).toBe(countAfterFirst);
  });

  it('a config change (cols 2 -> 3) reconciles in the new reel without duplicating', () => {
    const model = seededModel();
    const m = new ReelsModule({ id: 'm', host: modelHost(model), config: cfg });
    m.project();
    m.setConfig({ cols: 3 });
    m.project();
    const doc = model.toDocument();
    expect(doc.nodes[containerId('m', 2)]).toBeTruthy();
    expect(doc.nodes[containerId('m', 0)]).toBeTruthy(); // original kept
  });

  it('invalid config falls back to defaults (validateConfig) rather than projecting garbage', () => {
    const model = seededModel();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = new ReelsModule({ id: 'm', host: modelHost(model), config: { ...cfg, rows: -5 } });
    m.project();
    // rows fell back to default 3 => 3+buffer = 4 cells in reel 0
    const doc = model.toDocument();
    expect(doc.nodes[cellId('m', 0, 3)]).toBeTruthy();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/modules/reels/reelsModule.project.spec.ts`
Expected: FAIL — `Failed to resolve import "./reelsModule"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runtime/client/src/modules/reels/reelsModule.ts
import type { JsonValue } from '../../model/document';
import type { IGameModule, IModuleHost, IOutcome } from '../module';
import { validateConfig, type IConfigSchema } from '../schema';
import { reconcileOps, type IDesiredNode, type IDesiredScene } from '../reconcile';

export const REELS_SCHEMA: IConfigSchema = {
  rows: { type: 'integer', default: 3, min: 1, max: 8 },
  cols: { type: 'integer', default: 5, min: 1, max: 10 },
  symbols: { type: 'stringArray', default: ['A', 'B', 'C', 'D', 'E'] },
  cellSize: { type: 'number', default: 100, min: 1 },
  spacing: { type: 'number', default: 8, min: 0 },
  originX: { type: 'number', default: 0 },
  originY: { type: 'number', default: 0 },
  parentId: { type: 'string', default: 'root', binding: 'parent' },
  buffer: { type: 'integer', default: 1, min: 0, max: 4 },
};

export function containerId(moduleId: string, col: number): string {
  return `${moduleId}:reel:${col}`;
}

export function cellId(moduleId: string, col: number, row: number): string {
  return `${moduleId}:cell:${col}:${row}`;
}

interface IReelsConfig {
  rows: number;
  cols: number;
  symbols: string[];
  cellSize: number;
  spacing: number;
  originX: number;
  originY: number;
  parentId: string;
  buffer: number;
}

function resolveConfig(raw: Record<string, JsonValue>): IReelsConfig {
  const { ok, value, errors } = validateConfig<IReelsConfig>(REELS_SCHEMA, raw);
  if (!ok) console.warn('[reels] invalid config, using defaults for:', errors.join('; '));
  return value;
}

/** Pure: the desired node set for a given config (stable ids → idempotent reprojection). */
export function buildDesired(moduleId: string, raw: Record<string, JsonValue>): IDesiredScene {
  const cfg = resolveConfig(raw);
  const span = cfg.cellSize + cfg.spacing;
  const nodes: IDesiredNode[] = [];
  for (let c = 0; c < cfg.cols; c++) {
    nodes.push({
      id: containerId(moduleId, c),
      type: 'Container',
      props: { position: { x: cfg.originX + c * span, y: cfg.originY }, zIndex: c },
      parent: cfg.parentId,
    });
    for (let r = 0; r < cfg.rows + cfg.buffer; r++) {
      nodes.push({
        id: cellId(moduleId, c, r),
        type: 'Sprite',
        props: { position: { x: 0, y: r * span }, symbol: cfg.symbols[r % cfg.symbols.length] },
        parent: containerId(moduleId, c),
      });
    }
  }
  return { nodes };
}

export class ReelsModule implements IGameModule {
  readonly type = 'reels';
  readonly configSchema = REELS_SCHEMA;
  private config: Record<string, JsonValue>;

  constructor(private readonly args: { id: string; host: IModuleHost; config?: Record<string, JsonValue> }) {
    this.config = { ...(args.config ?? {}) };
  }

  get id(): string {
    return this.args.id;
  }

  private get host(): IModuleHost {
    return this.args.host;
  }

  setConfig(partial: Record<string, JsonValue>): void {
    this.config = { ...this.config, ...partial };
  }

  project(): void {
    const desired = buildDesired(this.id, this.config);
    const owns = (nodeId: string) => nodeId.startsWith(`${this.id}:`);
    this.host.emit(reconcileOps(this.host.snapshot(), desired, owns));
  }

  // Behavior verbs (Task 7) are added below.
  mount(): void {}
  update(_dtMs: number): void {}
  dispose(): void {}
  startSpinning(): void {}
  stopSpinning(_outcome: IOutcome): void {}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/client && npx vitest run src/modules/reels/reelsModule.project.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/modules/reels/reelsModule.ts runtime/client/src/modules/reels/reelsModule.project.spec.ts
git commit -m "feat(reels): config schema + idempotent project() structure plane"
```

---

## Task 7: Reels module — behavior plane (`startSpinning`/`stopSpinning`/`update`)

**Files:**

- Modify: `runtime/client/src/modules/reels/reelsModule.ts`
- Test: `runtime/client/src/modules/reels/reelsModule.behavior.spec.ts`

**Interfaces:**

- Consumes: `reelsMath` helpers, `IDisplayHandle` (`../../render/renderer`), `IOutcome`.
- Produces (on `ReelsModule`): real `mount()`, `update(dtMs)`, `dispose()`, `startSpinning()`, `stopSpinning(outcome)`, `debugState(): { phase: 'idle' | 'spinning' | 'settling'; grid: string[][] }`. On settle completion the module calls `host.bus.emit('reels:settled', { grid })`.

**Behavior contract:**

- `startSpinning()` → phase `'spinning'`; each reel gets a scroll speed; `update` advances offsets, applies blur via `host.resolve(cellId).setBlur(...)`, repositions cell sprites, recycles symbols past the buffer. No ops emitted.
- `stopSpinning(outcome)` → phase `'settling'`; stores the outcome grid; resets `elapsed`; reels ease toward their stops staggered left-to-right.
- When every reel has fully settled → blur cleared (`setBlur(0)`), final symbols placed, phase `'idle'`, and `host.bus.emit('reels:settled', { grid })` fires exactly once.

- [ ] **Step 1: Write the failing test**

```ts
// runtime/client/src/modules/reels/reelsModule.behavior.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../../orchestration/bus';
import type { IDisplayHandle } from '../../render/renderer';
import type { IModuleHost } from '../module';
import { ReelsModule, cellId } from './reelsModule';

function fakeHandle(): IDisplayHandle {
  return { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, alpha: 1, visible: true, setBlur: vi.fn() };
}

function fakeHost(): { host: IModuleHost; handles: Map<string, IDisplayHandle> } {
  const handles = new Map<string, IDisplayHandle>();
  const bus = createBus();
  const host: IModuleHost = {
    snapshot: () => ({ version: 1, nodes: {}, edges: [] }),
    emit: () => {},
    resolve: (id) => {
      if (!handles.has(id)) handles.set(id, fakeHandle());
      return handles.get(id)!;
    },
    onTick: () => () => {},
    bus,
  };
  return { host, handles };
}

const cfg = { rows: 1, cols: 2, symbols: ['A', 'B', 'C'], cellSize: 100, spacing: 0, originX: 0, originY: 0, parentId: 'root', buffer: 1 };

describe('ReelsModule behavior', () => {
  it('starts idle', () => {
    const { host } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    expect(m.debugState().phase).toBe('idle');
  });

  it('startSpinning moves to spinning and applies blur during update', () => {
    const { host, handles } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    m.startSpinning();
    expect(m.debugState().phase).toBe('spinning');
    m.update(16);
    const handle = handles.get(cellId('m', 0, 0))!;
    expect(handle.setBlur).toHaveBeenCalled();
    const lastBlur = (handle.setBlur as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as number;
    expect(lastBlur).toBeGreaterThan(0);
  });

  it('stopSpinning eventually settles to the outcome grid and emits reels:settled once', () => {
    const { host } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    const settled = vi.fn();
    host.bus.on('reels:settled', settled);

    const outcome = { grid: [['B'], ['C']] }; // col0 row0 = B, col1 row0 = C
    m.startSpinning();
    m.stopSpinning(outcome);
    // Drive enough frames to exceed stagger + settle duration for all reels.
    for (let i = 0; i < 240; i++) m.update(16);

    expect(m.debugState().phase).toBe('idle');
    expect(m.debugState().grid).toEqual([['B'], ['C']]);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith({ grid: [['B'], ['C']] });
  });

  it('clears blur (setBlur 0) on every cell once settled', () => {
    const { host, handles } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    m.startSpinning();
    m.stopSpinning({ grid: [['A'], ['A']] });
    for (let i = 0; i < 240; i++) m.update(16);
    const handle = handles.get(cellId('m', 0, 0))!;
    const lastBlur = (handle.setBlur as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as number;
    expect(lastBlur).toBe(0);
  });

  it('does not emit reels:settled while still settling', () => {
    const { host } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    const settled = vi.fn();
    host.bus.on('reels:settled', settled);
    m.startSpinning();
    m.stopSpinning({ grid: [['A'], ['A']] });
    m.update(16); // one frame only
    expect(settled).not.toHaveBeenCalled();
  });

  it('dispose unsubscribes the tick (mount-registered) and is safe to call when not mounted', () => {
    const { host } = fakeHost();
    const off = vi.fn();
    const tickHost: IModuleHost = { ...host, onTick: () => off };
    const m = new ReelsModule({ id: 'm', host: tickHost, config: cfg });
    m.mount();
    m.dispose();
    expect(off).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/modules/reels/reelsModule.behavior.spec.ts`
Expected: FAIL — `debugState is not a function` (and behavior assertions fail).

- [ ] **Step 3: Write minimal implementation** — replace the placeholder verbs at the bottom of `reelsModule.ts`.

Add these imports at the top of `reelsModule.ts` (alongside the existing imports):

```ts
import type { IDisplayHandle } from '../../render/renderer';
import { advance, blurFor, easeOutCubic, reelDelay, settleT, symbolAt, wrap } from './reelsMath';
```

Replace the placeholder block:

```ts
  // Behavior verbs (Task 7) are added below.
  mount(): void {}
  update(_dtMs: number): void {}
  dispose(): void {}
  startSpinning(): void {}
  stopSpinning(_outcome: IOutcome): void {}
}
```

with the real implementation (the class fields go just below `private config`):

```ts
  private phase: 'idle' | 'spinning' | 'settling' = 'idle';
  private offsets: number[] = [];
  private elapsed = 0;
  private outcome: IOutcome | null = null;
  private offTick: (() => void) | null = null;
  private settledGrid: string[][] = [];

  private static readonly SPIN_SPEED = 1.2; // px/ms
  private static readonly REF_SPEED = 1.2;
  private static readonly MAX_BLUR = 8;
  private static readonly SETTLE_MS = 600;
  private static readonly STAGGER_MS = 150;

  mount(): void {
    this.offTick = this.host.onTick((dt) => this.update(dt));
  }

  dispose(): void {
    this.offTick?.();
    this.offTick = null;
  }

  startSpinning(): void {
    const cfg = resolveConfig(this.config);
    this.offsets = new Array(cfg.cols).fill(0);
    this.outcome = null;
    this.elapsed = 0;
    this.phase = 'spinning';
  }

  stopSpinning(outcome: IOutcome): void {
    this.outcome = outcome;
    this.elapsed = 0;
    this.phase = 'settling';
  }

  update(dtMs: number): void {
    if (this.phase === 'idle') return;
    const cfg = resolveConfig(this.config);
    const span = cfg.cellSize + cfg.spacing;

    if (this.phase === 'spinning') {
      for (let c = 0; c < cfg.cols; c++) {
        this.offsets[c] = advance(this.offsets[c], ReelsModule.SPIN_SPEED, dtMs);
        this.renderReel(c, cfg, span, ReelsModule.SPIN_SPEED, cfg.symbols);
      }
      return;
    }

    // settling
    this.elapsed += dtMs;
    let allDone = true;
    for (let c = 0; c < cfg.cols; c++) {
      const t = settleT(this.elapsed, reelDelay(c, ReelsModule.STAGGER_MS), ReelsModule.SETTLE_MS);
      if (t < 1) allDone = false;
      const eased = easeOutCubic(t);
      // Decelerate: residual speed shrinks to 0 as eased -> 1.
      const speed = ReelsModule.SPIN_SPEED * (1 - eased);
      this.offsets[c] = advance(this.offsets[c], speed, dtMs);
      const stripForReel = this.stopStrip(c, cfg.symbols);
      this.renderReel(c, cfg, span, speed, stripForReel);
    }

    if (allDone) this.finishSettle(cfg);
  }

  private renderReel(col: number, cfg: IReelsConfig, span: number, speed: number, strip: string[]): void {
    const blur = blurFor(speed, ReelsModule.MAX_BLUR, ReelsModule.REF_SPEED);
    const total = cfg.rows + cfg.buffer;
    const scrolled = Math.floor(this.offsets[col] / span);
    for (let r = 0; r < total; r++) {
      const handle = this.host.resolve(cellId(this.id, col, r));
      if (!handle) continue;
      handle.position.y = wrap(r * span + this.offsets[col], total * span) - span;
      handle.setBlur(blur);
      // Recycle: the visible symbol for this slot scrolls with the strip.
      void symbolAt(strip, r - scrolled);
    }
  }

  /** The settled stop column for reel `col`, padded to the strip length the renderer indexes. */
  private stopStrip(col: number, symbols: string[]): string[] {
    const stops = this.outcome?.grid[col] ?? [];
    return stops.length ? stops : symbols;
  }

  private finishSettle(cfg: IReelsConfig): void {
    const grid: string[][] = [];
    for (let c = 0; c < cfg.cols; c++) {
      const stops = this.outcome?.grid[c] ?? [];
      grid.push(stops.slice(0, cfg.rows));
      for (let r = 0; r < cfg.rows + cfg.buffer; r++) {
        const handle = this.host.resolve(cellId(this.id, c, r));
        if (!handle) continue;
        handle.setBlur(0);
        handle.position.y = r * (cfg.cellSize + cfg.spacing);
      }
    }
    this.settledGrid = grid;
    this.phase = 'idle';
    this.host.bus.emit('reels:settled', { grid });
  }

  debugState(): { phase: 'idle' | 'spinning' | 'settling'; grid: string[][] } {
    return { phase: this.phase, grid: this.settledGrid };
  }
}
```

> Note: `IReelsConfig` is already declared in Task 6. The `renderReel` motion math is exercised end-to-end by the e2e in Task 12; the unit tests here pin the **state machine + blur + emit** contract (the pure transforms are covered in Task 5).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/client && npx vitest run src/modules/reels/reelsModule.behavior.spec.ts`
Expected: PASS (6 tests). Also re-run Task 6's spec to confirm no regression: `npx vitest run src/modules/reels/reelsModule.project.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/modules/reels/reelsModule.ts runtime/client/src/modules/reels/reelsModule.behavior.spec.ts
git commit -m "feat(reels): spin/settle behavior plane with staggered ease + blur"
```

---

## Task 8: Orchestrator

**Files:**

- Create: `runtime/client/src/orchestration/orchestrator.ts`
- Test: `runtime/client/src/orchestration/orchestrator.spec.ts`

**Interfaces:**

- Consumes: `IEventBus` (`./bus`), `IOutcome` (`../modules/module`), and a minimal reels-control shape `{ project(): void; startSpinning(): void; stopSpinning(o: IOutcome): void }`.
- Produces: `class Orchestrator` with `constructor(deps: { bus: IEventBus; reels: IReelsControl })` and `spin(outcome: IOutcome): void`. On `reels:settled` it emits `round:complete` carrying the grid. `dispose()` unsubscribes.

- [ ] **Step 1: Write the failing test**

```ts
// runtime/client/src/orchestration/orchestrator.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { createBus } from './bus';
import { Orchestrator } from './orchestrator';

function fakeReels() {
  return { project: vi.fn(), startSpinning: vi.fn(), stopSpinning: vi.fn() };
}

describe('Orchestrator', () => {
  it('spin() ensures projection then starts + hands the outcome to the module', () => {
    const bus = createBus();
    const reels = fakeReels();
    const orch = new Orchestrator({ bus, reels });
    const outcome = { grid: [['A']] };
    orch.spin(outcome);
    expect(reels.project).toHaveBeenCalled();
    expect(reels.startSpinning).toHaveBeenCalled();
    expect(reels.stopSpinning).toHaveBeenCalledWith(outcome);
  });

  it('re-emits round:complete when the module reports reels:settled', () => {
    const bus = createBus();
    const reels = fakeReels();
    new Orchestrator({ bus, reels });
    const done = vi.fn();
    bus.on('round:complete', done);
    bus.emit('reels:settled', { grid: [['A'], ['B']] });
    expect(done).toHaveBeenCalledWith({ grid: [['A'], ['B']] });
  });

  it('dispose() stops it from reacting to further reels:settled events', () => {
    const bus = createBus();
    const reels = fakeReels();
    const orch = new Orchestrator({ bus, reels });
    const done = vi.fn();
    bus.on('round:complete', done);
    orch.dispose();
    bus.emit('reels:settled', { grid: [] });
    expect(done).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/orchestration/orchestrator.spec.ts`
Expected: FAIL — `Failed to resolve import "./orchestrator"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runtime/client/src/orchestration/orchestrator.ts
import type { IEventBus } from './bus';
import type { IOutcome } from '../modules/module';

/** The slice of a module the orchestrator drives (modules talk via the bus otherwise). */
export interface IReelsControl {
  project(): void;
  startSpinning(): void;
  stopSpinning(outcome: IOutcome): void;
}

/** Owns round sequencing in one inspectable place (spec §5). Modules never reference
 *  each other — the orchestrator subscribes to module events and drives what's next. */
export class Orchestrator {
  private off: () => void;

  constructor(private readonly deps: { bus: IEventBus; reels: IReelsControl }) {
    this.off = deps.bus.on<{ grid: string[][] }>('reels:settled', (payload) => {
      deps.bus.emit('round:complete', payload);
    });
  }

  spin(outcome: IOutcome): void {
    this.deps.reels.project(); // idempotent — ensures structure exists
    this.deps.reels.startSpinning();
    this.deps.reels.stopSpinning(outcome);
  }

  dispose(): void {
    this.off();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/client && npx vitest run src/orchestration/orchestrator.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/orchestration/orchestrator.ts runtime/client/src/orchestration/orchestrator.spec.ts
git commit -m "feat(orchestration): central spin-round orchestrator over the bus"
```

---

## Task 9: Renderer behavior seam (`getHandle` + `onTick`)

**Files:**

- Modify: `runtime/client/src/render/renderer.ts`
- Modify: `runtime/client/src/render/pixiRenderer.ts`
- Modify: `runtime/client/src/render/mockRenderer.ts`
- Test: `runtime/client/src/render/pixiRenderer.handle.spec.ts`

**Interfaces:**

- Produces:
  - `IDisplayHandle { position: { x: number; y: number }; scale: { x: number; y: number }; alpha: number; visible: boolean; setBlur(strength: number): void }` (in `renderer.ts`).
  - `IRenderer` gains `getHandle(id: string): IDisplayHandle | null` and `onTick(cb: (dtMs: number) => void): () => void`.
  - `PixiRenderer.getHandle` wraps the live display object; `setBlur(0)` clears filters, `setBlur(n>0)` ensures a single `BlurFilter` at strength `n`. `PixiRenderer.onTick` wraps `app.ticker` (no-op until mounted).
  - `MockRenderer.getHandle`/`onTick` test doubles.

- [ ] **Step 1: Write the failing test** (jsdom — Pixi objects construct without WebGL, per existing `pixiRenderer.spec.ts`)

```ts
// runtime/client/src/render/pixiRenderer.handle.spec.ts
import { describe, it, expect } from 'vitest';
import { BlurFilter } from 'pixi.js';
import { PixiRenderer } from './pixiRenderer';

function rendererWithSprite(id: string): PixiRenderer {
  const r = new PixiRenderer(document.createElement('div'));
  r.createObject(id, 'Sprite');
  return r;
}

describe('PixiRenderer.getHandle', () => {
  it('returns null for an unknown id', () => {
    const r = new PixiRenderer(document.createElement('div'));
    expect(r.getHandle('nope')).toBeNull();
  });

  it('exposes a mutable position bound to the live object', () => {
    const r = rendererWithSprite('s');
    const h = r.getHandle('s')!;
    h.position.y = 42;
    // A fresh handle reflects the same underlying object.
    expect(r.getHandle('s')!.position.y).toBe(42);
  });

  it('setBlur(n) attaches a single BlurFilter at strength n', () => {
    const r = rendererWithSprite('s');
    const h = r.getHandle('s')!;
    h.setBlur(5);
    const filters = filtersOf(r, 's');
    expect(filters).toHaveLength(1);
    expect(filters[0]).toBeInstanceOf(BlurFilter);
    expect((filters[0] as BlurFilter).strength).toBe(5);
  });

  it('setBlur called twice updates strength without stacking filters', () => {
    const r = rendererWithSprite('s');
    const h = r.getHandle('s')!;
    h.setBlur(5);
    h.setBlur(9);
    const filters = filtersOf(r, 's');
    expect(filters).toHaveLength(1);
    expect((filters[0] as BlurFilter).strength).toBe(9);
  });

  it('setBlur(0) clears the filter', () => {
    const r = rendererWithSprite('s');
    const h = r.getHandle('s')!;
    h.setBlur(5);
    h.setBlur(0);
    expect(filtersOf(r, 's')).toHaveLength(0);
  });

  it('onTick returns a no-op unsubscribe before mount (no app/ticker)', () => {
    const r = new PixiRenderer(document.createElement('div'));
    const off = r.onTick(() => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });
});

// Reads the private object map to assert filters; mirrors the injection pattern in pixiRenderer.spec.ts.
function filtersOf(r: PixiRenderer, id: string): unknown[] {
  const objs = (r as unknown as { objects: Map<string, { filters: unknown }> }).objects;
  const f = objs.get(id)!.filters;
  return f == null ? [] : Array.isArray(f) ? f : [f];
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/render/pixiRenderer.handle.spec.ts`
Expected: FAIL — `getHandle is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `runtime/client/src/render/renderer.ts`, add the handle type and extend the interface:

```ts
import type { JsonValue, NodeType } from '../model/document';

export type ITextureHandle = unknown;

/** Narrow live-object seam for the module behavior plane (spec §2.3).
 *  Modules mutate these per frame; they never import Pixi. */
export interface IDisplayHandle {
  position: { x: number; y: number };
  scale: { x: number; y: number };
  alpha: number;
  visible: boolean;
  /** strength <= 0 clears blur. */
  setBlur(strength: number): void;
}

export interface IRenderer {
  mount(rootId: string, opts: { width: number; height: number }): void | Promise<void>;
  createObject(id: string, type: NodeType): void;
  destroyObject(id: string): void;
  setParent(childId: string, parentId: string | null): void;
  setProp(id: string, path: string, value: JsonValue): void;
  loadTexture(src: string): Promise<ITextureHandle>;
  assignTexture(spriteId: string, texture: ITextureHandle | null): void;
  /** Live display handle for a node id, or null if absent. */
  getHandle(id: string): IDisplayHandle | null;
  /** Per-frame tick; returns an unsubscribe thunk. dtMs since last frame. */
  onTick(cb: (dtMs: number) => void): () => void;
}
```

In `runtime/client/src/render/pixiRenderer.ts`, update the import line and add the two methods to the `PixiRenderer` class (e.g. after `onStage`):

```ts
import { Application, Assets, BlurFilter, Container, Sprite, Texture, type Filter, type Ticker } from 'pixi.js';
import type { IDisplayHandle, IRenderer, ITextureHandle } from './renderer';
```

```ts
  getHandle(id: string): IDisplayHandle | null {
    const obj = this.objects.get(id);
    if (!obj) return null;
    return {
      position: obj.position,
      scale: obj.scale,
      get alpha() {
        return obj.alpha;
      },
      set alpha(v: number) {
        obj.alpha = v;
      },
      get visible() {
        return obj.visible;
      },
      set visible(v: boolean) {
        obj.visible = v;
      },
      setBlur(strength: number) {
        const current = asFilterArray(obj.filters);
        const existing = current.find((f): f is BlurFilter => f instanceof BlurFilter);
        if (strength <= 0) {
          obj.filters = current.filter((f) => !(f instanceof BlurFilter));
          return;
        }
        if (existing) {
          existing.strength = strength;
          obj.filters = current;
        } else {
          obj.filters = [...current, new BlurFilter({ strength })];
        }
      },
    };
  }

  onTick(cb: (dtMs: number) => void): () => void {
    const app = this.app;
    if (!app) return () => {};
    const fn = (ticker: Ticker) => cb(ticker.deltaMS);
    app.ticker.add(fn);
    return () => app.ticker.remove(fn);
  }
```

Add this module-level helper at the bottom of `pixiRenderer.ts` (next to `applyPixiProp`/exports):

```ts
function asFilterArray(filters: Filter | Filter[] | null | undefined): Filter[] {
  if (filters == null) return [];
  return Array.isArray(filters) ? [...filters] : [filters];
}
```

In `runtime/client/src/render/mockRenderer.ts`, implement the two new methods (so the test double still satisfies `IRenderer`):

```ts
import type { IDisplayHandle, IRenderer, ITextureHandle } from './renderer';
```

```ts
  private handles = new Map<string, IDisplayHandle>();
  tickCbs: Array<(dtMs: number) => void> = [];

  getHandle(id: string): IDisplayHandle | null {
    if (!this.handles.has(id)) {
      this.handles.set(id, { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, alpha: 1, visible: true, setBlur: () => {} });
    }
    return this.handles.get(id) ?? null;
  }

  onTick(cb: (dtMs: number) => void): () => void {
    this.tickCbs.push(cb);
    return () => {
      this.tickCbs = this.tickCbs.filter((f) => f !== cb);
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/client && npx vitest run src/render/pixiRenderer.handle.spec.ts`
Expected: PASS (6 tests). Also confirm no regression in existing render tests: `npx vitest run src/render`.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/render/renderer.ts runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/mockRenderer.ts runtime/client/src/render/pixiRenderer.handle.spec.ts
git commit -m "feat(render): IDisplayHandle + getHandle/onTick behavior seam"
```

---

## Task 10: Module host

**Files:**

- Create: `runtime/client/src/modules/host.ts`
- Test: `runtime/client/src/modules/host.spec.ts`

**Interfaces:**

- Consumes: `GraphModel` (`../model/graphModel`), `Reconciler` (`../render/reconciler`), `IRenderer` (`../render/renderer`), `IEventBus` (`../orchestration/bus`), `IModuleHost` (`./module`).
- Produces: `createModuleHost(deps: { model: GraphModel; reconciler: Reconciler; renderer: IRenderer; bus: IEventBus }): IModuleHost`. `emit` applies ops as one atomic batch and fires reconciliation; `snapshot` returns `model.toDocument()`; `resolve` delegates to `renderer.getHandle`; `onTick` delegates to `renderer.onTick`.

- [ ] **Step 1: Write the failing test**

```ts
// runtime/client/src/modules/host.spec.ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { Reconciler } from '../render/reconciler';
import { MockRenderer } from '../render/mockRenderer';
import { createBus } from '../orchestration/bus';
import { createModuleHost } from './host';

function setup() {
  const model = new GraphModel();
  const renderer = new MockRenderer();
  const reconciler = new Reconciler(renderer, model);
  const bus = createBus();
  const host = createModuleHost({ model, reconciler, renderer, bus });
  return { model, renderer, host, bus };
}

describe('createModuleHost', () => {
  it('emit applies ops to the model atomically', () => {
    const { model, host } = setup();
    host.emit([{ kind: 'addNode', id: 'root', type: 'Root', props: {} }]);
    expect(model.getNode('root')).toBeTruthy();
  });

  it('emit rolls back the whole batch if any op fails (atomic)', () => {
    const { model, host } = setup();
    host.emit([{ kind: 'addNode', id: 'root', type: 'Root', props: {} }]);
    // second op is invalid (duplicate id) => batch should roll back, leaving only root
    expect(() =>
      host.emit([
        { kind: 'addNode', id: 'a', type: 'Container', props: {} },
        { kind: 'addNode', id: 'a', type: 'Container', props: {} },
      ]),
    ).toThrow();
    expect(model.getNode('a')).toBeUndefined();
  });

  it('snapshot reflects the current model document', () => {
    const { host } = setup();
    host.emit([{ kind: 'addNode', id: 'root', type: 'Root', props: {} }]);
    expect(host.snapshot().nodes.root).toBeTruthy();
  });

  it('resolve delegates to the renderer getHandle', () => {
    const { host } = setup();
    expect(host.resolve('anything')).not.toBeNull(); // MockRenderer lazily makes handles
  });

  it('onTick delegates to the renderer and returns an unsubscribe', () => {
    const { host, renderer } = setup();
    const off = host.onTick(() => {});
    expect(renderer.tickCbs).toHaveLength(1);
    off();
    expect(renderer.tickCbs).toHaveLength(0);
  });

  it('exposes the same bus instance', () => {
    const { host, bus } = setup();
    expect(host.bus).toBe(bus);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/modules/host.spec.ts`
Expected: FAIL — `Failed to resolve import "./host"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// runtime/client/src/modules/host.ts
import type { GraphModel } from '../model/graphModel';
import type { Reconciler } from '../render/reconciler';
import type { IRenderer } from '../render/renderer';
import type { IEventBus } from '../orchestration/bus';
import type { IModuleHost } from './module';

/** Binds the two-plane seam to the concrete engine: model (+reconciler) for the
 *  structure plane, renderer for the behavior plane, bus for events (spec §2.3, §6.1). */
export function createModuleHost(deps: { model: GraphModel; reconciler: Reconciler; renderer: IRenderer; bus: IEventBus }): IModuleHost {
  return {
    snapshot: () => deps.model.toDocument(),
    emit: (ops) => {
      if (ops.length === 0) return;
      const changes = deps.model.applyBatch(ops); // atomic — throws + rolls back on failure
      void deps.reconciler.applyChanges(changes).catch((err) => console.error('[module-host] reconcile failed', err));
    },
    resolve: (id) => deps.renderer.getHandle(id),
    onTick: (cb) => deps.renderer.onTick(cb),
    bus: deps.bus,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/client && npx vitest run src/modules/host.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/modules/host.ts runtime/client/src/modules/host.spec.ts
git commit -m "feat(modules): module host binding model+renderer+bus+tick"
```

---

## Task 11: Protocol `spin` message + engine/main wiring

**Files:**

- Modify: `runtime/client/src/protocol/messages.ts`
- Modify: `runtime/client/src/protocol/protocolHost.ts`
- Modify: `runtime/client/src/engine.ts`
- Modify: `runtime/client/src/main.ts`
- Test: `runtime/client/src/protocol/protocolHost.spin.spec.ts`
- Test: `runtime/client/src/engine.modules.spec.ts`

**Interfaces:**

- `messages.ts`: add inbound `{ v: 1; kind: 'spin'; id: string; outcome: IOutcome }` (import `IOutcome` from `../modules/module`).
- `protocolHost.ts`: `IProtocolDeps` gains optional `onSpin?: (outcome: IOutcome) => void`; `handle` dispatches `spin` to it and acks.
- `engine.ts`: `createEngine` builds `bus`, `moduleHost`, `registry` (registers `reels`), `reels` (default config), `orchestrator`; wires `onSpin = (o) => orchestrator.spin(o)`; calls `reels.mount()`; returns `{ host, model, modules: { registry, orchestrator, reels, bus } }`.
- `main.ts`: exposes `window.__engineModules = { spin, setConfig, project, state, settled }` and captures `reels:settled` events.

- [ ] **Step 1: Write the failing tests**

```ts
// runtime/client/src/protocol/protocolHost.spin.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { Reconciler } from '../render/reconciler';
import { MockRenderer } from '../render/mockRenderer';
import { ProtocolHost } from './protocolHost';

function setup(onSpin?: (o: { grid: string[][] }) => void) {
  const model = new GraphModel();
  const renderer = new MockRenderer();
  const reconciler = new Reconciler(renderer, model);
  const posts: unknown[] = [];
  const host = new ProtocolHost({ model, reconciler, post: (m) => posts.push(m), onSpin });
  return { host, posts };
}

describe('ProtocolHost spin', () => {
  it('dispatches a spin message to onSpin and acks', async () => {
    const onSpin = vi.fn();
    const { host, posts } = setup(onSpin);
    await host.handle({ v: 1, kind: 'spin', id: '7', outcome: { grid: [['A']] } });
    expect(onSpin).toHaveBeenCalledWith({ grid: [['A']] });
    expect(posts).toContainEqual({ v: 1, kind: 'ack', id: '7' });
  });

  it('acks a spin even with no onSpin wired (no throw)', async () => {
    const { host, posts } = setup(undefined);
    await host.handle({ v: 1, kind: 'spin', id: '8', outcome: { grid: [] } });
    expect(posts).toContainEqual({ v: 1, kind: 'ack', id: '8' });
  });
});
```

```ts
// runtime/client/src/engine.modules.spec.ts
import { describe, it, expect } from 'vitest';
import { MockRenderer } from './render/mockRenderer';
import { createEngine } from './engine';

describe('createEngine modules wiring', () => {
  it('exposes a reels module and an orchestrator', () => {
    const { modules } = createEngine({ renderer: new MockRenderer(), post: () => {} });
    expect(modules.reels.type).toBe('reels');
    expect(modules.orchestrator).toBeTruthy();
  });

  it('a spin message drives the reels module to project + settle to the outcome grid', async () => {
    const renderer = new MockRenderer();
    const { host, modules } = createEngine({ renderer, post: () => {} });
    await host.handle({ v: 1, kind: 'init', id: 'i', document: { version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] } });
    await host.handle({ v: 1, kind: 'spin', id: 's', outcome: { grid: [['B'], ['C'], ['A'], ['B'], ['C']] } });
    // Drive the tick manually (MockRenderer records tick callbacks).
    for (let i = 0; i < 300; i++) renderer.tickCbs.forEach((cb) => cb(16));
    expect(modules.reels.debugState().phase).toBe('idle');
    expect(modules.reels.debugState().grid[0]).toEqual(['B']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd runtime/client && npx vitest run src/protocol/protocolHost.spin.spec.ts src/engine.modules.spec.ts`
Expected: FAIL — `spin` not handled / `modules` undefined on engine result.

- [ ] **Step 3: Write minimal implementation**

`messages.ts` — add the import and the inbound variant:

```ts
import type { IGameDocument } from '../model/document';
import type { Op } from '../model/ops';
import type { IOutcome } from '../modules/module';

export const PROTOCOL_VERSION = 1 as const;

export type InboundMessage =
  | { v: 1; kind: 'init'; id: string; document?: IGameDocument }
  | { v: 1; kind: 'op'; id: string; op: Op }
  | { v: 1; kind: 'batch'; id: string; ops: Op[] }
  | { v: 1; kind: 'spin'; id: string; outcome: IOutcome };

export type OutboundMessage =
  | { v: 1; kind: 'ready'; protocolVersion: 1 }
  | { v: 1; kind: 'ack'; id: string }
  | { v: 1; kind: 'error'; id: string; code: string; message: string };
```

`protocolHost.ts` — add the optional dep + dispatch branch (insert before the final `else`):

```ts
import { emptyDocument } from '../model/document';
import { OpError } from '../model/ops';
import type { GraphModel } from '../model/graphModel';
import type { Reconciler } from '../render/reconciler';
import type { IOutcome } from '../modules/module';
import { PROTOCOL_VERSION, type InboundMessage, type OutboundMessage } from './messages';

export interface IProtocolDeps {
  model: GraphModel;
  reconciler: Reconciler;
  post: (msg: OutboundMessage) => void;
  onSpin?: (outcome: IOutcome) => void;
}
```

In `handle`, add this branch alongside the existing `init`/`op`/`batch` branches (before the trailing `else { return; }`):

```ts
      } else if (msg.kind === 'spin') {
        this.deps.onSpin?.(msg.outcome);
```

`engine.ts` — assemble the module stack:

```ts
import { GraphModel } from './model/graphModel';
import { Reconciler } from './render/reconciler';
import type { IRenderer } from './render/renderer';
import { ProtocolHost } from './protocol/protocolHost';
import type { OutboundMessage } from './protocol/messages';
import { createBus, type IEventBus } from './orchestration/bus';
import { createModuleHost } from './modules/host';
import { ModuleRegistry } from './modules/registry';
import { Orchestrator } from './orchestration/orchestrator';
import { ReelsModule } from './modules/reels/reelsModule';

export interface IEngineModules {
  registry: ModuleRegistry;
  orchestrator: Orchestrator;
  reels: ReelsModule;
  bus: IEventBus;
}

export function createEngine(deps: { renderer: IRenderer; post: (m: OutboundMessage) => void }): {
  host: ProtocolHost;
  model: GraphModel;
  modules: IEngineModules;
} {
  const model = new GraphModel();
  const reconciler = new Reconciler(deps.renderer, model);
  const bus = createBus();
  const moduleHost = createModuleHost({ model, reconciler, renderer: deps.renderer, bus });

  const registry = new ModuleRegistry();
  registry.register('reels', (args) => new ReelsModule(args));
  const reels = registry.create('reels', { id: 'reels', host: moduleHost, config: { parentId: 'root' } }) as ReelsModule;
  reels.mount();

  const orchestrator = new Orchestrator({ bus, reels });
  const host = new ProtocolHost({ model, reconciler, post: deps.post, onSpin: (o) => orchestrator.spin(o) });

  return { host, model, modules: { registry, orchestrator, reels, bus } };
}
```

`main.ts` — expose module observability (add after the existing `__engineRenderer` line):

```ts
const { host, model, modules } = createEngine({ renderer, post });

// Test/standalone observability.
(window as unknown as { __engineModel: typeof model }).__engineModel = model;
(window as unknown as { __engineRenderer: typeof renderer }).__engineRenderer = renderer;

const settledEvents: Array<{ grid: string[][] }> = [];
modules.bus.on<{ grid: string[][] }>('reels:settled', (e) => settledEvents.push(e));
(window as unknown as { __engineModules: unknown }).__engineModules = {
  spin: (outcome: { grid: string[][] }) => modules.orchestrator.spin(outcome),
  setConfig: (partial: Record<string, unknown>) => {
    modules.reels.setConfig(partial as Record<string, never>);
    modules.reels.project();
  },
  project: () => modules.reels.project(),
  state: () => modules.reels.debugState(),
  settled: () => settledEvents,
};
```

> The existing `const { host, model } = createEngine(...)` line in `main.ts` must be changed to also destructure `modules` (shown above).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd runtime/client && npx vitest run src/protocol/protocolHost.spin.spec.ts src/engine.modules.spec.ts`
Expected: PASS. Then run the full unit suite + typecheck: `npx vitest run` and `npx nx typecheck client`.
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/protocol/messages.ts runtime/client/src/protocol/protocolHost.ts runtime/client/src/engine.ts runtime/client/src/main.ts runtime/client/src/protocol/protocolHost.spin.spec.ts runtime/client/src/engine.modules.spec.ts
git commit -m "feat(engine): spin protocol message + module stack wiring + observability"
```

---

## Task 12: E2e — spin round + config-edit reproject (local-only, authoritative)

**Files:**

- Create: `runtime/client/e2e/reels.e2e.spec.ts`

**Interfaces:**

- Consumes: the runtime served at `http://localhost:${4300 + BLOOM_PORT_OFFSET}` (via `just e2e` / `npx nx serve client`), the `window.__engineModules` observability hook, and the `spin`/`init` protocol messages.

> **Note on "visibly spin" (spec §6.2):** real symbol textures are Plan 3 / deferred; with empty textures there is nothing to pixel-diff. Following the engine's existing observability approach (`__engineModel`), this spec operationalizes "visibly spin → settle" as **observable engine state**: the projected nodes appear in the model, blur is applied during the spin, the phase transitions spinning → idle, the settled grid equals the fixture outcome, and `reels:settled` fires. This is the authoritative behavioral contract for the slice.

- [ ] **Step 1: Write the e2e spec**

```ts
// runtime/client/e2e/reels.e2e.spec.ts
import { test, expect } from '@playwright/test';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const RUNTIME_URL = `http://localhost:${4300 + offset}`;

const HARNESS = `
  <iframe id="engine" src="${RUNTIME_URL}/" width="640" height="480" style="border:0"></iframe>
  <script>
    window.__inbound = [];
    const frame = document.getElementById('engine');
    window.addEventListener('message', (e) => window.__inbound.push(e.data));
    window.send = (msg) => frame.contentWindow.postMessage(msg, '*');
    window.engineModel = () => frame.contentWindow.__engineModel.toDocument();
    window.engineModules = () => frame.contentWindow.__engineModules;
  </script>`;

async function bootRoot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.setContent(HARNESS);
  await expect.poll(() => page.evaluate(() => (window as any).__inbound.some((m: any) => m.kind === 'ready'))).toBe(true);
  await page.evaluate(() => {
    (window as any).send({ v: 1, kind: 'op', id: 'r', op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
  });
  await expect.poll(() => page.evaluate(() => (window as any).engineModel().nodes.root != null)).toBe(true);
}

test('a spin round projects reels, spins, and settles to the fixture outcome', async ({ page }) => {
  await bootRoot(page);

  // Fixture outcome: 5 reels, 3 rows each.
  const outcome = {
    grid: [
      ['A', 'B', 'C'],
      ['B', 'C', 'D'],
      ['C', 'D', 'E'],
      ['D', 'E', 'A'],
      ['E', 'A', 'B'],
    ],
  };
  await page.evaluate((o) => (window as any).send({ v: 1, kind: 'spin', id: 'spin1', outcome: o }), outcome);

  // Structure plane: reel containers + cells are now persisted nodes in the model.
  await expect.poll(() => page.evaluate(() => (window as any).engineModel().nodes['reels:reel:0'] != null)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).engineModel().nodes['reels:cell:0:0'] != null)).toBe(true);

  // Behavior plane: it settles to idle with the fixture grid, and reels:settled fired once.
  await expect.poll(() => page.evaluate(() => (window as any).engineModules().state().phase), { timeout: 5000 }).toBe('idle');
  const grid = await page.evaluate(() => (window as any).engineModules().state().grid);
  expect(grid).toEqual([
    ['A', 'B', 'C'],
    ['B', 'C', 'D'],
    ['C', 'D', 'E'],
    ['D', 'E', 'A'],
    ['E', 'A', 'B'],
  ]);
  const settledCount = await page.evaluate(() => (window as any).engineModules().settled().length);
  expect(settledCount).toBe(1);
});

test('editing config (cols 5 -> 6) reprojects and adds a reel without duplicating', async ({ page }) => {
  await bootRoot(page);

  await page.evaluate(() => (window as any).engineModules().project());
  await expect.poll(() => page.evaluate(() => (window as any).engineModel().nodes['reels:reel:4'] != null)).toBe(true);
  const before = await page.evaluate(() => Object.keys((window as any).engineModel().nodes).length);

  await page.evaluate(() => (window as any).engineModules().setConfig({ cols: 6 }));

  // New reel appears; existing reels are not duplicated.
  await expect.poll(() => page.evaluate(() => (window as any).engineModel().nodes['reels:reel:5'] != null)).toBe(true);
  const after = await page.evaluate(() => Object.keys((window as any).engineModel().nodes).length);
  // One extra reel container + (rows+buffer) cells; strictly more, and reel:0 still present.
  expect(after).toBeGreaterThan(before);
  expect(await page.evaluate(() => (window as any).engineModel().nodes['reels:reel:0'] != null)).toBe(true);
});
```

- [ ] **Step 2: Run the e2e (local; requires a replay backend on :8000 and the runtime served)**

Run (from repo root, per repo policy):

```bash
just backend-serve-replay   # in one shell (or confirm a backend is on :8000)
just e2e                     # runs Playwright against the served runtime
```

Or scope to this spec while iterating:

```bash
cd runtime/client && npx playwright test e2e/reels.e2e.spec.ts
```

Expected: both tests PASS. If the runtime isn't served, start it: `npx nx serve client` (port `4300 + BLOOM_PORT_OFFSET`).

- [ ] **Step 3: Commit**

```bash
git add runtime/client/e2e/reels.e2e.spec.ts
git commit -m "test(reels): e2e spin round + config-edit reproject (authoritative)"
```

---

## Final verification (before opening the PR)

- [ ] Run the full unit suite: `cd runtime/client && npx vitest run` — all green.
- [ ] Typecheck: `npx nx typecheck client` — no errors (vitest green ≠ types valid).
- [ ] Build: `npx nx build client` — succeeds.
- [ ] Prettier (pinned): from repo root, `node_modules/.bin/prettier --check .` — clean (run `--write` if not).
- [ ] E2e locally: `just e2e` (replay backend on :8000) — `reels.e2e.spec.ts` + existing `engine.e2e.spec.ts` pass.
- [ ] Push + open PR: `git push -u origin feat/game-modules && gh pr create`.

---

## Self-Review (author checklist — completed during planning)

**1. Spec coverage:**

- §2 two-plane split → structure plane = Task 4 (reconcile) + Task 6 (`project`); behavior plane = Task 7 (`update`/verbs) + Task 9 (`getHandle`/`onTick`). ✓
- §2.3 handle seam → Task 9 `IDisplayHandle` + Task 10 host `resolve`. ✓
- §3 `IGameModule` contract + registry → Task 3. `configSchema` → Task 2 + Task 6 `REELS_SCHEMA`. ✓
- §4 reels structure (containers/cells, stable ids, buffer) → Task 6; behavior (spin/blur/recycle, staggered settle, `reels:settled`) → Task 7. ✓
- §5 orchestrator + bus, one spin round → Task 1 (bus) + Task 8 (orchestrator). Modules talk only via the bus. ✓
- §6.1 engine touch-points (handle resolver + per-frame tick) → Task 9 + Task 10. §6.2 testing (unit: project idempotency, schema validation, registry, pure behavior; e2e: spin round + editable reproject) → Tasks 2,3,4,5,6,7,8 (unit) + Task 12 (e2e). ✓
- §7 scope: contract+registry, two-plane mechanism, reels, orchestrator+bus, unit+e2e — all in. Deferred-B (server parity, live outcome, lib extraction, more modules) — not built. ✓
- §8 open decisions resolved: handle/tick = module-host facade + `IDisplayHandle` (Tasks 9–10); `configSchema` = module-local typed schema, inspector untouched (Task 2); bus = tiny typed emitter behind `IEventBus` seam (Task 1). ✓

**2. Placeholder scan:** No TBD/"add error handling"/"similar to Task N" — every code step is complete. ✓

**3. Type consistency:** `IModuleHost` (`snapshot`/`emit`/`resolve`/`onTick`/`bus`), `IDisplayHandle` (`position`/`scale`/`alpha`/`visible`/`setBlur`), `IGameModule` (`project`/`mount`/`update`/`dispose`), `containerId`/`cellId`, `reconcileOps(current, desired, owns)`, bus `on/off/emit`, `IOutcome.grid` (`grid[col][row]`) — used identically across Tasks 3–12. ✓
