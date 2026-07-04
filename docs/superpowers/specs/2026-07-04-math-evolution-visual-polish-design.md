# Math Evolution tab — visual fix + polish

**Date:** 2026-07-04
**Status:** Approved
**Scope:** `studio/frontend/src/plugins/math` (charts + Evolution tab). No backend, no new deps.

## Problem

Screenshot review of the Evolution tab (live tune, gen 26) shows:

1. **Charts don't fit their containers.** The fitness landscape overflows its
   box; RTP homing and Volatility homing are cut off at the bottom. Root
   cause: `createUPlotChart` (`charts/UPlotChart.tsx`) hard-codes
   `height = 220` and measures width once at mount (`el.clientWidth`). There
   is no resize handling, so the canvas never matches the flex container —
   and goes stale on every Dockview pane resize.
2. **Playhead misaligned.** The dashed playhead in the fitness landscape is a
   percentage-positioned overlay div (`playheadPercent`) that ignores uPlot's
   axis gutter, so it drifts right of the true generation position (visibly
   past the plot area at the last generation).
3. **Gene convergence is oversized.** `EvolutionTab.tsx` gives the heatmap a
   full `1fr` of a `1.6fr / 1fr / auto` row split — ~35% of the pane for a
   4-gene strip, so cells balloon into large blocks.

## Design

### 1. Resize-aware chart adapter (the load-bearing fix)

`createUPlotChart` grows a `ResizeObserver` on the mount element. On any size
change it calls `plot.setSize({ width, height })` from the container's real
`clientWidth`/`clientHeight`. The hard-coded `height = 220` default is
removed; initial size also comes from the container. The observer is
disconnected in `destroy()`.

This fixes all three cut-off charts at once and benefits every other
`UPlotChart` consumer (Math Profile, Compare) for free, including future pane
resizes.

Note: uPlot's `setSize` sizes the plot region; the mount element must not
grow feedback loops. The chart div stays `absolute inset-0` inside a
`relative min-h-0 flex-1` wrapper (or equivalent) so the observer measures a
stable flex-determined box, not the canvas's own height.

### 2. Playhead moves inside the chart

`IChartData` gains an optional `playheadX?: number` — a **data-space x
value** (the selected generation). The uPlot adapter draws a dashed vertical
line at `valToPos(playheadX, 'x', true)` in a `draw` hook, stroked with
`--chart-playhead` (via the sanctioned `cssVar` escape hatch).

Deleted: the overlay div in `FitnessLandscape.tsx` and the
`playheadPercent()` helper (+ its tests). `FitnessLandscape` passes
`playheadX` instead: the scrubbed generation, or the last generation while
`'live'`.

### 3. Homing panels become sparkline tiles

`IChartData` gains `sparkline?: boolean`. When set, `toOptions` emits no
axes, no grid, no legend, no cursor — just the line (uPlot `axes: [{show:
false}, {show: false}]`, `legend: {show: false}`, `cursor: {show: false}`).

`RtpHoming` / `VolHoming` in `EvolutionTab.tsx` are restyled as stat tiles:

- Header row: the existing tiny uppercase label, plus the **current best
  value** right-aligned as a big number (`text-text-1`, `tabular-nums`,
  ~text-lg; RTP formatted to 4 decimals, volatility to 3).
- Body: the sparkline fills the remaining height.

Small heights stop mattering because there are no axis gutters to squeeze.
The no-fabricated-target constraint stands: no reference lines until the
wire carries target bounds (tracked fast-follow).

### 4. Gene convergence shrinks to content

- Cell rows get a fixed height: `gridTemplateRows: repeat(geneCount, 14px)`
  (was `minmax(0, 1fr)`).
- The tab grid changes from `minmax(0,1.6fr) minmax(0,1fr) auto` to
  `minmax(0,1fr) auto auto` — the fitness landscape + homing row absorbs all
  freed space.
- The heatmap header gains a small legend chip: a horizontal
  cold→hot gradient bar (same `color-mix` tokens, `--chart-gene-cold` →
  `--chart-gene-hot`) flanked by `drifting` / `converged` micro-labels
  (`text-text-3`), so the amber wall is self-explanatory.

## Testing

TDD at the unit level; the design-language guard and existing e2e stay the
behavioral contract.

- `toOptions` unit tests: `sparkline` strips axes/legend/cursor; playhead
  draw hook registered when `playheadX` is set, absent otherwise.
- Adapter test: `ResizeObserver` observed on mount, disconnected on destroy
  (jsdom has no canvas — test through the exported pure helpers and a
  mocked observer, mirroring the existing spec's approach).
- `GeneHeatmap` spec: rows render at fixed 14px template; legend chip
  present.
- `EvolutionTab` spec: homing tiles show formatted current value.
- Existing Playwright Evolution spec must stay green — `just e2e` from this
  worktree with `BLOOM_PORT_OFFSET=1` (backend :8001, frontend :4201).

## Constraints

- No raw color literals outside `styles.css` (guard-enforced); tokens only.
- No new dependencies.
- `IChart` seam grows only the two optional `IChartData` fields; no new
  methods.
