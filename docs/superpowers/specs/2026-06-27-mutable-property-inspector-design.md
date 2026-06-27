# Mutable Property Inspector — Design

**Date:** 2026-06-27
**Status:** Approved (brainstorming → spec)
**Branch:** `feat/mutable-inspector`

## Goal

Turn the read-only Property Inspector into a live editor. Selecting a node and
editing any scalar leaf with a type-aware widget pushes the change — debounced —
through the **same authoritative `apply_op` path the agent already uses**. The op
persists to Mongo and echoes to every connected client, including the live game
iframe, so a human dragging a number watches the game move in real time.

The human becomes a first-class editor alongside the agent, sharing one op
pipeline rather than a parallel write path.

## Background — current architecture

- **Backend is authoritative.** `GameSceneHub.apply_op` (`studio/backend/app/scene/hub.py`)
  is the single mutation point: it applies an op to `GameSceneStore` (persists to
  Mongo, under a per-game `asyncio.Lock`), then broadcasts a `scene_op` event to the
  game room. The agent mutates props through this exact path via `scene_set_prop`
  (`studio/backend/app/agent_tools.py:509`), which constructs
  `{"kind": "setProp", "id", "path", "value"}` and calls `apply_op`. `apply_op`
  raises a typed `OpError` (with a `code`) on validation failure.
- **The frontend is a pure read-only mirror.** `studio/frontend/src/plugins/game/socketClient.ts`
  only *listens* for `scene_op` / `scene_snapshot` and forwards them to the iframe
  bridge and the shared scene store. The only client→server emits today are
  `join_scene` / `leave_scene` (`studio/backend/app/scene/sockets.py`). **There is no
  client→backend channel for scene ops.**
- **The Inspector** (`studio/frontend/src/plugins/property-inspector/`) walks
  `node.props` generically as arbitrary JSON (`inspect.ts`) and renders read-only
  rows keyed by a stable dotted `path` (e.g. `tint.r`, `position.x`). That `path` is
  exactly the shape `setProp` consumes. The `setProp` op and its nested-path applier
  already exist in both the TS reducer (`scene/reducers.ts`) and the Python store.

The single new piece of plumbing this work introduces is the **client→backend
direction**: letting the frontend emit a `setProp` op.

## Decisions (from brainstorming)

1. **Edit scope:** edit **existing scalar values only**. No adding/removing keys,
   no restructuring arrays/objects, no node/edge edits. Maps 1:1 to `setProp`.
2. **Edit UX:** **type-aware inputs** — each leaf gets a widget matched to its
   current JS type; the runtime type is preserved on write.
3. **Commit model:** **live per-edit, debounced** — edits fire `setProp`
   continuously (debounced) as the user types/drags, so the game updates live. A
   final reconcile happens on blur.
4. **Transport:** **new socket event** — the client emits over the existing game
   socket; a new handler in `scene/sockets.py` funnels it through the same
   `scene_hub.apply_op` the agent uses.
5. **Editable set:** **all scalar leaves** are editable — the same reach the agent
   already has. A bad edit (e.g. a Texture `src`) is recoverable by re-editing.
6. **Client op restriction:** the client channel accepts **`setProp` only**.
   `addNode` / `removeNode` / `connect` / `disconnect` stay agent/internal-only.
7. **Deferred:** Unity-style drag-to-scrub on the number label is a later slice.

## Data flow

```
Inspector widget (focused → driven by local component state)
  └─ debounced emit('scene_apply_op', { gameId, op:{kind:'setProp', id, path, value} })
       └─ backend scene/sockets.py handler  ── rejects op.kind !== 'setProp' ──┐
            └─ scene_hub.apply_op(gameId, op)   ← SAME entry the agent calls
                 ├─ store.apply_op  (validate + proto-guard + persist, per-game lock)
                 └─ broadcast 'scene_op' to room
                      └─ every client's socketClient.applyInbound('scene_op')
                           ├─ scene store mirror updates  → Inspector rows re-render*
                           └─ iframe bridge.op()          → game moves live
   *the editing widget ignores echoes while focused; reconciles on blur
```

## Components

### Backend — `scene_apply_op` handler

Add to `studio/backend/app/scene/sockets.py` (beside `join_scene` / `leave_scene`):

- Receives `{ gameId, op }`.
- **Guards `op.kind == "setProp"`** — rejects any other kind (this slice only lets
  clients emit setProp). A rejected kind does not call the hub.
- Calls `hub.apply_op(gameId, op)` — reuses the existing lock + persist + broadcast.
  No new store/hub code.
