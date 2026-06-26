# Asset Board view modes — design

## Problem

The asset board renders every asset as a fixed ~224px-wide card (`w-56`) with a
128px-tall image, a candidate-seed row, a workflow tag, and Generate/Delete
buttons. The cards are space-hungry, so only a handful fit on screen at once. As
games accumulate dozens of assets, the board forces constant scrolling and gives
no way to scan many thumbnails at a glance.

We want a Windows-Explorer-style view control: a toolbar toggle that changes
thumbnail **size** and **layout**, letting the user trade per-card detail for
density.

## Goals

- A toolbar control on the asset board that switches between discrete view modes.
- Smaller thumbnails that pack many more assets into the same real estate.
- A compact list ("details") layout for maximum vertical density.
- The chosen view is remembered across sessions (global, all games).

## Non-goals

- No backend or shared-store changes — this is purely client-side view state.
- No per-game view preferences (one global preference).
- No drag-to-resize / freeform thumbnail sizing — discrete modes only.
- No changes to generation, selection, candidate, or lightbox behavior beyond
  where each surfaces per mode.

## View modes

Four modes, driven by a single presentation config so `AssetCard` stays a thin
renderer that looks up its tokens by mode:

| Mode       | Layout        | Tile / row size     | Chrome shown                                                   |
| ---------- | ------------- | ------------------- | -------------------------------------------------------------- |
| **Small**  | wrap grid     | ~96px tiles         | thumbnail + name; actions on hover / when selected             |
| **Medium** | wrap grid     | ~144px tiles        | thumbnail + name; actions on hover / when selected             |
| **Large**  | wrap grid     | ~224px card (today) | full chrome: workflow tag, candidate-seed row, Generate/Delete |
| **List**   | vertical rows | ~40px thumb per row | row: thumb · name · workflow · status · actions on the right   |

**Default mode (nothing stored): Medium.**

### Cross-mode invariants

- **Transient states stay visible in every mode.** `generating` (with progress),
  `queued`, and `error` must surface even on small/medium tiles and list rows —
  on tiles as a small status overlay/badge so an in-flight or failed generation
  is never silently hidden.
- **Lightbox-on-click** of the selected image is preserved in all modes.
- **Selection** (clicking a candidate to select a generation) remains available;
  the candidate-seed row is only shown inline in Large. In Small/Medium it
  appears on hover/selection; in List it is hidden (selection still reachable via
  the lightbox / Large mode).

## The toolbar control

A segmented control of four icon buttons rendered in the existing `PanelHeader`
`right` slot, keeping the header as the single toolbar row:

- Icons from `lucide-react` (already a dependency), one per mode (e.g.
  `Grid3x3` / `LayoutGrid` / `Square` / `List`).
- Built from the existing `Button` (`variant="ghost"`) — there is no
  `ToggleGroup` in the UI kit and this is too small to justify a new dependency.
- Each button has an `aria-label`, a tooltip, a `data-testid`
  (`view-mode-small` / `view-mode-medium` / `view-mode-large` / `view-mode-list`),
  and an active treatment (`aria-pressed` + accent styling) on the current mode.

## State & persistence

A new `studio/frontend/src/plugins/assets/prefs.ts`, mirroring
`plugins/llm-chat/prefs.ts` exactly:

```ts
export type AssetViewMode = 'small' | 'medium' | 'large' | 'list';
export interface IAssetPrefs {
  viewMode: AssetViewMode;
}
```

Persisted via the existing `savePersisted` / `loadPersisted` helpers
(`state/persistence.ts`) — keyed (`assets.prefs`) and versioned, stored in
localStorage, global across games. `loadPrefs()` defaults to
`{ viewMode: 'medium' }`.

`AssetBoardPane` holds `viewMode` in local React state seeded from `loadPrefs()`.
Clicking a toggle updates the state **and** calls `savePrefs()`.

## Data flow

```
AssetBoardPane
  ├─ reads viewMode (local state, seeded from loadPrefs)
  ├─ picks the container layout class (grid vs list) from viewConfig[viewMode]
  └─ renders AssetCard[] with a `mode` prop
        └─ AssetCard looks up presentation tokens (dimensions + which chrome
           to render) from viewConfig[mode]
```

No shared store changes; no socket/REST changes.

### `viewConfig.ts`

A pure module mapping each mode to its presentation tokens — the container
layout class, tile/row dimensions, and which chrome blocks render. Keeping this
data-driven (rather than branching inside `AssetCard`) makes it independently
unit-testable and keeps the card a thin renderer.

## Components touched

- **`AssetBoardPane.tsx`** — render the segmented `ViewToggle` in the header;
  hold `viewMode` state; choose the grid/list container class; pass `mode` to
  cards.
- **`AssetCard.tsx`** — accept a `mode` prop; render chrome per
  `viewConfig[mode]`; ensure transient states surface in every mode.
- **New `ViewToggle.tsx`** — the four-button segmented control.
- **New `viewConfig.ts`** — the mode → presentation token map.
- **New `prefs.ts`** — load/save the global view-mode preference.

## Testing

### Unit (vitest)

- `prefs.ts`: load returns the default when nothing stored; save round-trips;
  version bump invalidates stale data (mirrors llm-chat prefs tests).
- `viewConfig.ts`: the map is complete for all four modes; each entry has a
  layout, dimensions, and chrome flags.
- `AssetBoardPane`: renders four view-mode toggles; clicking one applies the
  correct container layout and persists via `savePrefs`; seeds from `loadPrefs`
  on mount.
- `AssetCard`: renders the correct chrome per mode — full at Large,
  thumbnail+name at Small/Medium, row at List — and still surfaces
  error/progress/queued states in every mode.

### E2e (`assets.spec.ts`)

- Switching modes changes the grid density / layout (assert tile count or
  layout testid changes).
- Reloading the page preserves the chosen mode (persistence end-to-end).

## Risks & mitigations

- **Hidden generation state at small sizes** — mitigated by the cross-mode
  invariant that transient states always surface as an overlay/badge; covered by
  an explicit `AssetCard` unit test per mode.
- **Density vs. usability of actions** — actions move to hover/selection at
  small sizes; Large remains the full-detail mode for when the user needs every
  control inline.

```

```
