# Responsive Root Scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `runtime/client` Pixi engine scale a single root transform so the active (orientation-dependent) safe area always fits the viewport, with background free to bleed past it and no over-rendering.

**Architecture:** A pure `computeViewport()` function does all fit/center/orientation math (zero Pixi). A `ViewportController` owns a `ResizeObserver` on the host element, coalesces fires to one animation frame, calls `computeViewport`, pushes the result to the renderer via one new seam method `IRenderer.applyViewport(vp)`, and emits a `viewport:changed` bus signal when orientation or safe-area shape changes. The Root node's `safeArea` prop (with a back-compat fallback to `width`/`height`) feeds the controller through the reconciler. Only the root container is ever transformed; every child inherits its scale/offset.

**Tech Stack:** TypeScript, Pixi.js v8, Vitest (jsdom) for units, Playwright for e2e, Nx, Vite.

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`ISize`, `IViewport`, `ISafeAreaDefs`, `IHostSurface`, `IViewportRenderer`, `IViewportSink`). Verbatim from `docs/coding-standards.md`.
- **TDD is mandatory** — failing test first, watch it fail, minimal code, pass, commit.
- **All four frontend gates must pass before pushing:** `node_modules/.bin/prettier --check .`, `npx nx typecheck client`, `npx nx test client`, `npx nx build client`. (Vitest green ≠ types valid — run all four.)
- **Use the pinned prettier** at `node_modules/.bin/prettier`, never `npx prettier` (a fresh worktree pulls a newer version that disagrees on markdown).
- **This worktree is `C:\code\bloom.wt\responsive-root-scaling` on `feat/responsive-root-scaling`, `BLOOM_PORT_OFFSET=1`** → runtime dev server is port `4301`. **Always export `BLOOM_PORT_OFFSET=1` before running e2e** or Playwright's `reuseExistingServer` silently attaches to the default-port (`4300`) stack another session may hold.
- All commands below run from the worktree root unless stated otherwise.

---

### Task 1: Pure viewport math (`computeViewport` + `resolveSafeAreas`)

The whole fit/center/orientation calculation and the safe-area fallback chain, with zero Pixi — the primary unit-test target.

**Files:**
- Create: `runtime/client/src/render/viewport.ts`
- Test: `runtime/client/src/render/viewport.spec.ts`

**Interfaces:**
- Consumes: `JsonValue` from `../model/document`.
- Produces:
  - `interface ISize { width: number; height: number }`
  - `type Orientation = 'landscape' | 'portrait'`
  - `interface ISafeAreaDefs { landscape: ISize; portrait: ISize }`
  - `interface IViewport { orientation: Orientation; safeArea: ISize; scale: number; offset: { x: number; y: number }; canvas: ISize; dpr: number }`
  - `function computeViewport(host: ISize, safe: ISafeAreaDefs, dpr?: number): IViewport`
  - `function resolveSafeAreas(props: Record<string, JsonValue>): ISafeAreaDefs`

- [ ] **Step 1: Write the failing test**

Create `runtime/client/src/render/viewport.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeViewport, resolveSafeAreas } from './viewport';

const SAFE = { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } };

describe('computeViewport', () => {
  it('picks landscape when wider-or-equal, portrait when taller', () => {
    expect(computeViewport({ width: 1000, height: 450 }, SAFE).orientation).toBe('landscape');
    expect(computeViewport({ width: 450, height: 1000 }, SAFE).orientation).toBe('portrait');
  });

  it('treats a square host as landscape (deterministic tiebreak)', () => {
    expect(computeViewport({ width: 500, height: 500 }, SAFE).orientation).toBe('landscape');
  });

  it('scales by the min ratio so the whole safe area fits', () => {
    // landscape 1280x720 into 1000x450 -> min(0.781, 0.625) = 0.625
    expect(computeViewport({ width: 1000, height: 450 }, SAFE).scale).toBeCloseTo(0.625, 6);
  });

  it('centers the safe area, leaving symmetric bleed on the larger axis', () => {
    const vp = computeViewport({ width: 1000, height: 450 }, SAFE);
    // x bleed: (1000 - 1280*0.625)/2 = 100 ; y: (450 - 720*0.625)/2 = 0
    expect(vp.offset).toEqual({ x: 100, y: 0 });
  });

  it('uses the portrait safe rect when portrait', () => {
    const vp = computeViewport({ width: 450, height: 1000 }, SAFE);
    expect(vp.safeArea).toEqual({ width: 720, height: 1280 });
    expect(vp.offset).toEqual({ x: 0, y: 100 });
  });

  it('reports canvas = host size and passes dpr through', () => {
    const vp = computeViewport({ width: 1000, height: 450 }, SAFE, 2);
    expect(vp.canvas).toEqual({ width: 1000, height: 450 });
    expect(vp.dpr).toBe(2);
  });
});

describe('resolveSafeAreas', () => {
  it('reads both orientation rects from safeArea', () => {
    expect(resolveSafeAreas({ safeArea: SAFE })).toEqual(SAFE);
  });

  it('uses a single defined orientation for both', () => {
    const only = { landscape: { width: 1280, height: 720 } };
    expect(resolveSafeAreas({ safeArea: only })).toEqual({
      landscape: { width: 1280, height: 720 },
      portrait: { width: 1280, height: 720 },
    });
  });

  it('falls back to width/height for both orientations when safeArea is absent', () => {
    expect(resolveSafeAreas({ width: 640, height: 480 })).toEqual({
      landscape: { width: 640, height: 480 },
      portrait: { width: 640, height: 480 },
    });
  });

  it('defaults to 800x600 when nothing is provided', () => {
    expect(resolveSafeAreas({})).toEqual({
      landscape: { width: 800, height: 600 },
      portrait: { width: 800, height: 600 },
    });
  });

  it('ignores a malformed safeArea entry (non-numeric / non-positive)', () => {
    expect(resolveSafeAreas({ safeArea: { landscape: { width: 0, height: 720 } }, width: 640, height: 480 })).toEqual({
      landscape: { width: 640, height: 480 },
      portrait: { width: 640, height: 480 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `Cannot find module './viewport'` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `runtime/client/src/render/viewport.ts`:

```ts
import type { JsonValue } from '../model/document';