- Catches `OpError` → emits a `scene_op_rejected` ack back to the **sender**
  (`to=sid`) carrying the error `code`, and logs it. Success needs no ack: the
  `scene_op` broadcast is the confirmation.

### Frontend — emit seam (`scene/sceneOps.ts`, new, small)

- `emitSetProp(gameId, id, path, value)` emits `scene_apply_op` over the existing
  game socket. Thin, swappable, unit-testable function. The Inspector depends on
  this seam, not on socket internals. Mirrors the project's "thin swappable seam"
  convention.

### Frontend — `inspect.ts` (minimal extension)

Scalar rows already carry `path` + `display`. Extend `IPropRow` scalar rows with:

- `valueType: 'number' | 'string' | 'boolean' | 'null'`
- `raw: JsonValue` — the unformatted value the widget binds to.

Pure change; branch/array/object rows are unaffected. Easy to TDD.

### Frontend — `EditableValue` widget (in `InspectorPane.tsx`)

- **Type-aware input:** number → numeric field, boolean → toggle, string → text,
  null → text field (parses to keep or replace the null).
- **Owns local state while focused** so an incoming echo never fights the cursor.
  The component reads the store value only when *not* focused/dirty.
- Fires `emitSetProp` **debounced (~80ms)** on change → live updates.
- **On blur:** reconcile local state to the authoritative store value.
- **Esc:** revert to the store value and blur.
- Invalid intermediate states (empty string in a number field, `NaN`) simply do
  **not** emit.

Type preservation: a number widget always emits a `number`, a boolean widget a
`boolean`, etc., so `setProp` never accidentally changes a value's type.

## Correctness & safety

- **Concurrency:** the per-game `asyncio.Lock` in `GameSceneHub` already serializes
  human + agent writes; the room broadcast keeps all inspectors and iframes
  consistent. The ~80ms debounce caps the op rate while dragging/typing.
- **No echo/cursor fight:** the focused widget is the source of truth for its own
  field during an interaction; it reconciles to the store only on blur.
- **Validation:** reuse the store's existing proto-pollution path guard and
  unknown-node `OpError` handling **unchanged**. The client channel is additionally
  restricted to `setProp`.
- **All scalar leaves editable** — same reach the agent has; recoverable by
  re-editing.
- **Multi-client:** two Studio clients editing the same game both see each other's
  edits via the room broadcast; last write wins per prop (consistent with the
  agent's existing behavior).

## Testing

### Unit (TDD)

- `inspect.ts`: scalar rows expose `raw` value + correct `valueType` for each JS
  type; branch rows unchanged.
- Widget pure helpers: parse-by-type, "should emit?" (suppress empty/NaN), Esc
  revert, blur reconcile.
- Emit seam: `emitSetProp` emits `scene_apply_op` with the right payload shape;
  debounce coalesces rapid calls.
- Backend handler: calls `hub.apply_op` for a `setProp`; **rejects** a non-`setProp`
  kind without calling the hub; emits `scene_op_rejected` (to sender) on `OpError`.

### e2e (Playwright — authoritative, the behavioral contract)

- Select a node → edit a number in the Inspector →
  - a `scene_op` (`setProp`) is broadcast,
  - the iframe sprite actually moved (observable engine state),
  - the value **persists** across a reload / scene snapshot.
- Edit a boolean (toggle) and a string; assert type is preserved on the wire.
- A rejected edit (e.g. an op for a stale/removed node) surfaces no crash and the
  field reconciles back.

Run against the replay backend (`just e2e`) per repo policy; never in CI.

## Out of scope (YAGNI)

Add/remove props, array/object restructuring, node/edge edits, undo/redo,
multi-select, semantic widgets (color picker, sliders), per-type editable schemas,
optimistic local-apply with rollback, and drag-to-scrub number interaction.

## Files touched (anticipated)

- `studio/backend/app/scene/sockets.py` — new `scene_apply_op` handler.
- `studio/backend/tests/` — handler unit test + scene e2e assertion for a
  client-originated setProp.
- `studio/frontend/src/scene/sceneOps.ts` — new emit seam (+ spec).
- `studio/frontend/src/plugins/property-inspector/inspect.ts` — `raw` + `valueType`
  on scalar rows (+ spec update).
- `studio/frontend/src/plugins/property-inspector/InspectorPane.tsx` — `EditableValue`
  widget (+ spec update).
- `studio/frontend/e2e/` — new mutable-inspector e2e spec.
