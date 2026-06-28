# Reels Rendering Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the projected reels grid usable — centered on the stage, with painted symbol labels, and visible immediately on live "Add Reels" (no refresh).

**Architecture:** Three localized fixes behind the existing module/renderer seams. (1) `ReelsModule.project()` computes a centered origin from the Root's `safeArea` when origin is unset. (2) `PixiRenderer` renders labels as siblings in the cell's parent container instead of the now-forbidden `Sprite.addChild`. (3) `PixiRenderer.mount()` becomes idempotent — a re-init reuses the one `Application`/canvas and resets the scene instead of mounting a second canvas.

**Tech Stack:** TypeScript, Pixi.js v8, Vitest (jsdom) for unit, Playwright for browser e2e. Worktree `C:\code\bloom.wt\reels-in-game`, branch `feat/reels-in-game`, `BLOOM_PORT_OFFSET=1` (backend :8001, engine :4301, frontend :4201).

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`IPlugin`, `IReelsConfig`). Copied verbatim from `docs/coding-standards.md`.
- **TDD is mandatory** — failing test first, watch it fail, minimal code to pass.
- **Browser e2e is NOT run in CI** — run locally against a replay backend.
- **Model contract (unchanged):** each cell node `reels:cell:c:r` keeps carrying `fill`, `size`, and `label` props — `reels.spec.ts` and `reelsModule.project.spec.ts` read them. Fixes change rendering/structure, never these declared props.
- **Pinned prettier:** format touched files with `node_modules/.bin/prettier --write`, never `npx prettier` (version skew).
- **Unit test runner:** from `runtime/client`, `npx vitest run <relpath>` (the nx `test` target runs `npx vitest run` with `cwd: runtime/client`).
- **Commits:** Conventional Commits, imperative mood.

---

### Task 1: Center the reel grid by default

**Files:**

- Modify: `runtime/client/src/modules/reels/reelsModule.ts`
- Test: `runtime/client/src/modules/reels/reelsModule.project.spec.ts`

**Interfaces:**

- Consumes: `IModuleHost.snapshot(): IGameDocument`, `validateConfig`/`resolveConfig`, `buildDesired(moduleId, raw)`.
- Produces:
  - `centeredOrigin(grid: { cols: number; rows: number; cellSize: number; spacing: number }, safe: { width: number; height: number }): { originX: number; originY: number }` — pure.
  - `ReelsModule.project()` now injects a centered origin into the config it passes to `buildDesired` when `originX`/`originY` are absent from the raw config; explicit origins pass through unchanged.

- [ ] **Step 1: Write the failing unit test for the pure helper**

Add to `reelsModule.project.spec.ts` — update the import line and append a describe:

```ts
import { ReelsModule, buildDesired, centeredOrigin, containerId, cellId } from './reelsModule';

function modelWithSafeArea(): GraphModel {
  const m = new GraphModel();
  m.apply({
    kind: 'addNode',
    id: 'root',
    type: 'Root',
    props: { safeArea: { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } } },
  });
  return m;
}

describe('centeredOrigin', () => {
  it('centers the visible grid block in the safe area', () => {
    // 5 cols x 3 rows, cellSize 100, spacing 8 -> span = 108
    expect(centeredOrigin({ cols: 5, rows: 3, cellSize: 100, spacing: 8 }, { width: 1280, height: 720 })).toEqual({
      originX: 1280 / 2 - (4 * 108) / 2, // 424
      originY: 720 / 2 - (2 * 108) / 2, // 252
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run (from `runtime/client`): `npx vitest run src/modules/reels/reelsModule.project.spec.ts -t "centeredOrigin"`
Expected: FAIL — `centeredOrigin` is not exported (compile/import error).

- [ ] **Step 3: Implement `centeredOrigin`**

In `reelsModule.ts`, after the `cellId` helper, add:

```ts
/** Centered origin so the visible rows×cols block sits in the middle of the safe area.
 *  (Buffer rows extend below, as today.) span = cellSize + spacing. */
