# Property Inspector plugin — design

**Date:** 2026-06-25
**Status:** Approved (brainstorm), pending implementation plan
**Branch / worktree:** `feat/property-inspector` @ `C:/code/bloom.wt/property-inspector`
**Issue:** #88 (scene-graph: standalone property-inspector plugin) — deferred item 3
of `docs/superpowers/specs/2026-06-25-scene-graph-plugin-design.md`.

## Summary

A new, self-contained Bloom Studio plugin that shows the properties of the
scene node currently selected in the scene-graph viewer. v1 is strictly
**read-only**: it reads `selectedId` from the scene-graph plugin's selection
seam, looks the node up in the live scene document, and renders the node's type,
id, and props as a nested (expand/collapse) JSON tree. There is no edit path —
editing requires a UI→backend mutation seam that does not yet exist (issue #89).

The plugin keeps the scene-graph plugin focused on navigation: scene-graph owns
selection, the inspector owns presentation of the selected node.

## Context

The seams this plugin consumes already exist on `main`:

- **Selection seam** — `sceneGraphSlice().selectedId` (`string | null`) and the
  `sceneGraphHooks` accessor in `studio/frontend/src/plugins/scene-graph/state.ts`
  (shipped in PR #92). The scene-graph pane sets `selectedId` when a row is clicked.
- **Scene document** — the live `IGameDocument` lives in the **game** plugin:
  `gameSlice().document` / `gameHooks` in `studio/frontend/src/plugins/game/state.ts`,
  kept current by the game plugin's socket client (`scene_snapshot` / `scene_op`).
  `INode = { id, type, props: Record<string, JsonValue> }` with
  `type ∈ { Root, Container, Sprite, Texture }`.

> **Note on the brief's premise:** an earlier brief referenced a shared
> `studio/frontend/src/scene/sceneStore.ts` (PR #95). That shared store is **not**
> on `main`; the scene document is still owned by the `game` plugin. This plugin
> therefore reads `gameSlice().document` directly and imports the selection seam
> from `../scene-graph/state`, mirroring exactly how the scene-graph plugin's
> `buildTree.ts` / `SceneGraphPane.tsx` already consume these. If the shared
> scene-store seam lands later, swapping the document import is a one-line change
> (logged as deferred work in the scene-graph design).

## Approaches considered

- **A — Read-only inspector reading existing seams (chosen).** A new plugin that
  reads `sceneGraphSlice().selectedId` + `gameSlice().document`, resolves the node,
  and renders its props. No backend/socket/client changes; pure frontend.
- **B — Nested JSON tree vs. flat key/value list.** Props are
  `Record<string, JsonValue>`, so values may be nested objects/arrays. **Nested
  tree chosen** (per brainstorm) so deep props are inspectable without truncation;
  the pure helper flattens to depth-tagged rows with per-path collapse, mirroring
  the scene-graph `buildTree` shape. A flat list (objects shown as one-line JSON)
  was the simpler alternative; rejected because it hides nested structure.
- **C — Scaffold an edit affordance now.** Rejected (YAGNI): editing needs the
  UI→backend mutation path that does not exist (issue #89); disabled stubs would be
  dead UI. v1 stays strictly read-only, mirroring how scene-graph shipped.

## Architecture

A new plugin directory `studio/frontend/src/plugins/property-inspector/`, a
sibling of `scene-graph` / `game` / `gdd` / `tuner`, following the existing
`IPlugin` conventions (`studio/frontend/src/host/types.ts`). It registers:

- one dockview pane — id `property-inspector/panel`, title **"Inspector"**;
- one command — id `property-inspector/open`, title **"Open Inspector"**, which
  `host.openPane('property-inspector/panel')`.

The plugin is **read-only**. Its only coupling to other code is two **read-only
imports**:

- the scene-graph selection seam (`sceneGraphHooks`, `sceneGraphSlice`) from
  `../scene-graph/state`;
- the scene document accessor and wire types (`gameHooks`, `IGameDocument`,
  `INode`, `JsonValue`, `NodeType`) from `../game/state`.

### Components

- **`inspect.ts`** — the core, a pure function:
  `inspectSelection(doc: IGameDocument, selectedId: string | null, collapsed: Record<string, boolean>): IInspectorView | null`.
  - Returns `null` when `selectedId` is `null` **or** when it is not present in
    `doc.nodes` (a stale selection, e.g. after the selected node is removed from
    the live document). The pane renders its empty state in that case.
  - Otherwise returns `{ id, type, rows }` where
    `IInspectorView = { id: string; type: NodeType; rows: IPropRow[] }` and
    `IPropRow = { path: string; key: string; depth: number; kind: 'scalar' | 'object' | 'array'; display?: string; hasChildren: boolean; count?: number }`.
  - Recursively flattens `node.props` into a pre-order, depth-tagged row list:
    - **scalars** (`string | number | boolean | null`) → leaf row, `hasChildren:
false`, with a formatted `display` string (`"hero"`, `120`, `true`, `null`);
    - **objects / arrays** → branch row, `hasChildren: true`, `count` = number of
      entries; recurses into entries (object keys / array indices in order) unless
      `collapsed[path] === true`;
    - **empty `{}` / `[]`** → leaf row (`hasChildren: false`), shown as `{}` / `[]`.
  - `path` is a unique, stable string used as both the React key and the collapse
    key: top-level prop `name` → `"name"`; nested → `"tint.r"`; array element →
    `"items.0"`.
  - **Cycle / malformed-data guard:** a `visited` set of object/array references
    prevents infinite recursion on a cyclic or malformed in-flight value, so the
    pane never throws (mirrors `buildTree`'s visited-set robustness). Valid JSON is
    acyclic; the guard defends against degenerate runtime data.
  - Pure — no React, no hookstate — so it is fully unit-testable.

- **`state.ts`** — the plugin's state slice, using the `makePluginHooks` /
  slice-accessor pattern from the sibling plugins:
  `{ collapsed: Record<string, boolean> }`. `collapsed[path] === true` hides a
  branch's descendants (absent ⇒ expanded), matching `inspectSelection`'s
  parameter and the scene-graph collapse convention. The slice does **not** own
  `selectedId` — that remains the scene-graph plugin's seam, read read-only.
  Ephemeral (`persist: false` in v1).

- **`InspectorPane.tsx`** — the React pane. Subscribes to `gameHooks` (re-renders
  on each `scene_op`), `sceneGraphHooks` (re-renders when `selectedId` changes),
  and its own slice (`collapsed`); calls `bumpRenderCount('InspectorPane')` per the
  render-count discipline used by `SceneGraphPane`. Renders:
  - a **header** showing the node TYPE and ID (uppercase `text-2` labels per the
    design language);
  - the prop rows, indented by `depth`, each scalar showing `key` + formatted
    `display`, each branch showing `key` + a `{n}` / `[n]` count and an
    expand/collapse caret (`ChevronDown` / `ChevronRight`, as scene-graph uses).
  - an **empty state** ("No node selected.") when `inspectSelection` returns
    `null`.
    Clicking a branch caret toggles `collapsed[path]` in the slice.

- **`index.ts`** — the `IPlugin` definition; registered with a one-line addition to
  `studio/frontend/src/plugins/index.ts` (`PLUGINS` array).

### Data flow

```
backend GameSceneHub ──scene_snapshot/scene_op──▶ game plugin socketClient
                                                       │
                                           gameSlice().document (live mirror)
                                                       │
scene-graph pane ──click row──▶ sceneGraphSlice().selectedId
                                                       │
                          ┌────────────────────────────┘
                          ▼
                 InspectorPane reads (document, selectedId, collapsed)
                          │
                          ▼
          inspectSelection(document, selectedId, collapsed) → header + rows → render
                          │
                 caret click → property-inspector slice.collapsed[path]
```

No writes leave the plugin; the inspector generates no network traffic of its own.
Selection still happens in the scene-graph pane; the inspector only reads it.

### Error handling

- No selection, or `selectedId` not in `doc.nodes` (stale after removal) →
  `inspectSelection` returns `null` → "No node selected." empty state.
- Cyclic / malformed prop values are absorbed by the visited-set guard, so the
  pane never throws on malformed or in-flight data.
- A node arriving mid-stream with a `type` outside the closed `NodeType` union is
  tolerated by an icon/label fallback (as `SceneGraphPane` does for its row icon).

### Testing

- `inspect.spec.ts` — scalar formatting (string/number/boolean/null); nested
  object → depth-tagged rows in order; nested array → indexed rows; collapse hides
  a branch's descendants (branch row still emitted); empty `{}` / `[]` rendered as
  a leaf; `selectedId === null` → `null`; stale `selectedId` (absent from
  `nodes`) → `null`; cycle/malformed value does not loop.
- `InspectorPane.spec.tsx` — header shows the selected node's type and id; renders
  a row per prop from a fixture node + selection; caret toggles collapse (a
  descendant row appears/disappears); empty state when nothing is selected.
- `index.spec.ts` — asserts the plugin id, pane id, command id, `persist: false`,
  and initial state (mirrors `scene-graph/index.spec.ts`).
- Follows the sibling plugins' vitest patterns. All four frontend gates
  (`prettier --check .`, `nx typecheck frontend`, `nx test frontend`, `nx build
frontend`) must pass before any PR — vitest passing alone does not prove
  types/build are valid.

## Isolation boundary (must not touch in v1)

`runtime/client` (Pixi engine), `studio/frontend/src/plugins/game/protocolBridge.ts`,
the backend `app/scene/*` (hub / sockets / store), and the wire protocol. The
scene-graph plugin is touched **only** by a read-only import of its selection seam
(`../scene-graph/state`); no scene-graph behavior changes. The game plugin is
touched only by a read-only import (`../game/state`).

## Deferred work (each already an open issue)

1. **Assets / Data section (issue #87)** — list nodes not reachable via `child`
   edges (e.g. `Texture` / unparented nodes); orthogonal to per-node props.
2. **UI→backend mutation path (issue #89)** — the write seam required before the
   inspector can edit props or before nodes can be added/removed. Until it exists,
   the inspector stays read-only.
3. **Shared scene-store seam** — if the document mirror is extracted out of the
   `game` plugin into a shared scene module (scene-graph design, deferred item 1),
   swap this plugin's `../game/state` document import to the shared accessor.

## Out of scope for v1 (summary)

Read-only only — no prop editing, no node add/remove; no Assets/Data section; no
`data`-edge / connection rendering; no persistence of collapse state; no changes
to the scene-graph plugin's behavior, the client, the protocol, or the backend.