export interface ISize {
  width: number;
  height: number;
}

export type Orientation = 'landscape' | 'portrait';

export interface ISafeAreaDefs {
  landscape: ISize;
  portrait: ISize;
}

export interface IViewport {
  orientation: Orientation;
  safeArea: ISize;
  scale: number;
  offset: { x: number; y: number };
  canvas: ISize;
  dpr: number;
}

/** Pure fit/center/orientation math. `host` and the active safe rect must be positive;
 *  callers (the controller) guard zero-size before calling. */
export function computeViewport(host: ISize, safe: ISafeAreaDefs, dpr = 1): IViewport {
  const orientation: Orientation = host.width >= host.height ? 'landscape' : 'portrait';
  const safeArea = orientation === 'landscape' ? safe.landscape : safe.portrait;
  const scale = Math.min(host.width / safeArea.width, host.height / safeArea.height);
  const offset = {
    x: (host.width - safeArea.width * scale) / 2,
    y: (host.height - safeArea.height * scale) / 2,
  };
  return { orientation, safeArea, scale, offset, canvas: { width: host.width, height: host.height }, dpr };
}

/** Resolve the two safe rects from Root props, with the back-compat fallback chain:
 *  safeArea.{landscape,portrait} -> a single defined orientation for both ->
 *  width/height for both -> 800x600. */
export function resolveSafeAreas(props: Record<string, JsonValue>): ISafeAreaDefs {
  const sa = props.safeArea;
  const land = readSize(isRecord(sa) ? sa.landscape : undefined);
  const port = readSize(isRecord(sa) ? sa.portrait : undefined);
  if (land && port) return { landscape: land, portrait: port };
  if (land) return { landscape: land, portrait: land };
  if (port) return { landscape: port, portrait: port };
  const fallback: ISize = { width: num(props.width, 800), height: num(props.height, 600) };
  return { landscape: fallback, portrait: fallback };
}

function readSize(v: JsonValue | undefined): ISize | null {
  if (!isRecord(v)) return null;
  const w = v.width;
  const h = v.height;
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { width: w, height: h } : null;
}