export function centeredOrigin(
  grid: { cols: number; rows: number; cellSize: number; spacing: number },
  safe: { width: number; height: number },
): { originX: number; originY: number } {
  const span = grid.cellSize + grid.spacing;
  return {
    originX: safe.width / 2 - ((grid.cols - 1) * span) / 2,
    originY: safe.height / 2 - ((grid.rows - 1) * span) / 2,
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/modules/reels/reelsModule.project.spec.ts -t "centeredOrigin"`
Expected: PASS.

- [ ] **Step 5: Write the failing test for centered projection**

Append to `reelsModule.project.spec.ts`:

```ts
describe('ReelsModule.project centering', () => {
  it('defaults to a centered origin from the Root safe area when origin is unset', () => {
    const model = modelWithSafeArea();
    const m = new ReelsModule({
      id: 'r',
      host: modelHost(model),
      config: { rows: 3, cols: 5, cellSize: 100, spacing: 8, symbols: ['A', 'B', 'C'], parentId: 'root' },
    });
    m.project();
    const doc = model.toDocument();
    const reel0 = doc.nodes[containerId('r', 0)].props.position as { x: number; y: number };
    expect(reel0).toEqual({ x: 424, y: 252 }); // centered, not pinned to the corner
    expect((doc.nodes[containerId('r', 4)].props.position as { x: number }).x).toBe(424 + 4 * 108);
  });

  it('honors an explicit origin (no centering)', () => {
    const model = modelWithSafeArea();
    const m = new ReelsModule({ id: 'r', host: modelHost(model), config: { ...cfg, parentId: 'root' } });
    m.project();
    expect((model.toDocument().nodes[containerId('r', 0)].props.position as { x: number }).x).toBe(0); // cfg sets originX: 0
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run src/modules/reels/reelsModule.project.spec.ts -t "centering"`
Expected: FAIL — first case gets `{ x: 0, y: 0 }` (origin still defaults to 0), expected `{ x: 424, y: 252 }`.

- [ ] **Step 7: Implement centered origin in `project()`**

In `reelsModule.ts`, add the `IGameDocument` import:

```ts
import type { IGameDocument, JsonValue } from '../../model/document';
```

(Replace the existing `import type { JsonValue } from '../../model/document';`.)

Replace `project()` and add two private helpers on `ReelsModule`:

```ts
  project(): void {
    const snap = this.host.snapshot();
    const desired = buildDesired(this.id, this.withCenteredOrigin(this.config, snap));
    const owns = (nodeId: string) => nodeId.startsWith(`${this.id}:`);
    this.host.emit(reconcileOps(snap, desired, owns));
  }

  /** Fill a centered origin from the Root's landscape safe area when the config
   *  leaves originX/originY unset; explicit origins pass through unchanged. */
  private withCenteredOrigin(raw: Record<string, JsonValue>, doc: IGameDocument): Record<string, JsonValue> {
    if (raw.originX !== undefined && raw.originY !== undefined) return raw;
    const cfg = resolveConfig(raw);
    const { originX, originY } = centeredOrigin(cfg, this.landscapeSafeArea(doc));
    return { ...raw, originX: raw.originX ?? originX, originY: raw.originY ?? originY };
  }

  private landscapeSafeArea(doc: IGameDocument): { width: number; height: number } {
    const root = Object.values(doc.nodes).find((n) => n.type === 'Root');
    const land = (root?.props?.safeArea as { landscape?: { width?: number; height?: number } } | undefined)?.landscape;
    const w = typeof land?.width === 'number' && land.width > 0 ? land.width : 1280;
    const h = typeof land?.height === 'number' && land.height > 0 ? land.height : 720;
    return { width: w, height: h };
  }
```

- [ ] **Step 8: Run the whole reels project spec and watch it pass**

Run: `npx vitest run src/modules/reels/reelsModule.project.spec.ts`
Expected: PASS (new centering tests + all pre-existing tests — `cfg` sets `originX/originY: 0`, so those keep origin 0).

- [ ] **Step 9: Format and commit**

```bash
node_modules/.bin/prettier --write runtime/client/src/modules/reels/reelsModule.ts runtime/client/src/modules/reels/reelsModule.project.spec.ts
git add runtime/client/src/modules/reels/reelsModule.ts runtime/client/src/modules/reels/reelsModule.project.spec.ts
git commit -m "fix(reels): center the grid from the Root safe area when origin is unset"
```

---

### Task 2: Render symbol labels without `Sprite.addChild`

**Files:**

- Modify: `runtime/client/src/render/pixiRenderer.ts:139-170` (`setParent`, `applyLabel`)
- Test: `runtime/client/src/render/pixiRenderer.spec.ts`

**Root cause (confirmed live):** Pixi v8 forbids `Sprite.addChild` (`PixiJS Deprecation Warning: addChild: Only Containers will be allowed to add children in v8.0.0` at `pixiRenderer.ts:152`), so the label never paints. Fix: place the label `Text` as a sibling in the cell's parent `Container`, tracking the cell's position; re-home it when the cell is re-parented.

**Interfaces:**

- Consumes: `this.objects: Map<string, DisplayObject>`, `this.labels: Map<string, Text>`, `Sprite`, `Text`, `Container` from `pixi.js`.
- Produces: `placeLabel(sprite: Sprite, text: Text): void` (private) — adds/positions the label in the sprite's parent container; `setParent` re-homes the label alongside the child.

- [ ] **Step 1: Write the failing test**

Append to `pixiRenderer.spec.ts` (extend the top import to include `Sprite, Text`):

```ts
import { Container, Sprite, Text } from 'pixi.js';

describe('PixiRenderer.applyLabel', () => {
  function rendererWithStage() {
    const r = new PixiRenderer(document.createElement('div'));
    const stage = new Container();
    stage.sortableChildren = true;
    const internals = r as unknown as {
      app: { stage: Container };
      rootId: string;
      objects: Map<string, Container>;
      labels: Map<string, Text>;
    };
    internals.app = { stage };
    internals.rootId = 'root';
    internals.objects.set('root', stage);
    return { r, internals };
  }

  it('places the label as a sibling in the cell parent (never Sprite.addChild), tracking the cell position', () => {
    const { r, internals } = rendererWithStage();
    r.createObject('reel', 'Container');
    r.setParent('reel', 'root');
    r.createObject('cell', 'Sprite');
    r.setProp('cell', 'position', { x: 0, y: 108 });
    r.setProp('cell', 'label', 'A');
    r.setParent('cell', 'reel');

    const reel = internals.objects.get('reel')! as Container;
    const cell = internals.objects.get('cell')! as unknown as Container;
    const label = internals.labels.get('cell')!;
    expect(label.text).toBe('A');
    expect(label.parent).toBe(reel); // a real Container child — no deprecation
    expect(cell.children.length).toBe(0); // nothing added to the Sprite itself
    expect(label.position.x).toBe(0);
    expect(label.position.y).toBe(108);
  });

  it('updates an existing label in place without re-adding', () => {
    const { r, internals } = rendererWithStage();
    r.createObject('reel', 'Container');
    r.setParent('reel', 'root');
    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'reel');
    r.setProp('cell', 'label', 'A');
    const first = internals.labels.get('cell')!;
    r.setProp('cell', 'label', 'B');
    expect(internals.labels.get('cell')).toBe(first);
    expect(first.text).toBe('B');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run (from `runtime/client`): `npx vitest run src/render/pixiRenderer.spec.ts -t "applyLabel"`
Expected: FAIL — current `applyLabel` does `sprite.addChild(text)`, so `label.parent` is the cell Sprite (not `reel`) and `cell.children.length` is `1`.
(If construction of `new Text(...)` throws under jsdom, that surfaces here — Pixi v8 `Text` construction is lazy and should not touch a canvas; if it does, confirm the vitest jsdom environment provides a canvas stub before proceeding.)

- [ ] **Step 3: Implement sibling-label placement**

In `pixiRenderer.ts`, replace `setParent` (currently lines 139-146) with:

```ts
  setParent(childId: string, parentId: string | null): void {
    const child = this.objects.get(childId);
    if (!child) return;
    child.removeFromParent();
    const label = this.labels.get(childId);
    label?.removeFromParent();
    if (parentId === null) return;
    const parent = this.objects.get(parentId);
    if (parent) {
      (parent as Container).addChild(child);
      if (label && child instanceof Sprite) this.placeLabel(child, label);
    }
  }
```

Replace `applyLabel` (currently lines 157-170) with:

```ts
  private applyLabel(id: string, value: JsonValue): void {
    const obj = this.objects.get(id);
    if (!(obj instanceof Sprite)) return;
    const str = value == null ? '' : String(value);
    let text = this.labels.get(id);
    if (!text) {
      text = new Text({ text: str, style: { fill: '#0b0b0c', fontSize: 28, fontWeight: 'bold' } });
      text.anchor.set(0.5);
      text.zIndex = 1; // render above the cell background within the reel container
      this.labels.set(id, text);
    } else {
      text.text = str;
    }
    this.placeLabel(obj, text);
  }

  /** Labels live beside their cell in the cell's parent container — never as a child
   *  of the Sprite (Pixi v8 forbids Sprite children) — and track the cell's position. */
  private placeLabel(sprite: Sprite, text: Text): void {
    text.position.set(sprite.position.x, sprite.position.y);
    const parent = sprite.parent as Container | null;
    if (parent && text.parent !== parent) parent.addChild(text);
  }
```

- [ ] **Step 4: Run the label tests and watch them pass**

Run: `npx vitest run src/render/pixiRenderer.spec.ts -t "applyLabel"`
Expected: PASS.

- [ ] **Step 5: Run the full renderer + reels suites for regressions**

Run: `npx vitest run src/render/pixiRenderer.spec.ts src/render/pixiRenderer.handle.spec.ts src/modules/reels/reelsModule.behavior.spec.ts`
Expected: PASS (label is now a sibling; `destroyObject` still destroys the keyed label; `setBlur` still targets the cell).

- [ ] **Step 6: Format and commit**

```bash
node_modules/.bin/prettier --write runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/pixiRenderer.spec.ts
git add runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/pixiRenderer.spec.ts
git commit -m "fix(render): paint reel labels as container siblings, not Sprite.addChild"
```

---

### Task 3: Make `mount()` idempotent (no duplicate canvas on re-init)

**Files:**

- Modify: `runtime/client/src/render/pixiRenderer.ts:87-105` (`mount`)
- Test: `runtime/client/src/render/pixiRenderer.spec.ts`

**Root cause (reproduced live):** live "Add Reels" → `scene_snapshot` → `bridge.init(newDoc)` sends a second `init`; `GraphModel.load()` clears+rebuilds the model, re-creating Root → `Reconciler.created(Root)` → `PixiRenderer.mount()` runs again and news up a second `Application` + `<canvas>`. Fix: a re-init reuses the one Application and resets the scene.

**Interfaces:**

- Produces: `mount(rootId)` short-circuits to `resetScene(rootId)` when `this.app` already exists; `resetScene(rootId: string): void` (private) tears the scene down to bare root on the existing app.

- [ ] **Step 1: Write the failing test**

Append to `pixiRenderer.spec.ts`:

```ts
describe('PixiRenderer.mount idempotency', () => {
  it('a second mount reuses the existing Application/canvas and resets the scene to bare root', async () => {
    const r = new PixiRenderer(document.createElement('div'));
    const stage = new Container();
    stage.sortableChildren = true;
    const fakeApp = { stage, canvas: document.createElement('canvas'), ticker: { add() {}, remove() {} } };
    const internals = r as unknown as {
      app: unknown;
      rootId: string;
      objects: Map<string, Container>;
      labels: Map<string, Text>;
    };
    internals.app = fakeApp;
    internals.rootId = 'root';
    internals.objects.set('root', stage);

    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'root');
    expect(stage.children.length).toBe(1);

    await r.mount('root'); // re-init — must NOT build a new Application

    expect(internals.app).toBe(fakeApp); // same app reused — no second canvas
    expect(stage.children.length).toBe(0); // scene torn down
    expect(internals.objects.size).toBe(1); // only root remains
    expect(internals.objects.get('root')).toBe(stage);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/render/pixiRenderer.spec.ts -t "idempotency"`
Expected: FAIL — current `mount()` ignores the existing app and calls `new Application()` + `await app.init()`, which rejects under jsdom (no WebGL).

- [ ] **Step 3: Implement idempotent mount + resetScene**

In `pixiRenderer.ts`, at the top of `mount()` (before `const app = new Application();`), add the short-circuit:

```ts
  async mount(rootId: string): Promise<void> {
    if (this.app) {
      this.resetScene(rootId); // re-init reuses the one Application/canvas (no second mount)
      return;
    }
    const app = new Application();
    // ...rest unchanged...
```

Add this private method (e.g. directly after `mount`):

```ts
  /** A re-init reuses the existing Application: tear the scene down to bare root so
   *  the next projection rebuilds on the single canvas (no duplicate canvas). */
  private resetScene(rootId: string): void {
    const stage = this.app!.stage as unknown as Container;
    for (const [id, obj] of this.objects) {
      if (id === this.rootId) continue;
      obj.destroy();
    }
    for (const text of this.labels.values()) text.destroy();
    this.objects.clear();
    this.labels.clear();
    stage.removeChildren();
    this.rootId = rootId;
    this.objects.set(rootId, stage);
  }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/render/pixiRenderer.spec.ts -t "idempotency"`
Expected: PASS.

- [ ] **Step 5: Run the full client unit suite**

Run (from `runtime/client`): `npx vitest run`
Expected: PASS (all specs).

- [ ] **Step 6: Format and commit**

```bash
node_modules/.bin/prettier --write runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/pixiRenderer.spec.ts
git add runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/pixiRenderer.spec.ts
git commit -m "fix(render): make mount idempotent so live re-init reuses one canvas"
```

---

### Task 4: E2e lock-in — centered, labeled, single-canvas live add

**Files:**

- Modify: `studio/frontend/e2e/reels.spec.ts:50-56` (after the Add Reels projection assertion)

**Interfaces:**

- Consumes: engine frame globals `__engineModel`, `__engineRenderer` (the live `PixiRenderer` — `.objects`/`.labels` maps are readable at runtime in `frame.evaluate`).

This is the behavioral contract. It runs against the **fixed** stack (Tasks 1–3) and must be GREEN; without those fixes it would fail (duplicate canvases, `reels:reel:0` at x=0, a Text child on the cell Sprite).

- [ ] **Step 1: Bring up the offset-1 replay stack (background)**

In one terminal — replay backend on :8001:

```powershell
Set-Location C:\code\bloom.wt\reels-in-game\studio\backend
$env:BLOOM_PORT_OFFSET="1"; $env:PROVIDER_MODE="replay"; $env:MONGO_DB="bloom_studio_wt1"; $env:MEDIA_DIR="var/media_wt1"
uv run uvicorn app.main:app --host 0.0.0.0 --port 8001
```

In a second terminal — engine on :4301:

```powershell
Set-Location C:\code\bloom.wt\reels-in-game\runtime\client
$env:BLOOM_PORT_OFFSET="1"; npx vite --host 0.0.0.0
```

(Mongo on :27017 is already running. Playwright auto-starts the frontend on :4201 via its `webServer`. Do not touch offset-0 ports — another live session owns them.)

- [ ] **Step 2: Add the rendered-end-state assertions**

In `reels.spec.ts`, immediately after the existing block that asserts `cell.fill`/`cell.label` (around line 55, before the `// 2. Spin` comment), insert:

```ts
// Rendering fixes — assert the RENDERED end-state, not just the model:
// (a) live Add Reels rebuilds on a SINGLE canvas (idempotent re-init, no duplicate mount).
expect(await frame.evaluate(() => document.querySelectorAll('#stage canvas').length)).toBe(1);
// (b) the grid is centered, not pinned to the stage corner.
const reelX = await frame.evaluate(() => (window as any).__engineModel.toDocument().nodes['reels:reel:0'].props.position.x);
expect(reelX).toBeGreaterThan(0);
// (c) the label is a sibling Text, never a child of the cell Sprite (Pixi v8 forbids Sprite children).
expect(await frame.evaluate(() => (window as any).__engineRenderer.objects.get('reels:cell:0:0').children.length)).toBe(0);
expect(await frame.evaluate(() => (window as any).__engineRenderer.labels.has('reels:cell:0:0'))).toBe(true);
```

- [ ] **Step 3: Run the reels e2e (offset 1)**

Run (from repo root `C:\code\bloom.wt\reels-in-game`):

```powershell
$env:BLOOM_PORT_OFFSET="1"; npx playwright test --config=studio/frontend/playwright.config.ts reels
```

Expected: PASS — 1 canvas, `reels:reel:0` centered (x ≈ 424), cell Sprite has 0 children, label tracked. (global-setup performs a `/health` parity check against :8001 and fails fast if the backend is down — Step 1 must be up.)

- [ ] **Step 4: Sanity — confirm it would fail without the fixes (optional, recommended)**

Briefly `git stash` the Task 1–3 source changes (not the spec), re-run Step 3, observe FAIL (duplicate canvases / x=0 / a Text child), then `git stash pop`. This proves the e2e is a real lock, not a tautology.

- [ ] **Step 5: Format and commit**

```bash
node_modules/.bin/prettier --write studio/frontend/e2e/reels.spec.ts
git add studio/frontend/e2e/reels.spec.ts
git commit -m "test(e2e): lock centered layout, sibling labels, single-canvas live add"
```

---

### Task 5: Whole-branch verification, gates, and merge

Not a code task — the completion ritual. Do this only after Tasks 1–4 are committed.

- [ ] **Step 1: Manual app walkthrough.** With the offset-1 replay stack up (Task 4 Step 1), open `http://localhost:4201` (and LAN `http://192.168.1.240:4201`): create a room, open Game → preview, click **Add Reels** — the grid appears **immediately** (no refresh), **centered**, with **A/B/C labels painted**. Click **Spin** — reels settle on the server outcome. Confirm there is no faint red wash beyond cell bloom (expected; not a defect).

- [ ] **Step 2: Run all gates green.**
  - Rust: from `engine/` (or the crate root) `cargo fmt --check` and `cargo clippy`.
  - Frontend: `node_modules/.bin/prettier --check .`, then `npx nx typecheck client frontend`, `npx nx test client`, `npx nx build frontend`.
  - Backend: from `studio/backend`, `uv run pytest`.

- [ ] **Step 3: Rebase on main and re-run CI.** PR #125 merged after #123's CI ran: `git fetch origin && git rebase origin/main`, resolve any conflicts (watch the hot files noted in repo memory), push, and let CI re-run.

- [ ] **Step 4: Merge via the ritual.** Run `/bloom:complete-work` — it verifies CI, squash-merges the PR, cleans up the worktree/branch, restarts the live stack, and prints a change-specific test walkthrough.

---

## Self-Review

**Spec coverage:**

- Defect 1 (centering) → Task 1. ✓
- Defect 2 (labels / Pixi v8 `Sprite.addChild`) → Task 2. ✓
- Defect 3 (idempotent re-init / single canvas) → Task 3. ✓
- E2e asserts rendered end-state (centered, labels, one canvas) → Task 4. ✓
- Dark-red wash (no-op, documented) → confirmed in spec; Task 5 Step 1 visually re-checks. ✓
- Verify-in-app + gates + rebase + merge → Task 5. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code and every run step gives an exact command + expected result.

**Type consistency:** `centeredOrigin(grid, safe)` signature is identical in its test (Task 1 Step 1) and definition (Step 3) and call site (`withCenteredOrigin`, Step 7). `placeLabel(sprite, text)` is used identically in `applyLabel` and `setParent` (Task 2). `resetScene(rootId)` matches its sole caller in `mount` (Task 3). Engine globals `__engineModel`/`__engineRenderer` match `runtime/client/src/main.ts`. The model contract (`fill`/`size`/`label` on `reels:cell:c:r`) is preserved — no task changes `buildDesired`'s declared props.
