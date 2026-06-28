# Vision-in-the-loop scene composition — Plan 3: real-frame capture handshake

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the runtime-client postMessage protocol with a `capture` request and a **render-settled** `captured` reply carrying the rendered frame as a PNG, and relay that PNG studio→backend over the existing Socket.IO bridge — so the Plan 4 compose-loop orchestrator can grade the _actual_ engine frame.

**Architecture:** The runtime client gains a `capture` inbound message. `ProtocolHost` handles it by asking the render seam (`Reconciler.capture()` → `IRenderer.capture()`) for a PNG, then posts a `captured` reply (no `ack`). `PixiRenderer.capture()` is the load-bearing piece: it waits **one animation frame** so the just-applied ops are actually painted (the existing `ack` fires after `reconciler.applyChanges()` but _before_ Pixi paints), then `renderer.extract.base64(app.stage)` produces a `data:image/png;base64,…` URL. On the studio side, `ProtocolBridge` gains `capture(id)` + an `onCaptured` callback; the socket client forwards a backend `scene_capture_request` into the iframe and emits the returned PNG back as `scene_capture_result`. The backend adds a `SceneCaptureBroker` that emits `scene_capture_request` to the game room, awaits the matching `scene_capture_result`, and returns decoded PNG bytes — the awaitable seam Plan 4 drives.

**Tech Stack:** TypeScript (runtime client = nx project `client`, Pixi.js v8; studio frontend = nx project `frontend`, React + Socket.IO client), Python 3 / FastAPI + python-socketio backend, Vitest, pytest + pytest-asyncio, Playwright (local-only). This is plan #3 of 4 (see Roadmap).

## Roadmap (this plan is #3 of 4)

The approved spec (`docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md`) decomposes into four sequential, independently-shippable plans:

1. **`adjust_element` transform actuator** — the cheap layout lever (**MERGED**, PR #116).
2. **`SceneCritic` seam** — swappable vision critic, structured-output schema, live + replay impls (**MERGED**, PR #117).
3. **Real-frame capture handshake (THIS PLAN)** — `capture`/`captured` postMessage round-trip with a render-settled barrier + canvas→PNG extraction; relay studio→backend over the socket; the backend `SceneCaptureBroker` that awaits the frame. Frontend + backend + Playwright.
4. **Compose-loop orchestrator** — ties 1–3 together with the bounds (look-behind N=3, max-passes=3, regen budget K=5, transform-first), streams each critique/edit into the chat feed, and routes design-router branch 4 ("build a scene") into it. Backend integration + replay e2e + Playwright.

---

## Global Constraints

Copied from the spec and repo standards (`AGENTS.md`, `docs/coding-standards.md`). Every task implicitly includes these.

- **TDD is mandatory** — failing test first, watch it fail, minimal code to pass, then refactor.
- **Semantic (Conventional Commits) format** for every commit — `feat(scope): …`, imperative mood, ~50-char subject.
- **Worktree:** this work happens in `C:\code\bloom.wt\vision-capture` on branch `feat/vision-capture` with `BLOOM_PORT_OFFSET=1` (backend `:8001`, studio `:4201`, runtime client `:4301`). **Never use the default ports** — another live session holds `:4200/:4300/:8000`. Run all commands from inside the worktree.
- **Runtime-client unit tests:** from the worktree root, `npx nx test client` (Vitest, jsdom; binds no port). Filter to one file with `npx nx test client -- run src/protocol/protocolHost.spec.ts`.
- **Studio-frontend unit tests:** `npx nx test frontend` (Vitest). The full pre-PR frontend gate is **all four**: `node_modules/.bin/prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend` — a green Vitest run does **not** prove types compile (see `docs` memory `frontend-ci-gates`).
- **Backend unit tests:** `cd studio/backend && uv run pytest -m "not e2e"` — requires a `mongod` on `:27017` (shared singleton; tests use DB `bloom_studio_test`). The capture-broker tests touch **no Mongo and no network** (a fake `sio`), but the full-suite gate still needs the DB up.
- **Formatting:** run the **pinned** prettier, not `npx`, before every commit that touches `.ts`/`.tsx`/`.md`: `node_modules/.bin/prettier --write <files>` (a fresh `npx prettier` pulls a newer version that disagrees on markdown — see memory `pinned-prettier-not-npx`).
- **Two protocol type-decls, kept in sync by hand.** The runtime client (`runtime/client/src/protocol/messages.ts`) and the studio bridge (`studio/frontend/src/plugins/game/protocolBridge.ts`) each declare their **own** copy of `InboundMessage`/`OutboundMessage` (they live in different cross-origin bundles). The `capture` / `captured` shapes added here MUST match byte-for-byte across both. This is deliberate duplication, not a shared import.
- **PNG wire shape:** the `captured.png` field and the socket `png` field carry the **full data URL** string (`data:image/png;base64,<base64>`). The backend strips the `data:…,` prefix when decoding to bytes. Don't pre-strip on the client.
- **Browser e2e is local-only, never CI** (`AGENTS.md` CI-cost policy). The Playwright spec runs via `just e2e` against a replay backend.
- **Additive only.** Do not change the existing `init`/`op`/`batch`/`spin` handling, the `ack`/`error`/`ready` messages, or the existing socket events (`join_scene`/`leave_scene`/`scene_apply_op`/`scene_snapshot`/`scene_op`/`scene_op_rejected`). Capture is a new, parallel path.

---

## File Structure

**Runtime client (`runtime/client`, nx project `client`):**

- `src/protocol/messages.ts` — **modify.** Add `capture` to `InboundMessage`, `captured` to `OutboundMessage`.
- `src/render/renderer.ts` — **modify.** Add `capture(): Promise<string>` to the `IRenderer` interface.
- `src/render/mockRenderer.ts` — **modify.** Implement `capture()` (records the call, returns a fixed stub data URL).
- `src/render/pixiRenderer.ts` — **modify.** Implement `capture()` — render-settled rAF barrier + `extract.base64(app.stage)`.
- `src/render/reconciler.ts` — **modify.** Add `capture(): Promise<string>` delegating to the renderer.
- `src/protocol/protocolHost.ts` — **modify.** Add a `capture` branch: delegate to `reconciler.capture()`, post `captured`, skip the trailing `ack`.
- `src/protocol/protocolHost.spec.ts` — **modify.** Capture-branch tests.
- `src/render/reconciler.capture.spec.ts` — **create.** `Reconciler.capture()` delegation test.
- `src/render/pixiRenderer.capture.spec.ts` — **create.** Barrier + extract tests (injected fake app).

**Studio frontend (`studio/frontend`, nx project `frontend`):**

- `src/plugins/game/protocolBridge.ts` — **modify.** Add `capture`/`captured` to the local message types, an `onCaptured` dep, the `captured` dispatch, and the `capture(id)` method.
- `src/plugins/game/protocolBridge.spec.ts` — **modify.** `capture(id)` send + `captured`→`onCaptured` + origin-guard tests.
- `src/plugins/game/socketClient.ts` — **modify.** `scene_capture_request` → `applyCaptureRequest` → bridge; `emitSceneCaptureResult`; dev hook `__gameRequestCapture`.
- `src/plugins/game/socketClient.spec.ts` — **modify.** `applyCaptureRequest` relay tests.
- `src/plugins/game/GamePreviewPane.tsx` — **modify.** Wire `onCaptured` → `emitSceneCaptureResult`.
- `e2e/scene-capture.spec.ts` — **create.** Playwright round-trip (render-settled capture → `captured` PNG on the studio window).

**Backend (`studio/backend`):**

- `app/scene/capture.py` — **create.** `SceneCaptureBroker` + `_decode_png`.
- `app/scene/sockets.py` — **modify.** Add a `broker` parameter + a `scene_capture_result` handler.
- `app/main.py` — **modify.** Instantiate the broker, pass it to `register_scene_handlers`, expose it on `app.state`.
- `tests/test_scene_capture.py` — **create.** Broker correlation / timeout / decode + socket-handler tests.

---

### Task 1: Runtime-client capture protocol + render seam (MockRenderer path)

The protocol can request a frame and get a PNG back through the render seam, proven with `MockRenderer`. Pixi's real extraction is Task 2.

**Files:**

- Modify: `runtime/client/src/protocol/messages.ts`
- Modify: `runtime/client/src/render/renderer.ts`
- Modify: `runtime/client/src/render/mockRenderer.ts`
- Modify: `runtime/client/src/render/reconciler.ts`
- Modify: `runtime/client/src/protocol/protocolHost.ts`
- Modify: `runtime/client/src/protocol/protocolHost.spec.ts`
- Create: `runtime/client/src/render/reconciler.capture.spec.ts`

**Interfaces:**

- Consumes (existing): `IProtocolDeps { model, reconciler, post, onSpin? }`; `Reconciler(renderer, model, viewport?)` holds `private readonly renderer: IRenderer`; `MockRenderer.calls: Array<[string, ...unknown[]]>`.
- Produces (relied on by Tasks 2–6):
  - `InboundMessage` gains `{ v: 1; kind: 'capture'; id: string }`.
  - `OutboundMessage` gains `{ v: 1; kind: 'captured'; id: string; png: string }`.
  - `IRenderer.capture(): Promise<string>` — a PNG data URL, or `''` if not mounted.
  - `Reconciler.capture(): Promise<string>` — delegates to the renderer.
  - `ProtocolHost.handle({kind:'capture'})` posts `captured` (never `ack`); on throw posts `error` with code `internal`.

- [ ] **Step 1: Write the failing tests**

Append to `runtime/client/src/protocol/protocolHost.spec.ts` (inside the `describe('ProtocolHost', …)` block):

```typescript
it('captures the rendered frame and replies with captured (not ack)', async () => {
  const { host, sent } = setup();
  await host.handle({ v: 1, kind: 'capture', id: 'c1' });
  expect(sent).toContainEqual({ v: 1, kind: 'captured', id: 'c1', png: 'data:image/png;base64,MOCK' });
  expect(sent.some((m) => m.kind === 'ack' && m.id === 'c1')).toBe(false);
});

it('reports an error (not captured) when capture throws', async () => {
  const model = new GraphModel();
  const fakeReconciler = {
    applyChanges: async () => {},
    capture: async () => {
      throw new Error('extract failed');
    },
  } as unknown as import('../render/reconciler').Reconciler;
  const sent: OutboundMessage[] = [];
  const host = new ProtocolHost({ model, reconciler: fakeReconciler, post: (m) => sent.push(m) });
  await host.handle({ v: 1, kind: 'capture', id: 'c2' });
  expect(sent.some((m) => m.kind === 'error' && m.id === 'c2' && m.code === 'internal')).toBe(true);
  expect(sent.some((m) => m.kind === 'captured')).toBe(false);
});
```

Create `runtime/client/src/render/reconciler.capture.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from './mockRenderer';
import { Reconciler } from './reconciler';

describe('Reconciler.capture', () => {
  it('delegates to the renderer and returns its png data url', async () => {
    const renderer = new MockRenderer();
    const reconciler = new Reconciler(renderer, new GraphModel());
    expect(await reconciler.capture()).toBe('data:image/png;base64,MOCK');
    expect(renderer.calls).toContainEqual(['capture']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx nx test client -- run src/protocol/protocolHost.spec.ts src/render/reconciler.capture.spec.ts`
Expected: FAIL — `capture` is not on `MockRenderer`/`Reconciler` and the `capture` message kind is unhandled (TS error / assertion failures).

- [ ] **Step 3: Add the message kinds**

In `runtime/client/src/protocol/messages.ts`, extend the two unions:

```typescript
export type InboundMessage =
  | { v: 1; kind: 'init'; id: string; document?: IGameDocument }
  | { v: 1; kind: 'op'; id: string; op: Op }
  | { v: 1; kind: 'batch'; id: string; ops: Op[] }
  | { v: 1; kind: 'spin'; id: string; outcome: IOutcome }
  | { v: 1; kind: 'capture'; id: string };

export type OutboundMessage =
  | { v: 1; kind: 'ready'; protocolVersion: 1 }
  | { v: 1; kind: 'ack'; id: string }
  | { v: 1; kind: 'captured'; id: string; png: string }
  | { v: 1; kind: 'error'; id: string; code: string; message: string };
```

- [ ] **Step 4: Add `capture` to the renderer seam**

In `runtime/client/src/render/renderer.ts`, add to the `IRenderer` interface (after `onTick`):

```typescript
  /** Render-settled capture of the current frame as a PNG data URL
   *  ("data:image/png;base64,..."). Resolves to '' if not yet mounted. */
  capture(): Promise<string>;
```

In `runtime/client/src/render/mockRenderer.ts`, add the method (after `onTick`):

```typescript
  async capture(): Promise<string> {
    this.calls.push(['capture']);
    return 'data:image/png;base64,MOCK';
  }
```

In `runtime/client/src/render/reconciler.ts`, add after `applyChanges`:

```typescript
  /** Capture the current rendered frame as a PNG data URL (render-settled). */
  capture(): Promise<string> {
    return this.renderer.capture();
  }
```

> Note: `PixiRenderer` will fail to satisfy `IRenderer` until Task 2 adds its `capture()`. That's expected — Task 1 verifies via `MockRenderer`; run the full `client` typecheck only after Task 2.

- [ ] **Step 5: Add the `capture` branch to `ProtocolHost`**

In `runtime/client/src/protocol/protocolHost.ts`, inside `handle`, add a branch **before** the final `this.deps.post({ … kind: 'ack' … })`. Insert it after the `spin` branch and before the closing `else { return; }`:

```typescript
      } else if (msg.kind === 'capture') {
        const png = await this.deps.reconciler.capture();
        this.deps.post({ v: 1, kind: 'captured', id: msg.id, png });
        return; // capture replies with `captured`, not the generic `ack`
      } else {
        return;
      }
```

(The existing `try`/`catch` already turns a thrown capture error into an `error` message with code `internal`, satisfying the second test.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx nx test client -- run src/protocol/protocolHost.spec.ts src/render/reconciler.capture.spec.ts`
Expected: PASS (new capture tests + all pre-existing ProtocolHost tests).

- [ ] **Step 7: Commit**

```bash
node_modules/.bin/prettier --write runtime/client/src/protocol/messages.ts runtime/client/src/protocol/protocolHost.ts runtime/client/src/protocol/protocolHost.spec.ts runtime/client/src/render/renderer.ts runtime/client/src/render/mockRenderer.ts runtime/client/src/render/reconciler.ts runtime/client/src/render/reconciler.capture.spec.ts
git add runtime/client/src/protocol/messages.ts runtime/client/src/protocol/protocolHost.ts runtime/client/src/protocol/protocolHost.spec.ts runtime/client/src/render/renderer.ts runtime/client/src/render/mockRenderer.ts runtime/client/src/render/reconciler.ts runtime/client/src/render/reconciler.capture.spec.ts
git commit -m "feat(client): add capture/captured protocol + render-seam capture"
```

---

### Task 2: `PixiRenderer.capture()` — render-settled barrier + canvas extraction

The load-bearing piece called out in the spec (§2): wait for the engine to actually **paint** the just-applied op, then extract the canvas to a PNG. Without the one-frame wait the critic grades a stale frame.

**Files:**

- Modify: `runtime/client/src/render/pixiRenderer.ts`
- Create: `runtime/client/src/render/pixiRenderer.capture.spec.ts`

**Interfaces:**

- Consumes (existing in `pixiRenderer.ts`): `private app: Application | null`; `app.stage` (a Pixi `Container`); Pixi v8 `app.renderer.extract.base64(target)` → `Promise<string>` (defaults to a `data:image/png;base64,…` URL); the browser `requestAnimationFrame`.
- Produces: `PixiRenderer.capture(): Promise<string>` satisfying `IRenderer.capture` (Task 1).

- [ ] **Step 1: Write the failing tests**

Create `runtime/client/src/render/pixiRenderer.capture.spec.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PixiRenderer } from './pixiRenderer';

describe('PixiRenderer.capture', () => {
  it('returns an empty string before mount (no app)', async () => {
    const r = new PixiRenderer(document.createElement('div'));
    expect(await r.capture()).toBe('');
  });

  it('waits one animation frame (render-settled) then extracts the stage as a png data url', async () => {
    const r = new PixiRenderer(document.createElement('div'));
    const stage = { __isStage: true };
    const base64 = vi.fn(async () => 'data:image/png;base64,AAAA');
    // Inject a fake mounted app — mirrors the private-field injection pattern in
    // pixiRenderer.handle.spec.ts ("buffers ticks ... once the app exists").
    (r as unknown as { app: unknown }).app = { stage, renderer: { extract: { base64 } } };
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');

    const png = await r.capture();

    expect(raf).toHaveBeenCalledTimes(1); // render-settled barrier
    expect(base64).toHaveBeenCalledWith(stage); // extracts the whole stage
    expect(png).toBe('data:image/png;base64,AAAA');
    raf.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx nx test client -- run src/render/pixiRenderer.capture.spec.ts`
Expected: FAIL — `r.capture is not a function`.

- [ ] **Step 3: Implement `capture()`**

In `runtime/client/src/render/pixiRenderer.ts`, add this method to the `PixiRenderer` class (e.g. immediately after `onTick`, before `flushPendingTicks`):

```typescript
  async capture(): Promise<string> {
    const app = this.app;
    if (!app) return '';
    // Render-settled barrier (spec §2): the protocol acks a change after the
    // reconciler mutates the scene graph but BEFORE Pixi paints it. Wait one
    // animation frame so the just-applied ops (texture uploads, new bounds) are
    // drawn, then extract — otherwise the critic would grade a stale frame.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return app.renderer.extract.base64(app.stage);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx nx test client -- run src/render/pixiRenderer.capture.spec.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Run the whole `client` project (Vitest + typecheck) to verify green**

Run: `npx nx test client`
Then: `npx nx typecheck client`
Expected: PASS — `PixiRenderer` now satisfies `IRenderer` (capture added), and all existing client tests stay green.

- [ ] **Step 6: Commit**

```bash
node_modules/.bin/prettier --write runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/pixiRenderer.capture.spec.ts
git add runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/pixiRenderer.capture.spec.ts
git commit -m "feat(client): render-settled PixiRenderer.capture via extract.base64"
```

---

### Task 3: Studio `ProtocolBridge` — `capture(id)` + `onCaptured`

The studio half of the postMessage protocol: send a `capture` request into the iframe and surface the `captured` reply. Pure bridge logic, unit-tested in isolation (the socket + pane wiring is Task 5).

**Files:**

- Modify: `studio/frontend/src/plugins/game/protocolBridge.ts`
- Modify: `studio/frontend/src/plugins/game/protocolBridge.spec.ts`

**Interfaces:**

- Consumes (existing): `IProtocolBridgeDeps { post, engineOrigin, onError? }`; `ProtocolBridge.send` (queues until `ready`); `handleEngineMessage(data, origin)` (origin-guarded).
- Produces (relied on by Task 5): the bridge's local `InboundMessage` gains `{ v: 1; kind: 'capture'; id: string }`; `OutboundMessage` gains `{ v: 1; kind: 'captured'; id: string; png: string }`; `IProtocolBridgeDeps.onCaptured?: (c: { id: string; png: string }) => void`; method `capture(id: string): void`.

- [ ] **Step 1: Write the failing tests**

Append to `studio/frontend/src/plugins/game/protocolBridge.spec.ts` (inside the `describe('ProtocolBridge', …)` block):

```typescript
it('sends a capture request carrying the given id', () => {
  const { bridge, post } = setup();
  bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, ENGINE);
  bridge.capture('cap1');
  expect(post).toHaveBeenCalledWith({ v: 1, kind: 'capture', id: 'cap1' }, ENGINE);
});

it('surfaces a captured png via onCaptured', () => {
  const onCaptured = vi.fn();
  const bridge = new ProtocolBridge({ post: vi.fn(), engineOrigin: ENGINE, onCaptured });
  bridge.handleEngineMessage({ v: 1, kind: 'captured', id: 'cap1', png: 'data:image/png;base64,AAAA' }, ENGINE);
  expect(onCaptured).toHaveBeenCalledWith({ id: 'cap1', png: 'data:image/png;base64,AAAA' });
});

it('ignores a captured message from a foreign origin', () => {
  const onCaptured = vi.fn();
  const bridge = new ProtocolBridge({ post: vi.fn(), engineOrigin: ENGINE, onCaptured });
  bridge.handleEngineMessage({ v: 1, kind: 'captured', id: 'cap1', png: 'x' }, 'http://evil:9999');
  expect(onCaptured).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx nx test frontend -- run src/plugins/game/protocolBridge.spec.ts`
Expected: FAIL — `bridge.capture is not a function`; `captured` is an unknown kind (`onCaptured` never fires).

- [ ] **Step 3: Extend the bridge**

In `studio/frontend/src/plugins/game/protocolBridge.ts`:

Add `capture` to the local `InboundMessage` union and `captured` to `OutboundMessage`:

```typescript
type InboundMessage =
  | { v: 1; kind: 'init'; id: string; document?: ISceneDocument }
  | { v: 1; kind: 'op'; id: string; op: ISceneOp }
  | { v: 1; kind: 'batch'; id: string; ops: ISceneOp[] }
  | { v: 1; kind: 'capture'; id: string };

type OutboundMessage =
  | { v: 1; kind: 'ready'; protocolVersion: 1 }
  | { v: 1; kind: 'ack'; id: string }
  | { v: 1; kind: 'captured'; id: string; png: string }
  | { v: 1; kind: 'error'; id: string; code: string; message: string };
```

Add the `onCaptured` dep:

```typescript
export interface IProtocolBridgeDeps {
  post: (m: InboundMessage, targetOrigin: string) => void;
  engineOrigin: string;
  onError?: (e: { code: string; message: string }) => void;
  onCaptured?: (c: { id: string; png: string }) => void;
}
```

In `handleEngineMessage`, add a `captured` branch alongside the existing `error` branch:

```typescript
    } else if (data.kind === 'error') {
      this.deps.onError?.({ code: data.code, message: data.message });
    } else if (data.kind === 'captured') {
      this.deps.onCaptured?.({ id: data.id, png: data.png });
    }
```

Add the public method (next to `op` / `batch`):

```typescript
  /** Request a render-settled frame capture. The engine replies with `captured`,
   *  surfaced via deps.onCaptured. `id` is the backend-issued captureId so the
   *  PNG can be correlated when relayed back over the socket. */
  capture(id: string): void {
    this.send({ v: 1, kind: 'capture', id });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx nx test frontend -- run src/plugins/game/protocolBridge.spec.ts`
Expected: PASS (new tests + all pre-existing bridge tests).

- [ ] **Step 5: Commit**

```bash
node_modules/.bin/prettier --write studio/frontend/src/plugins/game/protocolBridge.ts studio/frontend/src/plugins/game/protocolBridge.spec.ts
git add studio/frontend/src/plugins/game/protocolBridge.ts studio/frontend/src/plugins/game/protocolBridge.spec.ts
git commit -m "feat(studio): bridge capture(id) request + onCaptured reply"
```

---

### Task 4: Backend `SceneCaptureBroker` + `scene_capture_result` handler

The backend awaitable seam Plan 4 drives: emit a capture request to the game room, await the matching result, return decoded PNG bytes. Includes the socket handler that resolves it.

**Files:**

- Create: `studio/backend/app/scene/capture.py`
- Modify: `studio/backend/app/scene/sockets.py`
- Modify: `studio/backend/app/main.py`
- Create: `studio/backend/tests/test_scene_capture.py`

**Interfaces:**

- Consumes (existing): `register_scene_handlers(sio, hub)` in `app/scene/sockets.py`; the `sio` AsyncServer with `async emit(event, data, *, room=…/to=…)` and `on(event)` decorator; `app/main.py` already calls `register_scene_handlers(sio, scene_hub)` (line ~141) and assigns `fastapi_app.state.*`.
- Produces (relied on by Plan 4 + Task 5):
  - `class SceneCaptureBroker(sio)` with `async request_capture(game_id: str, *, timeout: float = 10.0) -> bytes` (emits `scene_capture_request {gameId, captureId}` to `room=game_id`, awaits, returns PNG bytes; raises `asyncio.TimeoutError` on timeout) and `resolve_capture(capture_id: str, png_data_url: str) -> None`.
  - `register_scene_handlers(sio, hub, broker)` (new required 3rd arg) registers a `scene_capture_result` handler calling `broker.resolve_capture(data["captureId"], data["png"])`.
  - `fastapi_app.state.capture_broker`.

- [ ] **Step 1: Confirm the only caller of `register_scene_handlers`**

Run: `cd studio/backend && uv run python -c "import subprocess" ; grep -rn "register_scene_handlers" app tests`
Expected: exactly one call site — `app/main.py`. (If a test also calls it, update that call to pass a broker too.)

- [ ] **Step 2: Write the failing tests**

Create `studio/backend/tests/test_scene_capture.py`:

```python
import asyncio
import base64

import pytest

from app.scene.capture import SceneCaptureBroker, _decode_png
from app.scene.sockets import register_scene_handlers


class _FakeSio:
    def __init__(self):
        self.emits = []
        self.handlers = {}

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn

        return deco

    async def emit(self, event, data=None, **kw):
        self.emits.append((event, data, kw))

    async def enter_room(self, *a, **k): ...
    async def leave_room(self, *a, **k): ...


def _url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode()


def test_decode_png_strips_data_url_prefix_and_accepts_bare_base64():
    raw = b"\x89PNG\r\n\x1a\n-bytes"
    assert _decode_png(_url(raw)) == raw
    assert _decode_png(base64.b64encode(raw).decode()) == raw


@pytest.mark.asyncio
async def test_request_capture_emits_request_and_resolves_with_decoded_png():
    sio = _FakeSio()
    broker = SceneCaptureBroker(sio)
    task = asyncio.create_task(broker.request_capture("g1", timeout=5))
    await asyncio.sleep(0)  # let the coroutine emit + register its future

    event, data, _ = sio.emits[-1]
    assert event == "scene_capture_request"
    assert data["gameId"] == "g1"
    capture_id = data["captureId"]

    raw = b"\x89PNGframe-bytes"
    broker.resolve_capture(capture_id, _url(raw))
    assert await task == raw


@pytest.mark.asyncio
async def test_request_capture_times_out_when_no_result_arrives():
    broker = SceneCaptureBroker(_FakeSio())
    with pytest.raises(asyncio.TimeoutError):
        await broker.request_capture("g1", timeout=0.05)


def test_resolve_unknown_capture_id_is_a_no_op():
    broker = SceneCaptureBroker(_FakeSio())
    broker.resolve_capture("nope", _url(b"x"))  # must not raise


@pytest.mark.asyncio
async def test_scene_capture_result_handler_resolves_the_broker():
    sio = _FakeSio()
    broker = SceneCaptureBroker(sio)

    class _Hub:  # join/leave/apply handlers are registered too but unused here
        async def attach(self, *a, **k): ...
        async def apply_op(self, *a, **k): ...

    register_scene_handlers(sio, _Hub(), broker)
    assert "scene_capture_result" in sio.handlers

    task = asyncio.create_task(broker.request_capture("g1", timeout=5))
    await asyncio.sleep(0)
    capture_id = sio.emits[-1][1]["captureId"]

    raw = b"PNGpayload"
    await sio.handlers["scene_capture_result"]("sid", {"captureId": capture_id, "png": _url(raw)})
    assert await task == raw
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_scene_capture.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.scene.capture'`.

- [ ] **Step 4: Create the broker**

Create `studio/backend/app/scene/capture.py`:

```python
"""Real-frame capture broker (vision-compose Plan 3).

Correlates a backend capture *request* — emitted to the game room over
Socket.IO as ``scene_capture_request`` — with the asynchronous
``scene_capture_result`` the studio relays back from the runtime-client iframe.
The Plan 4 compose-loop orchestrator calls ``request_capture`` and awaits the
decoded PNG bytes; the ``scene_capture_result`` socket handler calls
``resolve_capture`` when the studio posts the frame back. See
``docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md`` §2.
"""

import asyncio
import base64


def _decode_png(data_url: str) -> bytes:
    """Decode a ``data:image/png;base64,<...>`` URL (or a bare base64 string)."""
    payload = data_url.split(",", 1)[1] if data_url.startswith("data:") else data_url
    return base64.b64decode(payload)


class SceneCaptureBroker:
    """Awaitable request/response bridge for runtime-client frame captures."""

    def __init__(self, sio):
        self._sio = sio
        self._pending: dict[str, asyncio.Future] = {}
        self._seq = 0

    async def request_capture(self, game_id: str, *, timeout: float = 10.0) -> bytes:
        """Ask the game room to capture its rendered frame; return PNG bytes.

        Emits ``scene_capture_request`` with a fresh ``captureId`` and awaits the
        matching ``resolve_capture``. Raises ``asyncio.TimeoutError`` if no
        result arrives within ``timeout`` seconds (e.g. no client attached).
        """
        self._seq += 1
        capture_id = f"cap{self._seq}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[capture_id] = fut
        await self._sio.emit(
            "scene_capture_request",
            {"gameId": game_id, "captureId": capture_id},
            room=game_id,
        )
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(capture_id, None)

    def resolve_capture(self, capture_id: str, png_data_url: str) -> None:
        """Complete the pending request for ``capture_id`` with decoded bytes.

        A no-op for an unknown / already-resolved id (late or duplicate reply).
        """
        fut = self._pending.get(capture_id)
        if fut is None or fut.done():
            return
        fut.set_result(_decode_png(png_data_url))
```

- [ ] **Step 5: Add the socket handler**

In `studio/backend/app/scene/sockets.py`, change the signature to accept the broker and register the result handler. Replace the `def register_scene_handlers(sio, hub):` line with:

```python
def register_scene_handlers(sio, hub, broker):
```

and add, after the existing `scene_apply_op` handler (inside the function):

```python
    @sio.on("scene_capture_result")
    async def scene_capture_result(sid, data):
        broker.resolve_capture(data.get("captureId"), data.get("png", ""))
```

- [ ] **Step 6: Wire the broker in `main.py`**

In `studio/backend/app/main.py`, add the import near the other scene imports:

```python
from app.scene.capture import SceneCaptureBroker
```

Replace the existing `register_scene_handlers(sio, scene_hub)` line (~141) with:

```python
    capture_broker = SceneCaptureBroker(sio)
    register_scene_handlers(sio, scene_hub, capture_broker)
```

and add this alongside the other `fastapi_app.state.*` assignments (after line ~133):

```python
    fastapi_app.state.capture_broker = capture_broker
```

- [ ] **Step 7: Run the capture tests, then the full backend suite**

Run: `cd studio/backend && uv run pytest tests/test_scene_capture.py -v`
Expected: PASS (all five tests).

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS — the new module/handler plus **all existing tests** (the broker is additive; the only behavioral change is the new required `broker` arg, and Step 1 confirmed `main.py` is the sole caller).

- [ ] **Step 8: Commit**

```bash
git add studio/backend/app/scene/capture.py studio/backend/app/scene/sockets.py studio/backend/app/main.py studio/backend/tests/test_scene_capture.py
git commit -m "feat(scene): SceneCaptureBroker + scene_capture_result relay"
```

---

### Task 5: Studio socket relay + pane wiring

Connect the two halves: a backend `scene_capture_request` forwards into the iframe via the bridge, and the iframe's `captured` PNG is emitted back to the backend as `scene_capture_result`.

**Files:**

- Modify: `studio/frontend/src/plugins/game/socketClient.ts`
- Modify: `studio/frontend/src/plugins/game/socketClient.spec.ts`
- Modify: `studio/frontend/src/plugins/game/GamePreviewPane.tsx`

**Interfaces:**

- Consumes: `getBridge()` + `ProtocolBridge.capture(id)` (Task 3); `isActive(gameId)`, the module-level `sock`, and the `import.meta.env.PROD` dev-hook pattern (existing in `socketClient.ts`); event names `scene_capture_request` / `scene_capture_result` (Task 4).
- Produces:
  - `applyCaptureRequest(payload: { gameId: string; captureId: string }): void` — exported, gated by `isActive`, calls `getBridge()?.capture(captureId)`.
  - `emitSceneCaptureResult(gameId: string, captureId: string, png: string): void` — emits `scene_capture_result`.
  - dev hook `window.__gameRequestCapture(captureId)` (non-PROD).
  - `GamePreviewPane` constructs the bridge with `onCaptured: ({ id, png }) => emitSceneCaptureResult(activeGameId, id, png)`.

- [ ] **Step 1: Write the failing tests**

Append to `studio/frontend/src/plugins/game/socketClient.spec.ts`. First extend the import on line 5 to include the new function:

```typescript
import { applyInbound, applyCaptureRequest } from './socketClient';
```

Then add a new describe block at the end of the file:

```typescript
describe('game socket capture relay', () => {
  it('scene_capture_request forwards a capture to the active bridge', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applyCaptureRequest({ gameId: 'g1', captureId: 'cap1' });

    expect(post).toHaveBeenCalledWith({ v: 1, kind: 'capture', id: 'cap1' }, 'http://localhost:4300');
  });

  it('ignores a capture request for an inactive game', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applyCaptureRequest({ gameId: 'other', captureId: 'cap1' });

    expect(post).not.toHaveBeenCalled();
  });
});
```

(`beforeEach` already sets `activeGameId` to `'g1'`; `ProtocolBridge` + `setBridge` are already imported on line 6.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx nx test frontend -- run src/plugins/game/socketClient.spec.ts`
Expected: FAIL — `applyCaptureRequest` is not exported.

- [ ] **Step 3: Add the relay to `socketClient.ts`**

In `studio/frontend/src/plugins/game/socketClient.ts`, add the exported relay function (next to `applyInbound`):

```typescript
export function applyCaptureRequest(payload: { gameId: string; captureId: string }): void {
  if (!isActive(payload.gameId)) return;
  getBridge()?.capture(payload.captureId);
}
```

Inside `connect()`, register the socket listener next to the existing `scene_op` listener:

```typescript
sock.on('scene_capture_request', (p) => applyCaptureRequest(p as { gameId: string; captureId: string }));
```

Extend the existing non-PROD dev-hook block in `connect()` to expose a capture trigger:

```typescript
if (!import.meta.env.PROD) {
  (window as unknown as { __gameApplyInbound?: typeof applyInbound }).__gameApplyInbound = applyInbound;
  (window as unknown as { __gameJoinScene?: (gameId: string) => void }).__gameJoinScene = (gameId: string) => sock?.emit('join_scene', { gameId });
  (window as unknown as { __gameRequestCapture?: (captureId: string) => void }).__gameRequestCapture = (captureId: string) => getBridge()?.capture(captureId);
}
```

Add the emit function (next to `emitSceneApplyOp`):

```typescript
export function emitSceneCaptureResult(gameId: string, captureId: string, png: string): void {
  sock?.emit('scene_capture_result', { gameId, captureId, png });
}
```

- [ ] **Step 4: Wire `onCaptured` in `GamePreviewPane.tsx`**

In `studio/frontend/src/plugins/game/GamePreviewPane.tsx`, extend the socketClient import (line 6 area) — note `engineOrigin`/`backendOrigin` come from `./config`, so add a separate import for the emit:

```typescript
import { emitSceneCaptureResult } from './socketClient';
```

Then pass `onCaptured` when constructing the bridge (inside the `useEffect`):

```typescript
const bridge = new ProtocolBridge({
  engineOrigin: origin,
  post: (m, targetOrigin) => frame.contentWindow?.postMessage(m, targetOrigin),
  onCaptured: ({ id, png }) => emitSceneCaptureResult(activeGameId, id, png),
});
```

(`activeGameId` is already in scope from `const activeGameId = s.activeGameId.get();` and the effect's guard guarantees it is non-null.)

- [ ] **Step 5: Run the frontend tests + full gate**

Run: `npx nx test frontend`
Then: `npx nx typecheck frontend` and `npx nx build frontend`
Expected: PASS on all three — new relay tests green, types compile (the `onCaptured` dep + new exports), build succeeds.

- [ ] **Step 6: Commit**

```bash
node_modules/.bin/prettier --write studio/frontend/src/plugins/game/socketClient.ts studio/frontend/src/plugins/game/socketClient.spec.ts studio/frontend/src/plugins/game/GamePreviewPane.tsx
git add studio/frontend/src/plugins/game/socketClient.ts studio/frontend/src/plugins/game/socketClient.spec.ts studio/frontend/src/plugins/game/GamePreviewPane.tsx
git commit -m "feat(studio): relay frame capture between backend socket and iframe"
```

---

### Task 6: Playwright e2e — render-settled capture round-trip

The client-perspective contract (per `AGENTS.md`): in a real browser, a capture request reaches the runtime-client iframe, the engine waits for paint, extracts the canvas, and posts a real PNG back to the studio window. (The socket leg studio→backend is unit-covered in Tasks 4–5; the orchestrator that drives this in a loop is Plan 4, whose Playwright spec exercises the full backend round-trip.)

**Files:**

- Create: `studio/frontend/e2e/scene-capture.spec.ts`

**Interfaces:**

- Consumes: the e2e harness from `e2e/game-scene.spec.ts` (`seedLocalStorage` from `./helpers`; the `menu-view` → `view-open-game/preview` flow; `data-testid="game-engine-frame"`; dev hooks `window.__gameActiveId`, `window.__gameApplyInbound`, and the new `window.__gameRequestCapture` from Task 5). The Playwright config derives `baseURL` and engine origin from `BLOOM_PORT_OFFSET` — the spec stays port-agnostic.
- Produces: a local-only browser test proving the render-settled `captured` PNG reply.

- [ ] **Step 1: Write the e2e spec**

Create `studio/frontend/e2e/scene-capture.spec.ts`:

```typescript
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack:
//   engine (runtime client), backend (replay), studio — all at this worktree's
//   BLOOM_PORT_OFFSET. Proves the render-settled frame-capture round-trip: a
//   capture request reaches the runtime-client iframe, the engine waits for the
//   frame to paint, extracts the canvas to a PNG, and posts a `captured` reply
//   to the studio window. The socket leg studio->backend is unit-covered; the
//   orchestrator that drives this in a loop is Plan 4.

async function openAppAtRoom(page: Page, username: string): Promise<void> {
  // Install the message recorder BEFORE navigation so the init-script runs first.
  await page.addInitScript(() => {
    (window as any).__captureMsgs = [];
    (window as any).__readyMsgs = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.kind === 'ready') (window as any).__readyMsgs.push(true);
      if (d && d.kind === 'captured') (window as any).__captureMsgs.push({ origin: e.origin, id: d.id, png: d.png });
    });
  });

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Capture E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

test('captures a render-settled PNG of the engine frame and posts it to the studio', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  // Open the Game Scene pane and wait for the engine handshake.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__readyMsgs.length), { timeout: 20000 }).toBeGreaterThan(0);

  const gameId = await page.evaluate(() => (window as any).__gameActiveId ?? null);
  expect(gameId).toBeTruthy();

  // Place a root + sprite so the frame has visible content to extract.
  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    apply('scene_op', {
      gameId: gid,
      op: { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } },
    });
  }, gameId);

  // Trigger a capture through the real bridge (dev hook -> bridge.capture -> iframe).
  await page.evaluate(() => (window as any).__gameRequestCapture?.('cap-e2e-1'));

  // The engine replies with a `captured` PNG on the studio window.
  await expect.poll(() => page.evaluate(() => (window as any).__captureMsgs.length), { timeout: 20000 }).toBeGreaterThan(0);

  const msg = await page.evaluate(() => (window as any).__captureMsgs[0]);
  expect(msg.id).toBe('cap-e2e-1');
  expect(typeof msg.png).toBe('string');
  expect(msg.png.startsWith('data:image/png;base64,')).toBe(true);
  // A real extracted frame is non-trivial in size (proves it's not a blank stub).
  expect(msg.png.length).toBeGreaterThan(1000);
});
```

- [ ] **Step 2: Bring up the stack at this worktree's ports**

From the worktree root, in separate terminals (ports derive from `BLOOM_PORT_OFFSET=1`):

```bash
just backend-serve-replay     # backend on :8001 (replay)
npx nx serve client           # runtime engine on :4301
npx nx serve frontend         # studio on :4201
```

Confirm the backend is in replay mode (the spec drives ops without an LLM):

Run: `just preflight` is for **live** sessions and will fail in replay — instead just hit health: `curl -s http://localhost:8001/health` and confirm `"mode":"replay"`.

- [ ] **Step 3: Run the new e2e spec**

Run: `just e2e` (runs the Playwright suite against the replay backend at the worktree ports), or target just this file:
`cd studio/frontend && BLOOM_PORT_OFFSET=1 npx playwright test e2e/scene-capture.spec.ts`
Expected: PASS — a `captured` message with a `data:image/png;base64,…` PNG longer than 1000 chars arrives on the studio window.

> If it times out at the `__captureMsgs` poll: the most likely cause is the render-settled barrier never resolving (engine not painting) or the dev hook missing — confirm `window.__gameRequestCapture` exists in the studio page console and that `__readyMsgs` is non-empty (engine handshaked). This is the single highest-risk integration point (spec §2); debug with `superpowers:systematic-debugging`.

- [ ] **Step 4: Commit**

```bash
node_modules/.bin/prettier --write studio/frontend/e2e/scene-capture.spec.ts
git add studio/frontend/e2e/scene-capture.spec.ts
git commit -m "test(e2e): render-settled frame-capture round-trip"
```

---

## Self-Review

- **Spec coverage (this plan's slice — spec §2 "Real-frame capture"):**
  - _Extend the postMessage protocol with a capture request + a captured reply carrying a PNG_ → `capture`/`captured` added to **both** message decls (runtime `messages.ts` Task 1, studio `protocolBridge.ts` Task 3). ✓
  - _Render-settled barrier (the load-bearing detail): capture must wait for the just-applied op to be **drawn**, or the critic grades a stale frame_ → `PixiRenderer.capture()` awaits one `requestAnimationFrame` before `extract.base64` (Task 2), asserted by the rAF-spy test; the protocol replies `captured` (not `ack`) so the caller knows the frame is settled. ✓
  - _Client extracts the canvas to PNG (`renderer.extract`)_ → `extract.base64(app.stage)` → `data:image/png;base64,…` (Task 2). ✓
  - _Client posts the PNG back to the backend; relay studio→backend over the socket_ → iframe `captured` → bridge `onCaptured` → `emitSceneCaptureResult` → `scene_capture_result` socket event → `SceneCaptureBroker.resolve_capture` (Tasks 3–5). ✓
  - _Orchestrator forwards it to the critic_ → out of scope (Plan 4); the awaitable `SceneCaptureBroker.request_capture` seam + `app.state.capture_broker` are delivered here for Plan 4 to drive. ✓
  - _Cost/latency acceptable at author time; PNG over an already-open channel_ → reuses the existing Socket.IO room + postMessage channel; no new transport. ✓
- **Spec §2 "extends the #115 per-change commit ack":** the existing `ack` (fired after `reconciler.applyChanges()`, before paint) is unchanged; capture is the new render-settled step layered beside it, exactly as the spec describes ("the existing ack fires … before the Pixi frame paints, so capture needs a rAF/ticker wait"). ✓
- **Testing tiers (per `AGENTS.md`):**
  - Render-settled barrier + extract → runtime-client Vitest (Task 2). ✓
  - Protocol capture branch → Vitest (Task 1). ✓
  - Studio bridge + socket relay → Vitest (Tasks 3, 5). ✓
  - Backend broker correlation / timeout / decode + socket handler → pytest (Task 4). ✓
  - Full real-browser capture round-trip (the net-new, highest-risk behavior) → Playwright, local-only (Task 6). ✓
  - The socket→backend leg in a real browser is exercised end-to-end by Plan 4's compose-loop Playwright spec (it needs the orchestrator to call `request_capture`); here it's covered by the Vitest+pytest composition, which is the correct tier split. Noted in Task 6's preamble — not a silent gap. ✓
- **Placeholder scan:** no TBDs; every code step shows complete code, every run step an exact command + expected result. ✓
- **Type consistency:** `capture`/`captured` shapes are byte-identical across `messages.ts` and `protocolBridge.ts`; `capture(id: string)` / `onCaptured({id, png})` names match between bridge (Task 3) and pane/socket wiring (Task 5); `IRenderer.capture` (Task 1) is implemented by both `MockRenderer` (Task 1) and `PixiRenderer` (Task 2); the socket event names `scene_capture_request` / `scene_capture_result` and the payload keys `gameId` / `captureId` / `png` are identical in the broker (Task 4), the socket handler (Task 4), and the frontend relay (Task 5); `captureId` issued by the broker is the same `id` echoed by `captured` and emitted back, closing the correlation loop. ✓
- **Reuse check:** capture rides the existing postMessage channel (`ProtocolHost`/`ProtocolBridge`), the existing Socket.IO room model (`hub`/`sio.emit(room=…)`), the existing dev-hook pattern (`__game*`, `import.meta.env.PROD`), and the existing e2e harness (`game-scene.spec.ts`). No new transport, no forked message-dispatch, no direct `contentWindow` access in tests. ✓

```

```