function isRecord(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: JsonValue | undefined, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test client`
Expected: PASS (all `viewport.spec.ts` cases green; the rest of the suite still green).

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/render/viewport.ts runtime/client/src/render/viewport.spec.ts
git commit -m "feat(runtime): pure computeViewport + resolveSafeAreas"
```

---

### Task 2: Extend the renderer seam (`mount` signature + `applyViewport`)

Drop the fixed design-size from `mount` (the canvas is now the viewport) and add one new method `applyViewport(vp)` to the `IRenderer` seam. Update both implementations and the existing tests that asserted the old `mount` signature, so the branch keeps building and typechecking.

**Files:**
- Modify: `runtime/client/src/render/renderer.ts` (interface)
- Modify: `runtime/client/src/render/mockRenderer.ts`
- Modify: `runtime/client/src/render/pixiRenderer.ts`
- Modify: `runtime/client/src/render/reconciler.ts:52-62` (drop `width`/`height` read + `numProp`; call `mount(node.id)`)
- Modify (fix existing): `runtime/client/src/render/mockRenderer.spec.ts:7,13-19`
- Modify (fix existing): `runtime/client/src/engine.spec.ts:14`
- Test: `runtime/client/src/render/mockRenderer.spec.ts` (add applyViewport case), `runtime/client/src/render/pixiRenderer.viewport.spec.ts` (new)

**Interfaces:**
- Consumes: `IViewport` from `./viewport` (Task 1).
- Produces:
  - `IRenderer.mount(rootId: string): void | Promise<void>` (no `opts`)
  - `IRenderer.applyViewport(vp: IViewport): void`
  - `MockRenderer` records `['mount', rootId]` and `['applyViewport', vp]`.

- [ ] **Step 1: Write the failing tests**

Add to `runtime/client/src/render/mockRenderer.spec.ts` — replace the existing test body so the `mount` call and the expected `calls` array match the new signature, and add an `applyViewport` assertion:

```ts
import { describe, it, expect } from 'vitest';
import { MockRenderer } from './mockRenderer';

describe('MockRenderer', () => {
  it('records calls and returns a texture handle', async () => {
    const r = new MockRenderer();
    r.mount('root');
    r.createObject('s', 'Sprite');
    r.setProp('s', 'alpha', 0.5);
    const tex = await r.loadTexture('asset:1');
    r.assignTexture('s', tex);
    expect(tex).toEqual({ src: 'asset:1' });
    expect(r.calls).toEqual([
      ['mount', 'root'],
      ['createObject', 's', 'Sprite'],
      ['setProp', 's', 'alpha', 0.5],
      ['loadTexture', 'asset:1'],
      ['assignTexture', 's', { src: 'asset:1' }],
    ]);
  });

  it('records applyViewport calls', () => {
    const r = new MockRenderer();
    const vp = {
      orientation: 'landscape' as const,
      safeArea: { width: 1280, height: 720 },
      scale: 0.625,
      offset: { x: 100, y: 0 },
      canvas: { width: 1000, height: 450 },
      dpr: 1,
    };
    r.applyViewport(vp);
    expect(r.calls).toEqual([['applyViewport', vp]]);
  });
});
```

Create `runtime/client/src/render/pixiRenderer.viewport.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { PixiRenderer } from './pixiRenderer';

describe('PixiRenderer.applyViewport', () => {
  it('resizes the canvas to host size and sets the root scale + offset', () => {
    const r = new PixiRenderer(document.createElement('div'));
    // jsdom has no WebGL, so the real mount()/app.init() cannot run. Inject a fake
    // app (resize spy) plus a real Pixi stage Container the way mount() does.
    const resized: Array<[number, number]> = [];
    const stage = new Container();
    const internals = r as unknown as {
      app: { renderer: { resize(w: number, h: number): void } };
      rootId: string;
      objects: Map<string, Container>;
    };
    internals.app = { renderer: { resize: (w, h) => resized.push([w, h]) } };
    internals.rootId = 'root';
    internals.objects.set('root', stage);

    r.applyViewport({
      orientation: 'landscape',
      safeArea: { width: 1280, height: 720 },
      scale: 0.625,
      offset: { x: 100, y: 0 },
      canvas: { width: 1000, height: 450 },
      dpr: 1,
    });

    expect(resized).toEqual([[1000, 450]]);
    expect(stage.scale.x).toBeCloseTo(0.625, 6);
    expect(stage.scale.y).toBeCloseTo(0.625, 6);
    expect(stage.position.x).toBe(100);
    expect(stage.position.y).toBe(0);
  });

  it('is a no-op before mount (no app)', () => {
    const r = new PixiRenderer(document.createElement('div'));
    expect(() =>
      r.applyViewport({
        orientation: 'landscape',
        safeArea: { width: 800, height: 600 },
        scale: 1,
        offset: { x: 0, y: 0 },
        canvas: { width: 800, height: 600 },
        dpr: 1,
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx nx test client`
Expected: FAIL — `MockRenderer`/`PixiRenderer` have no `applyViewport`; `mount('root')` is a type error (still requires `opts`).

- [ ] **Step 3: Write the minimal implementation**

In `runtime/client/src/render/renderer.ts`, add the import and change the `IRenderer` methods:

```ts
import type { JsonValue, NodeType } from '../model/document';
import type { IViewport } from './viewport';
```

Within `interface IRenderer`, replace the `mount` line and add `applyViewport`:

```ts
  mount(rootId: string): void | Promise<void>;
  /** Resize the canvas to the viewport and apply scale/offset to the root container. */
  applyViewport(vp: IViewport): void;
```

In `runtime/client/src/render/mockRenderer.ts`, add the import, change `mount`, add `applyViewport`:

```ts
import type { IViewport } from './viewport';
```

```ts
  mount(rootId: string): void {
    this.calls.push(['mount', rootId]);
  }
  applyViewport(vp: IViewport): void {
    this.calls.push(['applyViewport', vp]);
  }
```

In `runtime/client/src/render/pixiRenderer.ts`:

Add the import at the top:

```ts
import type { IViewport } from './viewport';
```

Replace `mount` so it measures its own host (no fixed design size) and caps DPR:

```ts
  async mount(rootId: string): Promise<void> {
    const app = new Application();
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    await app.init({
      width,
      height,
      background: '#0b0b0c',
      antialias: true,
      resolution: Math.min(globalThis.devicePixelRatio ?? 1, 2),
      autoDensity: true,
    });
    this.host.appendChild(app.canvas);
    app.stage.sortableChildren = true;
    this.app = app;
    this.flushPendingTicks();
    this.rootId = rootId;
    this.objects.set(rootId, app.stage as unknown as Container);
  }

  applyViewport(vp: IViewport): void {
    const app = this.app;
    if (!app || this.rootId === null) return;
    app.renderer.resize(vp.canvas.width, vp.canvas.height);
    const root = this.objects.get(this.rootId);
    if (!root) return;
    root.scale.set(vp.scale);
    root.position.set(vp.offset.x, vp.offset.y);
  }
```

In `runtime/client/src/render/reconciler.ts`, change the Root branch of `created()` to drop the design-size read, and delete the now-unused `numProp` helper:

```ts
  private async created(node: INode): Promise<void> {
    if (node.type === 'Texture') return; // data-only node, no display object
    if (node.type === 'Root') {
      await this.renderer.mount(node.id);
    } else {
      this.renderer.createObject(node.id, node.type);
      for (const [key, value] of Object.entries(node.props)) this.renderer.setProp(node.id, key, value);
    }
  }
```

Delete the `numProp` function at the bottom of `reconciler.ts` and drop `JsonValue` from its imports if it becomes unused (the `import type { INode, JsonValue }` line — keep `INode`, remove `JsonValue` if TS flags it unused).

In `runtime/client/src/engine.spec.ts:14`, update the expectation to the new `mount` signature:

```ts
    expect(renderer.calls).toContainEqual(['mount', 'root']);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test client`
Expected: PASS — `mockRenderer.spec`, `pixiRenderer.viewport.spec`, and `engine.spec` all green; full suite green.

- [ ] **Step 5: Typecheck (the seam change touches many files)**

Run: `npx nx typecheck client`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add runtime/client/src/render/renderer.ts runtime/client/src/render/mockRenderer.ts runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/reconciler.ts runtime/client/src/render/mockRenderer.spec.ts runtime/client/src/render/pixiRenderer.viewport.spec.ts runtime/client/src/engine.spec.ts
git commit -m "feat(runtime): add applyViewport seam; mount sizes to host"
```

---

### Task 3: `ViewportController` + DOM host surface

The controller that owns the `ResizeObserver`, coalesces to one frame, drives `computeViewport` → `renderer.applyViewport`, and emits `viewport:changed` only on orientation/shape change. Plus `domHostSurface`, the real DOM/`ResizeObserver` wrapper.

**Files:**
- Create: `runtime/client/src/render/viewportController.ts`
- Test: `runtime/client/src/render/viewportController.spec.ts`

**Interfaces:**
- Consumes: `computeViewport`, `ISafeAreaDefs`, `ISize`, `IViewport` from `./viewport`; `IEventBus` from `../orchestration/bus`.
- Produces:
  - `interface IViewportRenderer { applyViewport(vp: IViewport): void }`
  - `interface IHostSurface { size(): ISize; onResize(cb: () => void): () => void }`
  - `interface IViewportSink { setSafeAreas(defs: ISafeAreaDefs): void }`
  - `class ViewportController implements IViewportSink` with constructor `({ surface, renderer, bus, schedule?, readDpr? })`, and methods `setSafeAreas(defs)`, `current(): IViewport | null`, `recompute(): void`, `dispose(): void`.
  - `function domHostSurface(el: HTMLElement): IHostSurface`

- [ ] **Step 1: Write the failing test**

Create `runtime/client/src/render/viewportController.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createBus } from '../orchestration/bus';
import { MockRenderer } from './mockRenderer';
import { ViewportController, type IHostSurface } from './viewportController';
import type { IViewport } from './viewport';

