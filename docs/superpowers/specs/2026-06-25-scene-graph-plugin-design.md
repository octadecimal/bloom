# Scene Graph viewer plugin — design

**Date:** 2026-06-25
**Status:** Approved (brainstorm), pending implementation plan
**Branch / worktree:** `feat/scene-graph-plugin` @ `C:/code/bloom.wt/scene-graph-plugin`

## Summary

A new, self-contained Bloom Studio plugin that renders the active game's scene
as a Unity-style hierarchy tree. v1 is strictly **read-only**: it reads the
already-synced scene document from the `game` plugin and displays it. Selecting
a node records a `selectedId` that a future property-inspector plugin will
consume. Add/remove of nodes is explicitly deferred.

The plugin is built in **isolation** from the concurrent client session
(`design-scene-wiring`, editing `runtime/client`): it touches none of the Pixi
client, the protocol bridge, the backend scene hub/sockets/store, or the wire
protocol.

## Context

The scene graph already exists as data. The `game` plugin
(`studio/frontend/src/plugins/game/`) holds an `IGameDocument`:

- `nodes`: a `Record<string, INode>` where `INode = { id, type, props }` and
  `type ∈ { Root, Container, Sprite, Texture }`.
- `edges`: `IEdge[]` where `IEdge = { id, type, from: IPortRef, to: IPortRef }`
  and `type ∈ { child, data }`. `child` edges form the parent/child hierarchy;
  `data` edges wire ports between nodes (e.g. a `Texture` feeding a `Sprite`).

The document is kept live by the `game` plugin's socket client
(`scene_snapshot` + `scene_op` from the backend `GameSceneHub`), mirrored into
`gameSlice().document`, and forwarded to the Pixi client iframe via
`ProtocolBridge` (postMessage). Today **all mutations originate from agent
tools** (`addNode` / `setProp` / `connect` / `disconnect` / `removeNode`); the
scene socket only handles `join_scene` / `leave_scene`. There is no
UI→backend mutation path.

## Approaches considered

- **A — Read-only hierarchy reading `game` state (chosen).** A new plugin that
  reads the `game` plugin's already-synced document and renders a child-edge
  tree. No backend/socket/client changes.
- **B — Self-sufficient viewer** with its own socket + document mirror.
  More isolation from the `game` plugin, but duplicates sync/reducer logic,
  double-joins the scene room, and risks drift. Rejected.
- **C — Full node-graph editor** now (canvas, both edge types, mutations).
  Large surface, collides with the active client session, premature. Rejected.

## Architecture

A new plugin directory `studio/frontend/src/plugins/scene-graph/`, a sibling of
`game` / `gdd` / `tuner`, following the existing `IPlugin` conventions
(`studio/frontend/src/host/types.ts`). It registers:

- one dockview pane — id `scene-graph/tree`, title **"Scene Graph"**;
- one command — id `scene-graph/open`, title **"Open Scene Graph"**, which
  `host.openPane('scene-graph/tree')`.

The plugin is **read-only**. Its only coupling to other code is a **read-only
import** of the `game` plugin's `gameSlice()` accessor and wire types
(`IGameDocument`, `INode`, `IEdge`, `NodeType`) from `../game/state`.

### Components

- **`buildTree.ts`** — the core, a pure function:
  `buildTree(document: IGameDocument): ITreeRow[]`.
  Walks `child` edges out from the `Root` node and produces an ordered,
  depth-tagged list of rows (`ITreeRow = { id, type, depth, name?, hasChildren }`).
  Pure — no React, no hookstate — so it is fully unit-testable.
  Guards:
  - a `visited` set for cycle / diamond safety (never recurses into an
    already-emitted node);
  - skips `child` edges whose target node id is absent from `nodes`;
  - tolerates a missing `Root` node by returning an empty list;
  - data-only nodes (e.g. `Texture` nodes reachable only via `data` edges) are
    intentionally **excluded** in v1 (see Deferred work, item 2).

- **`state.ts`** — the plugin's state slice, using the `makePluginHooks` /
  slice-accessor pattern from the sibling plugins:
  `{ selectedId: string | null; collapsed: Record<string, boolean> }`.
  `selectedId` **is the selection seam** the future inspector reads.
  `collapsed` tracks per-node collapse state — `collapsed[id] === true` hides
  a node's descendants, matching `buildTree`'s parameter (ephemeral;
  `persist: false` in v1).

- **`SceneGraphPane.tsx`** — the React pane. Subscribes to
  `gameSlice().document` (re-renders on each `scene_op`) and to its own slice.
  Renders rows with indentation by `depth`, a type icon
  (Root / Container / Sprite), an expand/collapse caret for rows with children,
  and the node id (and a `name` prop if present). Clicking a row sets
  `selectedId` (row highlight). Shows an empty state when there is no active
  game or the document is empty.

- **`index.ts`** — the `IPlugin` definition; registered with a one-line addition
  to `studio/frontend/src/plugins/index.ts` (`PLUGINS` array).

### Data flow

```
backend GameSceneHub ──scene_snapshot/scene_op──▶ game plugin socketClient
        │                                              │
        │                                  gameSlice().document (live mirror)
        │                                              │
        ▼                                              ▼
   Pixi client iframe                       SceneGraphPane reads document
   (untouched)                              │
                                            ▼
                                    buildTree(document) → rows → render
                                            │
                                   click → scene-graph slice.selectedId
```

No writes leave the plugin; the viewer generates no network traffic of its own.

### Error handling

- Empty / absent document → "No scene loaded" empty state.
- Missing `Root`, dangling `child` edges, and cycles are all absorbed by
  `buildTree` (visited-set + node-existence checks), so the pane never throws on
  malformed or in-flight data.

### Testing

- `buildTree.spec.ts` — nested containers/sprites ordering, depth tags,
  orphan/data-only nodes excluded, cycle guard, missing-`Root` case, dangling
  child-edge case.
- `SceneGraphPane.spec.tsx` — renders rows from a fixture document, click
  selects (updates `selectedId`), empty state.
- Follows the sibling plugins' vitest patterns. All four frontend CI gates
  (`prettier --check .`, nx typecheck, test, build) must pass before any PR —
  vitest passing alone does not prove types/build are valid.

## Isolation boundary (must not touch in v1)

`runtime/client` (Pixi engine), `studio/frontend/src/plugins/game/protocolBridge.ts`,
the backend `app/scene/*` (hub / sockets / store), and the wire protocol. The
only cross-plugin reference is a read-only import from `../game/state`.

## Deferred work (each to be logged as a `/todo`)

1. **Shared scene-store seam** — extract the document mirror out of the `game`
   plugin into a shared scene module both plugins consume, instead of the
   read-only import. Cleaner long-term; deferred to avoid editing the `game`
   plugin while the client session is active.
2. **"Assets / Data" section** — a second section listing nodes not reachable
   via `child` edges (e.g. `Texture` / unparented nodes) so nothing is silently
   hidden.
3. **Property-inspector plugin** — a standalone plugin that reads `selectedId`
   and shows / edits the selected node's props, keeping this plugin focused on
   navigation.
4. **Add/remove nodes** — requires first building a UI→backend mutation path
   (none exists today; mutations come only from agent tools, and the scene
   socket only does `join`/`leave`). Flagged as a conscious future step.

## Out of scope for v1 (summary)

Read-only only — no node add/remove/edit; no property inspector; no
`data`-edge / orphan-node rendering; no node-graph canvas; no changes to the
client, protocol, or backend.
