# Shared scene-store seam — design

**Date:** 2026-06-25
**Status:** Approved (brainstorm), pending implementation plan
**Branch / worktree:** `refactor/scene-store-seam` @ `C:/code/bloom.wt/scene-store-seam`
**Issue:** #86 (scene-graph follow-up 1 of 4)

## Summary

Extract the live scene **document mirror** out of the `game` plugin into a new,
plugin-neutral shared module `studio/frontend/src/scene/`. Both the `game`
plugin and the `scene-graph` plugin then consume that shared module instead of
the `scene-graph` plugin reaching into `game` internals. This is a **pure
refactor**: no observable behavior change, no new UI, no backend/socket/protocol
changes.

The `scene-graph` viewer (PR #92) was shipped with a deliberate read-only import
of the `game` plugin's `gameSlice()` / wire types from `../game/state`, deferred
precisely because the concurrent `design-scene-wiring` client session was editing
adjacent code. That session is done; this is the deferred cleanup (#86), and the
foundation the next read-only follow-ups (#87 Assets/Data section, #88
property-inspector plugin) build on.

## Goal

A clean, acyclic dependency graph with the scene document domain as a **leaf**
that depends on nothing, consumed by both plugins:

```
        studio/frontend/src/scene/      ← depends on NOTHING (domain leaf)
        (types · reducers · store)
              ▲                ▲
              │                │
   plugins/game/        plugins/scene-graph/
   (socket · bridge ·   (viewer; #87/#88 will
    preview · session)   consume the same seam)
```

Today `scene-graph → game` is a plugin-to-plugin import in the wrong direction.
After this change neither plugin imports the other; both depend only on `scene/`,
and `scene/` depends on nothing but shared state infrastructure
(`rootStore` / `makePluginHooks`).

## Context — current coupling

The `game` plugin (`studio/frontend/src/plugins/game/`) currently owns the scene
document mirror as part of its state slice:

- **Wire types** live in `game/state.ts`: `IGameDocument`, `INode`, `IEdge`,
  `IPortRef`, `NodeType`, `EdgeType`, `JsonValue`. These are a structural copy of
  the engine wire shapes (`runtime/client/src/model/document.ts`); the protocol
  fixes them.
- **The live mirror** is the `document: IGameDocument` field of `IGameState`,
  alongside session state (`connection`, `activeGameId`, `status`).
- **The writer** is `game/socketClient.ts` — `applyInbound` handles
  `scene_snapshot` / `scene_op` from the backend `GameSceneHub`, runs the pure
  reducers, and sets `gameSlice().document`. It also forwards to the Pixi iframe
  via `protocolBridge`.
- **The pure reducers** (`game/reducers.ts`) — `applyOpToDocument`,
  `loadDocument`, plus `ISceneOp` — operate on the document; `emptyDocument()`
  (in `state.ts`) seeds it.
- **Consumers of the mirror:** `GamePreviewPane` (reads + bridges to Pixi),
  `game/actions.ts` (`openGame`/`closeGame` reset it), and `SceneGraphPane`
  (reads it via `gameHooks.usePluginState()`).

All scene mutations still originate from agent tools; the scene socket only does
`join_scene`/`leave_scene`. There is no UI→backend mutation path — that is #89
and is **out of scope** here.

## Approaches considered

- **A — Shared document store: types + slice + pure reducers (chosen).** A new
  `scene/` module owns the wire types, the live `document` slice, and the pure
  reducers. The `game` plugin keeps the socket client, protocol bridge, and its
  session state (`connection`/`activeGameId`/`status`) and **writes into the
  shared slice**. Both plugins consume `scene/`; neither imports the other. This
  is the literal "extract the document mirror," yields a clean leaf dependency,
  and keeps blast radius proportionate.
- **B — Types-only seam.** Move only the wire types to a shared module; the live
  document stays physically in the `game` slice behind a neutral accessor.
  Smallest diff, but the mirror is _not_ actually extracted out of `game` — only
  the type dependency is broken. Does not satisfy #86's intent. Rejected.
- **C — Full scene subsystem.** Also move the socket client and protocol bridge
  into `scene/`. Most thorough, but socket + bridge are game-preview-specific
  (backend room sync and Pixi-iframe push), so this muddies responsibility,
  bloats the diff, churns many `game` tests, and overlaps #89's mutation-path
  work. Rejected for now; the chosen design leaves a clean future home for an
  outbound op channel without doing that work prematurely.

## Architecture

### New module — `studio/frontend/src/scene/`

A plugin-neutral domain module (not a plugin: no panes, no commands), a sibling
of `plugins/` under `src/`.

| File                                     | Contents                                                                                                                       | Source                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `types.ts`                               | Wire types: `ISceneDocument` (renamed from `IGameDocument`), `INode`, `IEdge`, `IPortRef`, `NodeType`, `EdgeType`, `JsonValue` | from `game/state.ts`                                           |
| `reducers.ts` (+ `reducers.spec.ts`)     | `ISceneOp`, `applyOpToDocument`, `loadDocument`, `emptyDocument` — all pure, no React/hookstate                                | from `game/reducers.ts` + `emptyDocument` from `game/state.ts` |
| `sceneStore.ts` (+ `sceneStore.spec.ts`) | The live document slice and its neutral accessors                                                                              | new (holds the `document` formerly in `IGameState`)            |

**`types.ts` — the rename.** `IGameDocument` → `ISceneDocument`. The document is
the scene graph, not a game-specific shape; the new name matches the new home and
removes the last "game" framing from the shared domain. The other type names are
already neutral and move unchanged. (~12 files reference these types and update
to the new import path / name; the change is mechanical.)

**`sceneStore.ts` — the slice.** A dedicated slice keyed `'scene'`:

```ts
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

- `sceneStore()` — imperative accessor (used by `game/socketClient.ts`,
  `game/actions.ts`, and tests), mirroring the existing `gameSlice()` pattern.
- `sceneHooks.usePluginState()` — React subscription (used by `GamePreviewPane`
  and `SceneGraphPane`), mirroring the existing `gameHooks` pattern.

This deliberately reuses the established `makePluginHooks` / scoped-`rootStore`
pattern so the shared store is indistinguishable in style from a plugin slice —
no new state mechanism is introduced.

### Seeding the shared slice

The slice is seeded by registering a **headless entry** in the `PLUGINS` array
(`studio/frontend/src/plugins/index.ts`):

```ts
const scene: IPlugin<ISceneStoreState> = {
  id: SCENE_STORE_ID,
  title: 'Scene',
  persist: false,
  initialState: makeInitialSceneState(),
  panes: [],
};
```

ordered **before** `game` in the array. This reuses `boot.ts`'s existing seeding
loop verbatim (`rootStore.plugins.nested(p.id).set(seed)`), with no special-case
code, and guarantees the `scene` slice exists before `game.init()` connects the
socket and writes the first snapshot. `IPlugin` already permits an empty `panes`
array and an absent `init`/`commands`, so no host/type changes are required. The
headless entry also leaves the obvious future home for a scene socket (its
`init`) if/when #89 needs an outbound op channel.

### Changes in `plugins/game/`

- **`state.ts`** — `IGameState` drops `document`, becoming
  `{ connection, activeGameId, status }`. `emptyDocument` moves to `scene/`.
  `gameSlice()` / `gameHooks` stay for session state. `makeInitialState()` no
  longer seeds a document.
- **`socketClient.ts`** — `applyInbound` writes `sceneStore().document` instead
  of `gameSlice().document`; imports reducers and `ISceneDocument` from `scene/`.
  The `isActive(gameId)` guard still reads `gameSlice().activeGameId` (session
  stays in `game`). The dev-only `window.__gameSceneSnapshot` / `__gameApplyInbound`
  hooks are preserved unchanged (e2e depends on them).
- **`actions.ts`** — `openGame`/`closeGame` reset `sceneStore().document` (via the
  imported `emptyDocument`) instead of `gameSlice().document`.
- **`GamePreviewPane.tsx`** — reads the document from `sceneHooks` /
  `sceneStore()` and imports `ISceneDocument` from `scene/`.
- **`protocolBridge.ts`** — imports `ISceneDocument` from `scene/` (the postMessage
  envelope type). No behavioral change.
- **`reducers.ts`** — file moves to `scene/reducers.ts`; `game/reducers.ts` is
  deleted and its callers (`socketClient.ts`) import from `scene/` instead.

### Changes in `plugins/scene-graph/`

- **`buildTree.ts`** — imports `ISceneDocument` / `NodeType` from `scene/types`
  (was `../game/state`). Signature becomes `buildTree(doc: ISceneDocument, …)`.
- **`SceneGraphPane.tsx`** — reads the document via `sceneHooks.usePluginState()`
  from `scene/` (was `gameHooks` from `../game/state`); imports types from
  `scene/`. The `../game/state` import is **removed entirely**.
- **`state.ts`** (selectedId / collapsed) — **unchanged**.

### Data flow (unchanged behavior)

```
backend GameSceneHub ──scene_snapshot/scene_op──▶ game socketClient
                                                       │
                                       sceneStore().document  (shared live mirror)
                                                       │
                        ┌──────────────────────────────┼───────────────────────────┐
                        ▼                               ▼                           ▼
              GamePreviewPane reads          protocolBridge → Pixi iframe   SceneGraphPane reads
```

The socket still connects at boot via `game.init()`; the _only_ difference is
where the mirror physically lives. No new network traffic, no new sockets, no
behavior change.

## Error handling

No new error surfaces. Existing guards are preserved by moving them intact:
`buildTree`'s cycle / dangling-edge / missing-`Root` guards, the reducers'
prototype-pollution guard, and `socketClient`'s `isActive` gating all move or
stay unchanged.

## Testing

TDD throughout; the refactor is verified primarily by **existing tests staying
green** (behavior is unchanged), with test files re-homed/re-pointed to match:

- `scene/reducers.spec.ts` — moved from `game/reducers.spec.ts`, imports from
  `scene/`.
- `scene/sceneStore.spec.ts` — new: slice seeds an empty document; `sceneStore()`
  reads/writes the document; `makeInitialSceneState()` shape.
- `game/socketClient.spec.ts` — updated to assert on `sceneStore().document`
  rather than `gameSlice().document`.
- `game/GamePreviewPane.spec.tsx`, `game/protocolBridge.spec.ts` — updated
  imports/seeding.
- `scene-graph/buildTree.spec.ts`, `scene-graph/SceneGraphPane.spec.tsx` —
  re-point imports to `scene/` and seed the `scene` slice (not `game`).

All four frontend CI gates must pass before the PR — `prettier --check .`, nx
typecheck, nx test, nx build (vitest passing alone does not prove types/build).
`just e2e` (replay backend) must pass before merge: the scene-graph and
game-preview client flows are the real proof that the mirror relocation is
invisible to the user.

## Isolation boundary (must not touch)

`runtime/client` (Pixi engine), the backend `app/scene/*` (hub / sockets / store),
and the wire protocol. The socket client and protocol bridge **stay in `game/`**
(relocating them is rejected approach C / overlaps #89). No UI→backend mutation
path is added.

## Out of scope (summary)

Pure refactor only — no new UI, no inspector, no Assets/Data section (#87), no
property-inspector plugin (#88), no UI→backend mutation path (#89), no
socket/bridge relocation, no backend/protocol/runtime changes.

## Follow-ups (already filed)

- **#87** — "Assets / Data" section for nodes not reachable via `child` edges.
- **#88** — standalone property-inspector plugin reading the `selectedId` seam.
- **#89** — UI→backend mutation path (add/remove). The headless `scene` entry's
  `init` is the natural future home for an outbound scene socket.
