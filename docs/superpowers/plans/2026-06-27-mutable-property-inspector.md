# Mutable Property Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human edit any scalar leaf in the Property Inspector and have the change flow — debounced, live — through the same authoritative `apply_op` path the agent uses, persisting and echoing to every client including the live game iframe.

**Architecture:** Add a client→backend write channel (a `scene_apply_op` socket event restricted to `setProp`) that funnels into the existing `GameSceneHub.apply_op`. On the frontend, scalar Inspector rows become type-aware editable widgets that debounce-emit `setProp` ops and reconcile from the backend echo (ignoring echoes while the field is focused).

**Tech Stack:** Python + python-socketio (backend), React + hookstate + Vite + Vitest (frontend), Playwright (browser e2e), pytest (backend e2e). Replay-backend dev loop.

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`IPropRow`, `IParseResult`). Copied from `docs/coding-standards.md`.
- **Conventional Commits** for every commit (`feat:`, `test:`, `docs:` …).
- **TDD mandatory:** write the failing test, watch it fail, minimal code to pass, refactor.
- **No raw colors** outside `styles.css` in `studio/frontend` — use the design-language token classes (`text-foreground`, `bg-elevated`, `text-faint`, etc.). A guard test blocks raw colors.
- **Browser e2e (Playwright) is NEVER in CI** — run locally via `just e2e` against a replay backend on `:8000`. Non-browser backend e2e (pytest) is CI-affordable.
- **Worktree ports:** this work is in worktree `mutable-inspector` with `BLOOM_PORT_OFFSET=1` → backend `:8001`, studio `:4201`, runtime `:4301`. Always use the offset ports here; never the defaults.
- **Client op restriction:** the client `scene_apply_op` channel accepts **`setProp` only**. Other kinds are rejected without touching the hub.

---

## File Structure

**Backend**
- Modify `studio/backend/app/scene/sockets.py` — add the `scene_apply_op` handler (Task 1).
- Create `studio/backend/tests/test_scene_apply_op_handler.py` — handler unit test (Task 1).
- Create `studio/backend/tests/e2e/test_scene_mutate.py` — full socket round-trip (Task 2).

**Frontend**
- Modify `studio/frontend/src/plugins/game/socketClient.ts` — add `emitSceneApplyOp` (Task 3).
- Create `studio/frontend/src/plugins/property-inspector/commit.ts` — the impure write seam (Task 3).
- Create `studio/frontend/src/plugins/property-inspector/commit.spec.ts` (Task 3).
- Create `studio/frontend/src/plugins/property-inspector/edit.ts` — pure edit helpers (Task 4).
- Create `studio/frontend/src/plugins/property-inspector/edit.spec.ts` (Task 4).
- Modify `studio/frontend/src/plugins/property-inspector/inspect.ts` — `raw` + `valueType` on scalar rows (Task 5).
- Create `studio/frontend/src/plugins/property-inspector/inspect.spec.ts` (Task 5).
- Create `studio/frontend/src/plugins/property-inspector/EditableValue.tsx` — the widget (Task 6).
- Create `studio/frontend/src/plugins/property-inspector/EditableValue.spec.tsx` (Task 6).
- Modify `studio/frontend/src/plugins/property-inspector/InspectorPane.tsx` — render `EditableValue` for scalar rows (Task 7).
- Modify `studio/frontend/src/plugins/property-inspector/InspectorPane.spec.tsx` — update for editable rows (Task 7).
- Create `studio/frontend/e2e/mutable-inspector.spec.ts` — UI + emit-contract e2e (Task 8).

---

## Task 1: Backend `scene_apply_op` handler

**Files:**
- Modify: `studio/backend/app/scene/sockets.py`
- Test: `studio/backend/tests/test_scene_apply_op_handler.py`

**Interfaces:**
- Consumes: `GameSceneHub.apply_op(game_id, op) -> dict` (raises `OpError(code, message)` from `app.scene.document`).
- Produces: a `scene_apply_op` socket handler. On a `setProp` op → calls `hub.apply_op` (which broadcasts `scene_op` to the room). On a non-`setProp` kind → emits `scene_op_rejected` `{gameId, code: "forbidden_kind", op}` to the sender only, without calling the hub. On `OpError` → emits `scene_op_rejected` `{gameId, code: e.code, op}` to the sender only.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_scene_apply_op_handler.py`:

```python
import pytest
import pytest_asyncio
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore
from app.scene.sockets import register_scene_handlers