const SAFE = { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } };

/** A surface whose size is mutable and whose resize callback is captured so tests fire it. */
function fakeSurface(initial: { width: number; height: number }) {
  let size = initial;
  let cb: (() => void) | null = null;
  const surface: IHostSurface = {
    size: () => size,
    onResize: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
  };
  return {
    surface,
    setSize(s: { width: number; height: number }) {
      size = s;
    },
    fire() {
      cb?.();
    },
    get subscribed() {
      return cb !== null;
    },
  };
}

/** A manual scheduler so coalescing is deterministic. */
function manualSchedule() {
  const queue: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
      return () => {
        const i = queue.indexOf(cb);
        if (i >= 0) queue.splice(i, 1);
      };
    },
    flush() {
      const run = [...queue];
      queue.length = 0;
      for (const cb of run) cb();
    },
    get pending() {
      return queue.length;
    },
  };
}

describe('ViewportController', () => {
  it('applies a computed viewport to the renderer on setSafeAreas', () => {
    const f = fakeSurface({ width: 1000, height: 450 });
    const renderer = new MockRenderer();
    const c = new ViewportController({ surface: f.surface, renderer, bus: createBus(), readDpr: () => 1 });
    c.setSafeAreas(SAFE);
    const applied = renderer.calls.find((x) => x[0] === 'applyViewport');
    expect(applied).toBeTruthy();
    const vp = applied![1] as IViewport;
    expect(vp.orientation).toBe('landscape');
    expect(vp.scale).toBeCloseTo(0.625, 6);
    expect(c.current()).toEqual(vp);
  });

  it('emits viewport:changed on first compute and on orientation flip, but not on a same-shape resize', () => {
    const f = fakeSurface({ width: 1000, height: 450 });
    const renderer = new MockRenderer();
    const bus = createBus();
    const events: IViewport[] = [];
    bus.on<IViewport>('viewport:changed', (e) => events.push(e));
    const c = new ViewportController({ surface: f.surface, renderer, bus, schedule: (cb) => (cb(), () => {}), readDpr: () => 1 });

    c.setSafeAreas(SAFE); // first compute -> emit (landscape)
    expect(events).toHaveLength(1);

    f.setSize({ width: 1200, height: 450 }); // wider, still landscape, same safe shape
    f.fire();
    expect(events).toHaveLength(1); // no emit

    f.setSize({ width: 450, height: 1000 }); // portrait now -> emit
    f.fire();
    expect(events).toHaveLength(2);
    expect(events[1].orientation).toBe('portrait');
  });

  it('coalesces multiple resize fires into a single recompute per frame', () => {
    const f = fakeSurface({ width: 1000, height: 450 });
    const renderer = new MockRenderer();
    const sched = manualSchedule();
    const c = new ViewportController({ surface: f.surface, renderer, bus: createBus(), schedule: sched.schedule, readDpr: () => 1 });
    c.setSafeAreas(SAFE);
    const before = renderer.calls.filter((x) => x[0] === 'applyViewport').length;

    f.fire();
    f.fire();
    f.fire();
    expect(sched.pending).toBe(1); // three fires, one scheduled recompute
    sched.flush();
    const after = renderer.calls.filter((x) => x[0] === 'applyViewport').length;
    expect(after).toBe(before + 1);
  });

  it('skips compute when the host has zero size, then recovers', () => {
    const f = fakeSurface({ width: 0, height: 0 });
    const renderer = new MockRenderer();
    const c = new ViewportController({ surface: f.surface, renderer, bus: createBus(), schedule: (cb) => (cb(), () => {}), readDpr: () => 1 });
    c.setSafeAreas(SAFE);
    expect(renderer.calls.some((x) => x[0] === 'applyViewport')).toBe(false);
    expect(c.current()).toBeNull();

    f.setSize({ width: 1000, height: 450 });
    f.fire();
    expect(renderer.calls.some((x) => x[0] === 'applyViewport')).toBe(true);
  });

  it('dispose() unsubscribes from the surface', () => {
    const f = fakeSurface({ width: 1000, height: 450 });
    const c = new ViewportController({ surface: f.surface, renderer: new MockRenderer(), bus: createBus(), readDpr: () => 1 });
    expect(f.subscribed).toBe(true);
    c.dispose();
    expect(f.subscribed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `Cannot find module './viewportController'`.

- [ ] **Step 3: Write the minimal implementation**

Create `runtime/client/src/render/viewportController.ts`:

```ts
import type { IEventBus } from '../orchestration/bus';
import { computeViewport, type ISafeAreaDefs, type ISize, type IViewport } from './viewport';

export interface IViewportRenderer {
  applyViewport(vp: IViewport): void;
}

export interface IHostSurface {
  size(): ISize;
  /** Subscribe to size changes; returns an unsubscribe thunk. */
  onResize(cb: () => void): () => void;
}

/** What the reconciler needs from the controller. */
export interface IViewportSink {
  setSafeAreas(defs: ISafeAreaDefs): void;
}

const DEFAULT_SAFE: ISafeAreaDefs = {
  landscape: { width: 800, height: 600 },
  portrait: { width: 800, height: 600 },
};

export class ViewportController implements IViewportSink {
  private safeAreas: ISafeAreaDefs = DEFAULT_SAFE;
  private last: IViewport | null = null;
  private scheduled = false;
  private cancel: (() => void) | null = null;
  private readonly unsub: () => void;
  private readonly schedule: (cb: () => void) => () => void;
  private readonly readDpr: () => number;

  constructor(opts: {
    surface: IHostSurface;
    renderer: IViewportRenderer;
    bus: IEventBus;
    schedule?: (cb: () => void) => () => void;
    readDpr?: () => number;
  }) {
    this.surface = opts.surface;
    this.renderer = opts.renderer;
    this.bus = opts.bus;
    this.schedule = opts.schedule ?? rafSchedule;
    this.readDpr = opts.readDpr ?? (() => globalThis.devicePixelRatio ?? 1);
    this.unsub = this.surface.onResize(() => this.requestRecompute());
  }

  private readonly surface: IHostSurface;
  private readonly renderer: IViewportRenderer;
  private readonly bus: IEventBus;

  setSafeAreas(defs: ISafeAreaDefs): void {
    this.safeAreas = defs;
    this.recompute();
  }

  current(): IViewport | null {
    return this.last;
  }

  recompute(): void {
    const size = this.surface.size();
    if (size.width <= 0 || size.height <= 0) return;
    const dpr = Math.min(this.readDpr(), 2);
    const vp = computeViewport(size, this.safeAreas, dpr);
    this.renderer.applyViewport(vp);
    if (shapeChanged(this.last, vp)) this.bus.emit('viewport:changed', vp);
    this.last = vp;
  }

  dispose(): void {
    this.unsub();
    this.cancel?.();
    this.cancel = null;
    this.scheduled = false;
  }

  private requestRecompute(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.cancel = this.schedule(() => {
      this.scheduled = false;
      this.cancel = null;
      this.recompute();
    });
  }
}

function shapeChanged(prev: IViewport | null, next: IViewport): boolean {
  return (
    !prev ||
    prev.orientation !== next.orientation ||
    prev.safeArea.width !== next.safeArea.width ||
    prev.safeArea.height !== next.safeArea.height
  );
}

function rafSchedule(cb: () => void): () => void {
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
}

/** Real DOM surface: measures the element and observes it with ResizeObserver,
 *  falling back to a window resize listener where ResizeObserver is unavailable. */
export function domHostSurface(el: HTMLElement): IHostSurface {
  return {
    size: () => ({ width: el.clientWidth, height: el.clientHeight }),
    onResize: (cb) => {
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => cb());
        ro.observe(el);
        return () => ro.disconnect();
      }
      const handler = () => cb();
      window.addEventListener('resize', handler);
      return () => window.removeEventListener('resize', handler);
    },
  };
}
```

> Note: the field declarations for `surface`/`renderer`/`bus` appear after the constructor only to keep the diff readable; TypeScript class fields are hoisted, so assigning them in the constructor is valid. If your linter prefers fields-before-constructor, move the three `private readonly` lines above the constructor.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test client`
Expected: PASS — all `viewportController.spec.ts` cases green.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/render/viewportController.ts runtime/client/src/render/viewportController.spec.ts
git commit -m "feat(runtime): ViewportController + domHostSurface"
```

---

### Task 4: Wire safe-area resolution through the reconciler

The reconciler resolves safe rects from Root props and pushes them to the viewport sink — on Root creation and whenever a safe-area-affecting prop changes.

**Files:**
- Modify: `runtime/client/src/render/reconciler.ts`
- Test: `runtime/client/src/render/reconciler.viewport.spec.ts` (new)

**Interfaces:**
- Consumes: `resolveSafeAreas` from `./viewport`; `IViewportSink` from `./viewportController`.
- Produces: `Reconciler` constructor gains an optional third arg `viewport?: IViewportSink`. On Root `nodeCreated` it calls `viewport.setSafeAreas(resolveSafeAreas(node.props))` after `mount`; on Root `propSet` of a safe-area-affecting path it calls `viewport.setSafeAreas(resolveSafeAreas(node.props))`.

- [ ] **Step 1: Write the failing test**

Create `runtime/client/src/render/reconciler.viewport.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from './mockRenderer';
import { Reconciler } from './reconciler';
import type { ISafeAreaDefs } from './viewport';

function fakeSink() {
  const defs: ISafeAreaDefs[] = [];
  return { defs, setSafeAreas: (d: ISafeAreaDefs) => defs.push(d) };
}

describe('Reconciler viewport wiring', () => {
  it('pushes resolved safe areas to the sink on Root creation', async () => {
    const model = new GraphModel();
    const sink = fakeSink();
    const r = new Reconciler(new MockRenderer(), model, sink);
    const changes = model.apply({
      kind: 'addNode',
      id: 'root',
      type: 'Root',
      props: { safeArea: { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } } },
    });
    await r.applyChanges(changes);
    expect(sink.defs[0]).toEqual({ landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } });
  });

  it('falls back to width/height when safeArea is absent', async () => {
    const model = new GraphModel();
    const sink = fakeSink();
    const r = new Reconciler(new MockRenderer(), model, sink);
    const changes = model.apply({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } });
    await r.applyChanges(changes);
    expect(sink.defs[0]).toEqual({ landscape: { width: 640, height: 480 }, portrait: { width: 640, height: 480 } });
  });

  it('re-resolves when a safeArea prop changes', async () => {
    const model = new GraphModel();
    const sink = fakeSink();
    const r = new Reconciler(new MockRenderer(), model, sink);
    await r.applyChanges(model.apply({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } }));
    const changes = model.apply({
      kind: 'setProp',
      id: 'root',
      path: 'safeArea',
      value: { landscape: { width: 1000, height: 500 }, portrait: { width: 500, height: 1000 } },
    });
    await r.applyChanges(changes);
    expect(sink.defs.at(-1)).toEqual({ landscape: { width: 1000, height: 500 }, portrait: { width: 500, height: 1000 } });
  });

  it('does not re-resolve on an unrelated Root prop change', async () => {
    const model = new GraphModel();
    const sink = fakeSink();
    const r = new Reconciler(new MockRenderer(), model, sink);
    await r.applyChanges(model.apply({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } }));
    const countAfterCreate = sink.defs.length;
    await r.applyChanges(model.apply({ kind: 'setProp', id: 'root', path: 'alpha', value: 0.5 }));
    expect(sink.defs.length).toBe(countAfterCreate);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `Reconciler` constructor takes only two args; `sink.setSafeAreas` is never called.

- [ ] **Step 3: Write the minimal implementation**

In `runtime/client/src/render/reconciler.ts`:

Add imports:

```ts
import { resolveSafeAreas } from './viewport';
import type { IViewportSink } from './viewportController';
```

Add the optional constructor arg:

```ts
  constructor(
    private readonly renderer: IRenderer,
    private readonly model: GraphModel,
    private readonly viewport?: IViewportSink,
  ) {}
```

In `created()`, push safe areas after mounting the Root:

```ts
    if (node.type === 'Root') {
      await this.renderer.mount(node.id);
      this.viewport?.setSafeAreas(resolveSafeAreas(node.props));
      return;
    }
```

In the `propSet` case, after `this.renderer.setProp(...)`, re-resolve when a Root safe-area-affecting prop changed:

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
        if (node && node.type === 'Root' && affectsSafeArea(change.path)) {
          this.viewport?.setSafeAreas(resolveSafeAreas(node.props));
        }
        return;
      }
```

Add the helper near the bottom of the file (replacing the deleted `numProp`):

```ts
function affectsSafeArea(path: string): boolean {
  return path === 'safeArea' || path.startsWith('safeArea.') || path === 'width' || path === 'height';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test client`
Expected: PASS — all four `reconciler.viewport.spec.ts` cases green; full suite green.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/render/reconciler.ts runtime/client/src/render/reconciler.viewport.spec.ts
git commit -m "feat(runtime): resolve Root safe areas through the reconciler"
```

---

### Task 5: Wire the controller into `createEngine` and `main.ts`

Construct the `ViewportController` inside `createEngine` (when a host surface is supplied), hand it to the reconciler as the sink, and expose viewport state to standalone/e2e from `main.ts`.

**Files:**
- Modify: `runtime/client/src/engine.ts`
- Modify: `runtime/client/src/main.ts`
- Test: `runtime/client/src/engine.viewport.spec.ts` (new)

**Interfaces:**
- Consumes: `ViewportController`, `domHostSurface`, `IHostSurface` from `./render/viewportController`.
- Produces: `createEngine` accepts an optional `surface?: IHostSurface` in its deps and returns an added `viewport?: ViewportController`. `main.ts` exposes `window.__engineViewport()` and `window.__engineViewportEvents`.

- [ ] **Step 1: Write the failing test**

Create `runtime/client/src/engine.viewport.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MockRenderer } from './render/mockRenderer';
import { createEngine } from './engine';
import type { IHostSurface, IViewport } from './render/viewportController';

describe('createEngine viewport wiring', () => {
  it('applies a viewport on Root creation when a surface is supplied', async () => {
    const renderer = new MockRenderer();
    const surface: IHostSurface = { size: () => ({ width: 1000, height: 450 }), onResize: () => () => {} };
    const { host, viewport } = createEngine({ renderer, post: () => {}, surface });
    await host.handle({
      v: 1,
      kind: 'init',
      id: 'i',
      document: {
        version: 1,
        nodes: {
          root: {
            id: 'root',
            type: 'Root',
            props: { safeArea: { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } } },
          },
        },
        edges: [],
      },
    });
    const applied = renderer.calls.find((x) => x[0] === 'applyViewport');
    expect(applied).toBeTruthy();
    expect((applied![1] as IViewport).orientation).toBe('landscape');
    expect(viewport?.current()?.scale).toBeCloseTo(0.625, 6);
  });

  it('works headless (no surface) — no applyViewport, no throw', async () => {
    const renderer = new MockRenderer();
    const { host, viewport } = createEngine({ renderer, post: () => {} });
    await host.handle({
      v: 1,
      kind: 'init',
      id: 'i',
      document: { version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] },
    });
    expect(renderer.calls.some((x) => x[0] === 'applyViewport')).toBe(false);
    expect(viewport).toBeUndefined();
  });
});
```

> The `IViewport` type is re-exported from `viewportController` for test convenience — add `export type { IViewport } from './viewport';` to `viewportController.ts` if it is not already importable there. (It is importable directly from `./viewport`; the test imports it from `viewportController` to keep one import line — adjust the import to `./render/viewport` if you prefer not to re-export.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test client`
Expected: FAIL — `createEngine` does not accept `surface` and does not return `viewport`.

- [ ] **Step 3: Write the minimal implementation**

In `runtime/client/src/engine.ts`, add the imports:

```ts
import { ViewportController, type IHostSurface } from './render/viewportController';
```

Reorder construction so the bus exists before the controller and reconciler, build the controller when a surface is present, pass it to the reconciler, and return it. Replace the body of `createEngine`:

```ts
export function createEngine(deps: {
  renderer: IRenderer;
  post: (m: OutboundMessage) => void;
  surface?: IHostSurface;
}): {
  host: ProtocolHost;
  model: GraphModel;
  modules: IEngineModules;
  viewport?: ViewportController;
} {
  const model = new GraphModel();
  const bus = createBus();
  const viewport = deps.surface ? new ViewportController({ surface: deps.surface, renderer: deps.renderer, bus }) : undefined;
  const reconciler = new Reconciler(deps.renderer, model, viewport);
  const moduleHost = createModuleHost({ model, reconciler, renderer: deps.renderer, bus });

  const registry = new ModuleRegistry();
  registry.register('reels', (args) => new ReelsModule(args));
  const reels = registry.create('reels', { id: 'reels', host: moduleHost, config: { parentId: 'root' } }) as ReelsModule;
  reels.mount();

  const orchestrator = new Orchestrator({ bus, reels });
  const host = new ProtocolHost({ model, reconciler, post: deps.post, onSpin: (o) => orchestrator.spin(o) });

  return { host, model, modules: { registry, orchestrator, reels, bus }, viewport };
}
```

In `runtime/client/src/main.ts`, build the DOM surface, pass it in, and expose viewport state. Add the import:

```ts
import { domHostSurface, type IViewport } from './render/viewportController';
```

Change the engine construction:

```ts
const surface = domHostSurface(stage);
const { host, model, modules, viewport } = createEngine({ renderer, post, surface });
```

After the existing `__engineModules` exposure block, add:

```ts
(window as unknown as { __engineViewport: () => IViewport | null }).__engineViewport = () => viewport?.current() ?? null;
const viewportEvents: IViewport[] = [];
modules.bus.on<IViewport>('viewport:changed', (e) => viewportEvents.push(e));
(window as unknown as { __engineViewportEvents: IViewport[] }).__engineViewportEvents = viewportEvents;
```

> If `IViewport` is not exported from `viewportController.ts`, add `export type { IViewport } from './viewport';` there, or import it from `./render/viewport` instead.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx nx test client`
Expected: PASS — `engine.viewport.spec.ts` green; `engine.spec.ts` and `engine.modules.spec.ts` still green (they call `createEngine` with no `surface`, so `viewport` is `undefined` and no `applyViewport` happens).

Run: `npx nx typecheck client`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/engine.ts runtime/client/src/main.ts runtime/client/src/engine.viewport.spec.ts runtime/client/src/render/viewportController.ts
git commit -m "feat(runtime): wire ViewportController into engine + main"
```

---

### Task 6: End-to-end validation (Playwright — authoritative)

Prove the real canvas in a real browser: fit, centering/bleed, orientation flip, and the `viewport:changed` signal — by resizing the iframe that hosts the engine.

**Files:**
- Create: `runtime/client/e2e/viewport.e2e.spec.ts`

**Interfaces:**
- Consumes: `window.__engineViewport()` and `window.__engineViewportEvents` exposed by `main.ts` (Task 5); standalone `?doc=` load path (existing).

- [ ] **Step 1: Write the e2e spec**

Create `runtime/client/e2e/viewport.e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

const DOC = encodeURIComponent(
  JSON.stringify({
    version: 1,
    nodes: {
      root: {
        id: 'root',
        type: 'Root',
        props: { safeArea: { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } } },
      },
    },
    edges: [],
  }),
);

const HARNESS = `
  <iframe id="engine" src="/?doc=data:application/json,${DOC}" width="1000" height="450" style="border:0"></iframe>
  <script>
    const frame = document.getElementById('engine');
    window.vp = () => frame.contentWindow.__engineViewport();
    window.vpEventCount = () => (frame.contentWindow.__engineViewportEvents || []).length;
    window.canvasWidth = () => {
      const c = frame.contentDocument.querySelector('canvas');
      return c ? c.clientWidth : null;
    };
    window.setFrame = (w, h) => { frame.width = w; frame.height = h; };
  </script>`;

test('fits the landscape safe area, centers it, and bleeds horizontally', async ({ page }) => {
  await page.goto('/');
  await page.setContent(HARNESS);

  await expect.poll(() => page.evaluate(() => (window as any).vp()?.orientation)).toBe('landscape');
  const vp = await page.evaluate(() => (window as any).vp());
  expect(vp.scale).toBeCloseTo(0.625, 3);
  expect(vp.offset).toEqual({ x: 100, y: 0 }); // symmetric horizontal bleed
  expect(vp.safeArea).toEqual({ width: 1280, height: 720 });

  // Canvas fills the host viewport (no fixed design buffer, no letterbox element).
  const cw = await page.evaluate(() => (window as any).canvasWidth());
  expect(Math.abs(cw - 1000)).toBeLessThanOrEqual(2);
});

test('swaps to the portrait safe area and fires viewport:changed on orientation flip', async ({ page }) => {
  await page.goto('/');
  await page.setContent(HARNESS);
  await expect.poll(() => page.evaluate(() => (window as any).vp()?.orientation)).toBe('landscape');

  await page.evaluate(() => (window as any).setFrame(450, 1000));

  await expect.poll(() => page.evaluate(() => (window as any).vp()?.orientation)).toBe('portrait');
  const vp = await page.evaluate(() => (window as any).vp());
  expect(vp.scale).toBeCloseTo(0.625, 3);
  expect(vp.offset).toEqual({ x: 0, y: 100 }); // vertical bleed now
  expect(vp.safeArea).toEqual({ width: 720, height: 1280 });

  // At least the initial landscape emit + the portrait emit.
  await expect.poll(() => page.evaluate(() => (window as any).vpEventCount())).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run the e2e suite (with the worktree port offset)**

PowerShell, from the worktree root:

```powershell
$env:BLOOM_PORT_OFFSET = "1"; npx nx e2e client
```

Expected: the two new specs PASS, and the existing `engine.e2e.spec.ts` / `reels.e2e.spec.ts` still PASS (the Root `width`/`height` they send now act as the fallback safe area at scale 1 in their 640×480 iframe, so nothing visibly changes).

If the `nx e2e client` target is not defined, fall back to:

```powershell
$env:BLOOM_PORT_OFFSET = "1"; cd runtime/client; npx playwright test; cd ../..
```

- [ ] **Step 3: Commit**

```bash
git add runtime/client/e2e/viewport.e2e.spec.ts
git commit -m "test(runtime): e2e for responsive root scaling + safe area"
```

---

### Task 7: Full gate sweep + push + PR

Run every frontend gate, then push the branch and open a PR (per repo branching policy — `main` is protected, PR is the only path).

**Files:** none (verification + git).

- [ ] **Step 1: Format**

```bash
node_modules/.bin/prettier --write runtime/client docs/superpowers
node_modules/.bin/prettier --check .
```

Expected: `--check` reports all matched files use Prettier code style.

- [ ] **Step 2: Typecheck + unit + build**

```bash
npx nx typecheck client && npx nx test client && npx nx build client
```

Expected: all three succeed.

- [ ] **Step 3: E2e once more (offset exported)**

```powershell
$env:BLOOM_PORT_OFFSET = "1"; npx nx e2e client
```

Expected: green.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/responsive-root-scaling
gh pr create --fill
```

---

## Self-Review

**Spec coverage:**

- §1 goal (scale root to fit, no over-render) → Tasks 2 (mount sizes to host, DPR cap, applyViewport) + 3 (controller) + 6 (e2e canvas-fills-host).
- §2 coordinate/fit model (Option 1, min-scale, centered, bleed, only-root-transformed) → Task 1 (`computeViewport`) + Task 2 (`applyViewport` transforms only the root) + Task 6 (offset/bleed assertions).
- §3 safe-area schema + fallback chain → Task 1 (`resolveSafeAreas`) + Task 4 (reconciler wiring) + Task 5 (live updates flow through `setSafeAreas`).
- §4 components (`computeViewport`, `ViewportController`, `applyViewport`, DPR cap) → Tasks 1, 2, 3.
- §5 data flow / wiring → Tasks 4 (reconciler) + 5 (engine + main, first synchronous compute via `setSafeAreas`→`recompute` after mount).
- §6 edge cases (zero size, square tiebreak, fallback, ResizeObserver absent, rAF coalescing, no-emit on same-shape resize) → Task 1 (square tiebreak, fallback), Task 3 (zero-size guard, coalescing, emit-only-on-shape-change, dispose), Task 3 `domHostSurface` (ResizeObserver-absent fallback).
- §7 testing (unit + e2e) → Tasks 1–5 units, Task 6 e2e.
- §8 scope/non-goals → respected: no module reflow implemented (controller only exposes `viewport:changed`), no `env()` insets, no outbound protocol message, no letterbox styling.

**Placeholder scan:** none — every step has concrete code/commands and expected output.

**Type consistency:** `IViewport`, `ISize`, `ISafeAreaDefs`, `Orientation` defined in Task 1 and used verbatim in Tasks 2–6. `IHostSurface`, `IViewportRenderer`, `IViewportSink`, `ViewportController` defined in Task 3; `IViewportSink` consumed in Task 4; `ViewportController`/`IHostSurface` consumed in Task 5. `applyViewport(vp)` / `mount(rootId)` signatures consistent across renderer interface, both implementations, and all call sites. `setSafeAreas` / `current` / `recompute` / `dispose` names consistent between Task 3 definition and Tasks 4–5 use.