@pytest_asyncio.fixture(autouse=True)
async def _clean_scenes(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    yield
    await mongo_db["game_scenes"].delete_many({})


class FakeSio:
    """Captures @sio.on handlers so they can be invoked directly, and records emits."""

    def __init__(self):
        self.handlers = {}
        self.emitted = []

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn
        return deco

    async def emit(self, event, data, room=None, to=None):
        self.emitted.append((event, data, room, to))

    async def enter_room(self, sid, room):
        pass

    async def leave_room(self, sid, room):
        pass


async def _seed_sprite(hub):
    await hub.apply_op("g1", {"kind": "addNode", "id": "s", "type": "Sprite"})


@pytest.mark.asyncio
async def test_setprop_calls_hub_and_broadcasts(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    register_scene_handlers(sio, hub)
    await _seed_sprite(hub)
    sio.emitted.clear()

    await sio.handlers["scene_apply_op"](
        "sid-1", {"gameId": "g1", "op": {"kind": "setProp", "id": "s", "path": "x", "value": 5}}
    )

    ops = [e for e in sio.emitted if e[0] == "scene_op"]
    assert ops, "expected a scene_op broadcast"
    assert ops[-1][1]["op"] == {"kind": "setProp", "id": "s", "path": "x", "value": 5}
    assert ops[-1][2] == "g1"  # room broadcast
    doc = await hub._store.get_document("g1")
    assert doc["nodes"]["s"]["props"]["x"] == 5


@pytest.mark.asyncio
async def test_non_setprop_kind_is_rejected_without_touching_hub(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    register_scene_handlers(sio, hub)
    sio.emitted.clear()

    await sio.handlers["scene_apply_op"](
        "sid-1", {"gameId": "g1", "op": {"kind": "addNode", "id": "x", "type": "Sprite"}}
    )

    assert not [e for e in sio.emitted if e[0] == "scene_op"], "hub must not be called"
    rej = [e for e in sio.emitted if e[0] == "scene_op_rejected"]
    assert rej, "expected a rejection"
    assert rej[-1][1]["code"] == "forbidden_kind"
    assert rej[-1][3] == "sid-1"  # to=sid only


@pytest.mark.asyncio
async def test_operror_is_reported_as_rejection_to_sender(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    register_scene_handlers(sio, hub)
    sio.emitted.clear()

    # setProp on a node that does not exist -> OpError("unknown_node")
    await sio.handlers["scene_apply_op"](
        "sid-1", {"gameId": "g1", "op": {"kind": "setProp", "id": "ghost", "path": "x", "value": 1}}
    )

    rej = [e for e in sio.emitted if e[0] == "scene_op_rejected"]
    assert rej, "expected a rejection"
    assert rej[-1][1]["code"] == "unknown_node"
    assert rej[-1][3] == "sid-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_scene_apply_op_handler.py -v`
Expected: FAIL — `KeyError: 'scene_apply_op'` (handler not registered yet).

- [ ] **Step 3: Add the handler**

In `studio/backend/app/scene/sockets.py`, add the import at the top and the new handler inside `register_scene_handlers`:

```python
from app.scene.document import OpError


def register_scene_handlers(sio, hub):
    @sio.on("join_scene")
    async def join_scene(sid, data):
        await hub.attach(data["gameId"], sid)

    @sio.on("leave_scene")
    async def leave_scene(sid, data):
        await sio.leave_room(sid, data["gameId"])

    @sio.on("scene_apply_op")
    async def scene_apply_op(sid, data):
        game_id = data.get("gameId")
        op = data.get("op") or {}
        # This slice only accepts setProp from clients; structural ops
        # (addNode/removeNode/connect/disconnect) stay agent/internal-only.
        if op.get("kind") != "setProp":
            await sio.emit(
                "scene_op_rejected",
                {"gameId": game_id, "code": "forbidden_kind", "op": op},
                to=sid,
            )
            return
        try:
            await hub.apply_op(game_id, op)
        except OpError as e:
            await sio.emit(
                "scene_op_rejected",
                {"gameId": game_id, "code": e.code, "op": op},
                to=sid,
            )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_scene_apply_op_handler.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/sockets.py studio/backend/tests/test_scene_apply_op_handler.py
git commit -m "feat(scene): accept client setProp via scene_apply_op socket event"
```

---

## Task 2: Backend e2e — full socket round-trip

**Files:**
- Test: `studio/backend/tests/e2e/test_scene_mutate.py`

**Interfaces:**
- Consumes: the live replay server (`live_server` fixture), the `design-scene` skill (seeds a real persisted scene deterministically in replay), and the `scene_apply_op` handler from Task 1.
- Produces: proof that a client-emitted `setProp` is broadcast back as `scene_op` and persisted.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/e2e/test_scene_mutate.py`:

```python
"""Backend service e2e: a client-emitted scene_apply_op (setProp) is applied,
broadcast back as scene_op, and persisted. Replay backend, no browser."""
import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "MutateE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_client_setprop_is_applied_and_persisted(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    seen = {"ops": [], "snapshots": []}
    client.on("scene_op", lambda d: seen["ops"].append(d))
    client.on("scene_snapshot", lambda d: seen["snapshots"].append(d))

    await client.connect(live_server, auth={"displayName": "Mutator"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.2)

    # Seed a real persisted scene via the deterministic replay agent.
    await client.emit("run_skill", {
        "roomId": room_id, "skillName": "design-scene", "args": {},
        "text": "Build a basic slot scene.",
    })

    deadline = asyncio.get_running_loop().time() + 15
    def _sprite_id():
        for o in seen["ops"]:
            op = o["op"]
            if op["kind"] == "addNode" and op["type"] == "Sprite":
                return op["id"]
        return None
    while _sprite_id() is None and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    sprite_id = _sprite_id()
    assert sprite_id, f"expected a Sprite node; saw {[o['op'] for o in seen['ops']]}"

    # Emit a client setProp on the new sprite.
    seen["ops"].clear()
    await client.emit("scene_apply_op", {
        "gameId": game_id,
        "op": {"kind": "setProp", "id": sprite_id, "path": "position.x", "value": 42},
    })

    # 1. The op is broadcast back to the room as scene_op.
    deadline = asyncio.get_running_loop().time() + 10
    def _saw_setprop():
        return any(o["op"]["kind"] == "setProp" and o["op"]["id"] == sprite_id for o in seen["ops"])
    while not _saw_setprop() and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert _saw_setprop(), f"expected setProp broadcast; saw {[o['op'] for o in seen['ops']]}"

    # 2. The value is persisted: re-join for a fresh snapshot.
    seen["snapshots"].clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not seen["snapshots"] and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    doc = seen["snapshots"][-1]["document"]
    assert doc["nodes"][sprite_id]["props"]["position"]["x"] == 42, doc

    await client.disconnect()
```

- [ ] **Step 2: Run test to verify it passes (handler already exists from Task 1)**

The backend e2e needs a live replay server. Start it (worktree port 8001) in a separate terminal:

Run (terminal A): `just backend-serve-replay`
Run (terminal B): `cd studio/backend && uv run pytest tests/e2e/test_scene_mutate.py -v -m e2e`
Expected: PASS. (If the handler from Task 1 were missing, the setProp broadcast assertion would time out and FAIL — this test is the round-trip guard.)

- [ ] **Step 3: Commit**

```bash
git add studio/backend/tests/e2e/test_scene_mutate.py
git commit -m "test(scene): e2e round-trip for client-emitted setProp"
```

---

## Task 3: Client write seam (`emitSceneApplyOp` + `commit.ts`)

**Files:**
- Modify: `studio/frontend/src/plugins/game/socketClient.ts`
- Create: `studio/frontend/src/plugins/property-inspector/commit.ts`
- Test: `studio/frontend/src/plugins/property-inspector/commit.spec.ts`

**Interfaces:**
- Consumes: `gameSlice().activeGameId` (from `../game/state`), `ISceneOp` (from `../../scene/reducers`), `JsonValue` (from `../../scene/types`).
- Produces:
  - `emitSceneApplyOp(gameId: string, op: ISceneOp): void` (exported from `socketClient.ts`) — emits `scene_apply_op` `{gameId, op}` on the game socket; in dev also stores `window.__gameLastApplyOp = {gameId, op}` for e2e capture.
  - `commitSetProp(nodeId: string, path: string, value: JsonValue): void` (exported from `commit.ts`) — reads the active game id and, when set, calls `emitSceneApplyOp` with a `setProp` op; no-op when there is no active game.

- [ ] **Step 1: Add the transport to `socketClient.ts`**

Append to `studio/frontend/src/plugins/game/socketClient.ts` (after `createGameSocket`, alongside the other exports — `sock` is the module-level socket already declared at the top):

```typescript
export function emitSceneApplyOp(gameId: string, op: ISceneOp): void {
  sock?.emit('scene_apply_op', { gameId, op });
  if (!import.meta.env.PROD) {
    (window as unknown as { __gameLastApplyOp?: unknown }).__gameLastApplyOp = { gameId, op };
  }
}
```

(`ISceneOp` is already imported in this file.)

- [ ] **Step 2: Write the failing test for the seam**

Create `studio/frontend/src/plugins/property-inspector/commit.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState as makeGameState } from '../game/state';
import * as socketClient from '../game/socketClient';
import { commitSetProp } from './commit';

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeGameState() as never);
  vi.restoreAllMocks();
});

describe('commitSetProp', () => {
  it('emits a setProp scene_apply_op for the active game', () => {
    const spy = vi.spyOn(socketClient, 'emitSceneApplyOp').mockImplementation(() => {});
    gameSlice().activeGameId.set('g7');

    commitSetProp('s1', 'position.x', 42);

    expect(spy).toHaveBeenCalledWith('g7', { kind: 'setProp', id: 's1', path: 'position.x', value: 42 });
  });

  it('is a no-op when there is no active game', () => {
    const spy = vi.spyOn(socketClient, 'emitSceneApplyOp').mockImplementation(() => {});
    gameSlice().activeGameId.set(null);

    commitSetProp('s1', 'x', 1);

    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/commit.spec.ts`
Expected: FAIL — `commit.ts` / `commitSetProp` not found.

- [ ] **Step 4: Implement `commit.ts`**

Create `studio/frontend/src/plugins/property-inspector/commit.ts`:

```typescript
import type { JsonValue } from '../../scene/types';
import { gameSlice } from '../game/state';
import { emitSceneApplyOp } from '../game/socketClient';

// Impure write seam: send one setProp for the active game. No-op with no
// active game. Kept tiny + swappable so the widget depends on this, not on
// socket internals.
export function commitSetProp(nodeId: string, path: string, value: JsonValue): void {
  const gameId = gameSlice().activeGameId.get();
  if (!gameId) return;
  emitSceneApplyOp(gameId, { kind: 'setProp', id: nodeId, path, value });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/commit.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/game/socketClient.ts studio/frontend/src/plugins/property-inspector/commit.ts studio/frontend/src/plugins/property-inspector/commit.spec.ts
git commit -m "feat(inspector): client write seam for setProp over the game socket"
```

---

## Task 4: Pure edit helpers (`edit.ts`)

**Files:**
- Create: `studio/frontend/src/plugins/property-inspector/edit.ts`
- Test: `studio/frontend/src/plugins/property-inspector/edit.spec.ts`

**Interfaces:**
- Consumes: `JsonValue` (from `../../scene/types`).
- Produces:
  - `type ScalarType = 'number' | 'string' | 'boolean' | 'null'`
  - `valueTypeOf(v: JsonValue): ScalarType`
  - `toInputText(type: ScalarType, raw: JsonValue): string`
  - `interface IParseResult { ok: boolean; value?: JsonValue }`
  - `parseEditInput(type: ScalarType, text: string): IParseResult` — `ok: false` means "don't emit" (incomplete/invalid intermediate).
  - `makeDebounced<A extends unknown[]>(fn: (...args: A) => void, delayMs: number): (...args: A) => void`

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/property-inspector/edit.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { valueTypeOf, toInputText, parseEditInput, makeDebounced } from './edit';

describe('valueTypeOf', () => {
  it('classifies each scalar', () => {
    expect(valueTypeOf(3)).toBe('number');
    expect(valueTypeOf('hi')).toBe('string');
    expect(valueTypeOf(true)).toBe('boolean');
    expect(valueTypeOf(null)).toBe('null');
  });
});

describe('toInputText', () => {
  it('renders numbers and strings verbatim, null as empty', () => {
    expect(toInputText('number', 120)).toBe('120');
    expect(toInputText('string', 'hero')).toBe('hero');
    expect(toInputText('null', null)).toBe('');
  });
});

describe('parseEditInput', () => {
  it('parses numbers, suppressing empty/NaN', () => {
    expect(parseEditInput('number', '12')).toEqual({ ok: true, value: 12 });
    expect(parseEditInput('number', '1.5')).toEqual({ ok: true, value: 1.5 });
    expect(parseEditInput('number', '')).toEqual({ ok: false });
    expect(parseEditInput('number', 'abc')).toEqual({ ok: false });
  });
  it('parses booleans from toggle text', () => {
    expect(parseEditInput('boolean', 'true')).toEqual({ ok: true, value: true });
    expect(parseEditInput('boolean', 'false')).toEqual({ ok: true, value: false });
  });
  it('passes strings through', () => {
    expect(parseEditInput('string', 'hero')).toEqual({ ok: true, value: 'hero' });
    expect(parseEditInput('string', '')).toEqual({ ok: true, value: '' });
  });
  it('keeps null empty, otherwise becomes a string', () => {
    expect(parseEditInput('null', '')).toEqual({ ok: true, value: null });
    expect(parseEditInput('null', 'x')).toEqual({ ok: true, value: 'x' });
  });
});

describe('makeDebounced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid calls into one, last args win', () => {
    const fn = vi.fn();
    const d = makeDebounced(fn, 80);
    d(1);
    d(2);
    d(3);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/edit.spec.ts`
Expected: FAIL — `edit.ts` not found.

- [ ] **Step 3: Implement `edit.ts`**

Create `studio/frontend/src/plugins/property-inspector/edit.ts`:

```typescript
import type { JsonValue } from '../../scene/types';

export type ScalarType = 'number' | 'string' | 'boolean' | 'null';

export function valueTypeOf(v: JsonValue): ScalarType {
  if (v === null) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'string';
}

// The text a widget shows for a raw scalar. null renders as empty (placeholder).
export function toInputText(type: ScalarType, raw: JsonValue): string {
  if (type === 'null') return '';
  return String(raw);
}

export interface IParseResult {
  ok: boolean; // false => don't emit (incomplete/invalid intermediate state)
  value?: JsonValue;
}

// Parse a text input back into a typed JsonValue for a given scalar slot,
// preserving the slot's runtime type so setProp never changes a value's type.
export function parseEditInput(type: ScalarType, text: string): IParseResult {
  switch (type) {
    case 'number': {
      if (text.trim() === '') return { ok: false };
      const n = Number(text);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case 'boolean':
      return { ok: true, value: text === 'true' };
    case 'null':
      return text === '' ? { ok: true, value: null } : { ok: true, value: text };
    case 'string':
    default:
      return { ok: true, value: text };
  }
}

// Trailing-edge debounce; mirrors makeDebouncedSaver in state/persistence.ts.
export function makeDebounced<A extends unknown[]>(fn: (...args: A) => void, delayMs: number): (...args: A) => void {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => fn(...args), delayMs);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/edit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/property-inspector/edit.ts studio/frontend/src/plugins/property-inspector/edit.spec.ts
git commit -m "feat(inspector): pure type-aware edit helpers"
```

---

## Task 5: Carry `raw` + `valueType` on scalar rows (`inspect.ts`)

**Files:**
- Modify: `studio/frontend/src/plugins/property-inspector/inspect.ts`
- Test: `studio/frontend/src/plugins/property-inspector/inspect.spec.ts`

**Interfaces:**
- Consumes: `valueTypeOf`, `ScalarType` (from `./edit`); existing `inspectSelection`.
- Produces: scalar `IPropRow`s additionally carry `valueType: ScalarType` and `raw: JsonValue`. Branch (array/object) rows are unchanged (no `raw`/`valueType`).

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/property-inspector/inspect.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { ISceneDocument } from '../../scene/types';
import { inspectSelection } from './inspect';

const doc: ISceneDocument = {
  version: 1,
  nodes: {
    s1: {
      id: 's1',
      type: 'Sprite',
      props: { name: 'hero', x: 120, visible: true, gap: null, tint: { r: 255 } },
    },
  },
  edges: [],
};

describe('inspectSelection raw + valueType', () => {
  it('tags each scalar row with its raw value and type', () => {
    const view = inspectSelection(doc, 's1')!;
    const byPath = Object.fromEntries(view.rows.map((r) => [r.path, r]));
    expect(byPath['name']).toMatchObject({ kind: 'scalar', valueType: 'string', raw: 'hero' });
    expect(byPath['x']).toMatchObject({ kind: 'scalar', valueType: 'number', raw: 120 });
    expect(byPath['visible']).toMatchObject({ kind: 'scalar', valueType: 'boolean', raw: true });
    expect(byPath['gap']).toMatchObject({ kind: 'scalar', valueType: 'null', raw: null });
    expect(byPath['tint.r']).toMatchObject({ kind: 'scalar', valueType: 'number', raw: 255 });
  });

  it('leaves branch rows without raw/valueType', () => {
    const view = inspectSelection(doc, 's1')!;
    const tint = view.rows.find((r) => r.path === 'tint')!;
    expect(tint.kind).toBe('object');
    expect(tint.raw).toBeUndefined();
    expect(tint.valueType).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/inspect.spec.ts`
Expected: FAIL — `valueType`/`raw` are `undefined` on scalar rows.

- [ ] **Step 3: Implement the change**

In `studio/frontend/src/plugins/property-inspector/inspect.ts`:

(a) Add the import near the top (after the existing `import type` line):

```typescript
import { valueTypeOf, type ScalarType } from './edit';
```

(b) Extend the `IPropRow` interface — add two optional fields:

```typescript
export interface IPropRow {
  path: string; // unique, stable: 'name' | 'tint.r' | 'frames.0' — React key + collapse key
  key: string; // the prop key or array index segment
  depth: number;
  kind: 'scalar' | 'object' | 'array';
  display?: string; // formatted scalar, or '{}' / '[]' for an empty branch
  hasChildren: boolean;
  count?: number; // entry count for a non-empty branch
  valueType?: ScalarType; // scalar rows only — drives the editable widget
  raw?: JsonValue; // scalar rows only — the unformatted value the widget binds to
}
```

(c) In `walk`, update the scalar `rows.push` (the final `return`-less push) to include `valueType` + `raw`:

```typescript
    rows.push({
      path,
      key,
      depth,
      kind: 'scalar',
      display: formatScalar(value),
      hasChildren: false,
      valueType: valueTypeOf(value),
      raw: value,
    });
```

- [ ] **Step 4: Run tests to verify they pass (new + existing)**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/inspect.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/property-inspector/inspect.ts studio/frontend/src/plugins/property-inspector/inspect.spec.ts
git commit -m "feat(inspector): carry raw value and scalar type on prop rows"
```

---

## Task 6: The `EditableValue` widget

**Files:**
- Create: `studio/frontend/src/plugins/property-inspector/EditableValue.tsx`
- Test: `studio/frontend/src/plugins/property-inspector/EditableValue.spec.tsx`

**Interfaces:**
- Consumes: `ScalarType`, `parseEditInput`, `toInputText`, `makeDebounced` (from `./edit`); `commitSetProp` (from `./commit`); `JsonValue` (from `../../scene/types`).
- Produces: `EditableValue({ nodeId, path, valueType, raw }): JSX.Element` rendering `data-testid={`inspector-edit-${path}`}`. Number/string/null → a text input with local state that debounce-commits on change, reconciles to `raw` on blur, reverts on Esc, blurs on Enter, and does not clobber the field from an incoming `raw` change while focused. Boolean → a checkbox that commits immediately on toggle.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/property-inspector/EditableValue.spec.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import * as commit from './commit';
import { EditableValue } from './EditableValue';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(commit, 'commitSetProp').mockImplementation(() => {});
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('EditableValue', () => {
  it('renders the raw number and debounce-commits a parsed edit', () => {
    render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x') as HTMLInputElement;
    expect(input.value).toBe('120');

    fireEvent.change(input, { target: { value: '130' } });
    expect(commit.commitSetProp).not.toHaveBeenCalled(); // debounced
    act(() => vi.advanceTimersByTime(80));
    expect(commit.commitSetProp).toHaveBeenCalledWith('s1', 'x', 130);
  });

  it('does not commit an empty/NaN number', () => {
    render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x');
    fireEvent.change(input, { target: { value: '' } });
    act(() => vi.advanceTimersByTime(80));
    expect(commit.commitSetProp).not.toHaveBeenCalled();
  });

  it('commits a boolean immediately on toggle', () => {
    render(<EditableValue nodeId="s1" path="visible" valueType="boolean" raw={true} />);
    const box = screen.getByTestId('inspector-edit-visible') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(commit.commitSetProp).toHaveBeenCalledWith('s1', 'visible', false);
  });

  it('reverts to raw on Escape', () => {
    render(<EditableValue nodeId="s1" path="name" valueType="string" raw="hero" />);
    const input = screen.getByTestId('inspector-edit-name') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'villain' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('hero');
  });

  it('syncs from a new raw value when not focused', () => {
    const { rerender } = render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    rerender(<EditableValue nodeId="s1" path="x" valueType="number" raw={200} />);
    expect((screen.getByTestId('inspector-edit-x') as HTMLInputElement).value).toBe('200');
  });

  it('does NOT clobber the field from a raw change while focused', () => {
    const { rerender } = render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '155' } });
    rerender(<EditableValue nodeId="s1" path="x" valueType="number" raw={999} />); // echo arrives mid-edit
    expect(input.value).toBe('155');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/EditableValue.spec.tsx`
Expected: FAIL — `EditableValue.tsx` not found.

- [ ] **Step 3: Implement `EditableValue.tsx`**

Create `studio/frontend/src/plugins/property-inspector/EditableValue.tsx`:

```typescript
import { useState, useRef, useEffect, useMemo } from 'react';
import type { JsonValue } from '../../scene/types';
import { type ScalarType, parseEditInput, toInputText, makeDebounced } from './edit';
import { commitSetProp } from './commit';

const DEBOUNCE_MS = 80;

interface IEditableValueProps {
  nodeId: string;
  path: string;
  valueType: ScalarType;
  raw: JsonValue;
}

export function EditableValue({ nodeId, path, valueType, raw }: IEditableValueProps) {
  // Debounced live commit; re-created if the target node/path changes.
  const commit = useMemo(
    () => makeDebounced((v: JsonValue) => commitSetProp(nodeId, path, v), DEBOUNCE_MS),
    [nodeId, path],
  );
  const [text, setText] = useState(() => toInputText(valueType, raw));
  const focused = useRef(false);

  // Reconcile from the authoritative echo — but never while the user is editing
  // this field (that would fight the cursor).
  useEffect(() => {
    if (!focused.current) setText(toInputText(valueType, raw));
  }, [raw, valueType]);

  if (valueType === 'boolean') {
    return (
      <input
        type="checkbox"
        data-testid={`inspector-edit-${path}`}
        checked={raw === true}
        onChange={(e) => commitSetProp(nodeId, path, e.currentTarget.checked)}
      />
    );
  }

  return (
    <input
      data-testid={`inspector-edit-${path}`}
      className="w-full bg-transparent text-foreground outline-none focus:bg-elevated"
      type={valueType === 'number' ? 'number' : 'text'}
      value={text}
      placeholder={valueType === 'null' ? 'null' : undefined}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setText(toInputText(valueType, raw));
      }}
      onChange={(e) => {
        const next = e.currentTarget.value;
        setText(next);
        const parsed = parseEditInput(valueType, next);
        if (parsed.ok) commit(parsed.value as JsonValue);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setText(toInputText(valueType, raw));
          e.currentTarget.blur();
        } else if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/EditableValue.spec.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/property-inspector/EditableValue.tsx studio/frontend/src/plugins/property-inspector/EditableValue.spec.tsx
git commit -m "feat(inspector): type-aware EditableValue widget"
```

---

## Task 7: Wire `EditableValue` into `InspectorPane`

**Files:**
- Modify: `studio/frontend/src/plugins/property-inspector/InspectorPane.tsx`
- Test: `studio/frontend/src/plugins/property-inspector/InspectorPane.spec.tsx`

**Interfaces:**
- Consumes: `EditableValue` (from `./EditableValue`); `view.id` (the selected node id) is threaded down to each `PropRow`.
- Produces: scalar rows render an `EditableValue` instead of a static value span; branch rows (summary) and empty-branch rows (`[]`/`{}`) are unchanged.

- [ ] **Step 1: Update the existing pane test (will fail against the current pane)**

In `studio/frontend/src/plugins/property-inspector/InspectorPane.spec.tsx`, the two scalar assertions in the "shows the selected node type, id, and scalar props" test must change — a scalar value now lives in an input, not the row's text. Replace those two lines:

```typescript
    expect(screen.getByTestId('inspector-prop-name').textContent).toContain('hero');
    expect(screen.getByTestId('inspector-prop-x').textContent).toContain('120');
```

with:

```typescript
    expect((screen.getByTestId('inspector-edit-name') as HTMLInputElement).value).toBe('hero');
    expect((screen.getByTestId('inspector-edit-x') as HTMLInputElement).value).toBe('120');
```

Leave the empty-state test and the nested/collapse test unchanged (the `inspector-prop-tint.r` row container and `inspector-toggle-tint` still exist).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/InspectorPane.spec.tsx`
Expected: FAIL — `inspector-edit-name` not found (pane still renders a static span).

- [ ] **Step 3: Implement the wiring**

In `studio/frontend/src/plugins/property-inspector/InspectorPane.tsx`:

(a) Add the import:

```typescript
import { EditableValue } from './EditableValue';
```

(b) Pass the node id into each row. Change the `.map` in `InspectorPane` to forward `view.id`:

```typescript
        {view.rows.map((row) => (
          <PropRow key={row.path} nodeId={view.id} row={row} collapsed={collapsed[row.path] === true} onToggle={toggle} />
        ))}
```

(c) Extend `IPropRowProps` and the `PropRow` signature with `nodeId`:

```typescript
interface IPropRowProps {
  nodeId: string;
  row: IPropRow;
  collapsed: boolean;
  onToggle: (path: string) => void;
}

const PropRow = memo(function PropRow({ nodeId, row, collapsed, onToggle }: IPropRowProps) {
```

(d) Replace the value-rendering ternary at the end of `PropRow` (currently `{row.hasChildren && row.count ? <span…summary> : <span…display>}`) with a three-way branch that renders the widget for scalars:

```typescript
      {row.hasChildren && row.count ? (
        <span className="text-faint">{summary}</span>
      ) : row.kind === 'scalar' ? (
        <EditableValue nodeId={nodeId} path={row.path} valueType={row.valueType!} raw={row.raw!} />
      ) : (
        <span className="truncate">{row.display}</span>
      )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/`
Expected: PASS (all property-inspector specs).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/property-inspector/InspectorPane.tsx studio/frontend/src/plugins/property-inspector/InspectorPane.spec.tsx
git commit -m "feat(inspector): render editable widgets for scalar props"
```

---

## Task 8: Frontend Playwright e2e — edit a prop, observe the emitted op

**Files:**
- Create: `studio/frontend/e2e/mutable-inspector.spec.ts`

**Interfaces:**
- Consumes: dev hooks `window.__gameApplyInbound` (seed a local node), `window.__gameActiveId` (the active game id), `window.__gameLastApplyOp` (capture the emitted `scene_apply_op`); the View menu (`view-open-*`), scene-graph rows (`scene-row-<id>`), and inspector edit inputs (`inspector-edit-<path>`).
- Produces: proof the UI emits the right `scene_apply_op` `setProp` and the widget reverts on Esc. (The backend round-trip/persistence is proven by Task 2.)

- [ ] **Step 1: Write the e2e spec**

Create `studio/frontend/e2e/mutable-inspector.spec.ts`:

```typescript
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack on the
// worktree offset: engine :4301, backend :8001 (replay), studio :4201.
//
// Proves the Inspector's UI→wire contract: editing a scalar emits the right
// scene_apply_op (captured via window.__gameLastApplyOp). The backend
// round-trip + persistence is covered by the pytest e2e (test_scene_mutate.py).

async function openRoom(page: Page): Promise<void> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Inspector E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

test('editing a scalar in the Inspector emits a setProp scene_apply_op', async ({ page }) => {
  await openRoom(page);

  // Open the Game Scene pane so activeGameId is set and the socket joins.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string | null);
  expect(gameId).toBeTruthy();

  // Seed a local node into the mirror (scene-graph reads the same store).
  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's1', type: 'Sprite', props: { x: 120, visible: true } } });
  }, gameId);

  // Open Scene Graph + Inspector panes.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-scene-graph/tree').click();
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-property-inspector/panel').click();

  // Select the sprite; the Inspector shows its props.
  await page.getByTestId('scene-row-s1').click();
  const xInput = page.getByTestId('inspector-edit-x');
  await expect(xInput).toHaveValue('120');

  // Edit the number; assert the emitted op (debounced ~80ms).
  await xInput.fill('175');
  await expect
    .poll(() => page.evaluate(() => (window as any).__gameLastApplyOp ?? null), { timeout: 5000 })
    .toMatchObject({ gameId, op: { kind: 'setProp', id: 's1', path: 'x', value: 175 } });

  // Esc reverts the field to the store value.
  await xInput.focus();
  await xInput.fill('999');
  await xInput.press('Escape');
  await expect(xInput).toHaveValue('120');
});
```

- [ ] **Step 2: Run the e2e (replay stack on worktree ports)**

Start the stack (separate terminals, from the worktree, with `BLOOM_PORT_OFFSET=1` already in `.env`):

Run (terminal A): `just backend-serve-replay`
Run (terminal B): `just e2e -- mutable-inspector` (or `npx playwright test mutable-inspector` after `just e2e` setup)
Expected: PASS — the assertion on `__gameLastApplyOp` confirms the UI emitted the exact `setProp` op, and the Esc assertion confirms revert.

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/e2e/mutable-inspector.spec.ts
git commit -m "test(inspector): e2e for editing a scalar prop in the Inspector"
```

---

## Final verification (before opening the PR)

- [ ] **Frontend gates (all four — vitest green ≠ types valid):**

```bash
cd studio/frontend
node_modules/.bin/prettier --check .
npx nx typecheck frontend
npx vitest run
npx nx build frontend
```

Expected: all pass. (Use the pinned `node_modules/.bin/prettier`, not `npx prettier`.)

- [ ] **Backend tests:**

```bash
cd studio/backend && uv run pytest tests/test_scene_apply_op_handler.py -v
```

Expected: pass. (The e2e `tests/e2e/test_scene_mutate.py` requires a live replay server; run it with the stack up.)

- [ ] **Browser e2e** (`just e2e`, replay backend up) green for at least `mutable-inspector.spec.ts` and the existing `game-scene.spec.ts` (regression).

- [ ] Open the PR: `git push -u origin feat/mutable-inspector && gh pr create`.

---

## Self-review notes (coverage vs spec)

- **setProp-only client channel** → Task 1 (handler rejects other kinds) + Task 2 (e2e) + Task 3 (`commitSetProp` only ever sends `setProp`).
- **Same authoritative path as the agent** → Task 1 calls `hub.apply_op` (the agent's entry); no new store/hub code.
- **Type-aware widgets, type preserved** → Task 4 (`parseEditInput` per type) + Task 6 (number/boolean/string/null branches).
- **Live debounced commit** → Task 4 (`makeDebounced`) + Task 6 (debounced `commit`, immediate boolean).
- **Don't clobber focused field; reconcile on blur; Esc revert** → Task 6 (`focused` ref + `useEffect` guard + blur/Esc handlers), unit-tested.
- **All scalar leaves editable** → Task 5 tags every scalar; Task 7 renders a widget for every scalar row.
- **Persistence + broadcast** → Task 2 (backend e2e).
- **UI→wire contract** → Task 8 (frontend e2e via `__gameLastApplyOp`).
- **Out of scope** (add/remove props, structural edits, undo/redo, drag-to-scrub) → not implemented; client channel structurally restricted to `setProp`.
