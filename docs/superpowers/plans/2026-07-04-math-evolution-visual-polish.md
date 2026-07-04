# Math Evolution Tab Visual Fix + Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Evolution tab's charts fit their containers (resize-aware uPlot adapter), draw the playhead inside the chart, turn the homing panels into sparkline stat tiles, and shrink the gene-convergence heatmap to content height.

**Architecture:** All work lives in `studio/frontend/src/plugins/math`. The `IChart` seam (`IChartData`) grows two optional fields (`playheadX`, `sparkline`); the uPlot adapter (`createUPlotChart`) grows a `ResizeObserver` and a playhead draw hook. Components (`FitnessLandscape`, `EvolutionTab`, `GeneHeatmap`) are restyled on top. Spec: `docs/superpowers/specs/2026-07-04-math-evolution-visual-polish-design.md`.

**Tech Stack:** React 18 + TypeScript, uPlot (already installed), Tailwind utility classes with design-language tokens, vitest + @testing-library/react (jsdom — **no canvas**, so uPlot is always mocked or tested via the pure `toOptions`/`toAlignedData` helpers), Playwright e2e.

## Global Constraints

- Worktree: `C:\code\bloom.wt\math-evolution-visuals`, branch `fix/math-evolution-visuals`, `BLOOM_PORT_OFFSET=1` (backend :8001, frontend :4201). Never use ports :8000/:4200 — another session may hold them.
- No raw color literals outside `styles.css` — use CSS custom properties (`var(--…)`); the guard test `design-language.guard.spec.ts` enforces this. The `cssVar()` helper in `UPlotChart.tsx` is the sanctioned escape hatch for canvas colors.
- TypeScript interfaces use an `I` prefix (`IChartData`, `IGenFrame`) — see `docs/coding-standards.md`.
- No new dependencies. `IChart` gains no new methods — only optional `IChartData` fields.
- Semantic commit format (`fix(math): …`, `test(math): …`).
- All test commands run from the worktree root unless noted. Single-file vitest runs use `npx vitest run <path>` with cwd `studio/frontend`.
- Before any task: `just bootstrap` must have been run once in the worktree (`npm install` + `cd studio/backend && uv sync`).

---

### Task 1: Resize-aware uPlot adapter

The root-cause fix: `createUPlotChart` hard-codes `height = 220` and measures width once at mount. Replace with container-driven sizing plus a `ResizeObserver` that calls `plot.setSize` whenever the mount element's box changes.

**Files:**

- Modify: `studio/frontend/src/plugins/math/charts/UPlotChart.tsx` (the `createUPlotChart` factory, lines ~84–117)
- Test: `studio/frontend/src/plugins/math/charts/UPlotChart.spec.tsx`

**Interfaces:**

- Consumes: existing `toOptions(data, width, height)`, `toAlignedData(data)`, `shapeOf(data)`.
- Produces: `createUPlotChart(): IChart` — **signature loses its `(width = 600, height = 220)` parameters** (no caller passes them; verified by grep). Size always comes from the mount element, with 600×220 as fallbacks for a zero-sized element. Task 2 modifies this same factory again, so finish and commit Task 1 first.

- [ ] **Step 1: Write the failing tests**

In `UPlotChart.spec.tsx`, first extend the existing `FakeUPlot` mock (top of file) with a `setSize` spy — add one line inside the class:

```ts
class FakeUPlot {
  static instances: FakeUPlot[] = [];
  destroy = vi.fn();
  setData = vi.fn();
  setSize = vi.fn(); // <-- add
  constructor(
    public opts: unknown,
    public data: unknown,
    public el: unknown,
  ) {
    FakeUPlot.instances.push(this);
  }
}
```

and widen the helper type:

```ts
type FakeUPlotCtor = {
  instances: { destroy: ReturnType<typeof vi.fn>; setData: ReturnType<typeof vi.fn>; setSize: ReturnType<typeof vi.fn>; opts: uPlot.Options }[];
};
```

(`opts: uPlot.Options` lets later tests inspect constructed options without casts.)

Then append this describe block at the end of the file. jsdom has no `ResizeObserver`, so the tests install a fake on `globalThis` that records instances and lets the test fire the callback manually:

```ts
// The adapter must size the chart from its real container — and re-size it on
// every container resize (Dockview panes resize constantly). jsdom has neither
// canvas nor ResizeObserver, so the observer is faked and fired by hand.
describe('createUPlotChart (container-driven sizing)', () => {
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    observed: Element[] = [];
    disconnected = false;
    constructor(public cb: ResizeObserverCallback) {
      FakeResizeObserver.instances.push(this);
    }
    observe(el: Element) {
      this.observed.push(el);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
  }

  beforeEach(() => {
    (uPlot as unknown as FakeUPlotCtor).instances = [];
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sizedEl(width: number, height: number): HTMLElement {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
    return el;
  }

  it('builds the chart at the mount element size, not a hard-coded 220px height', () => {
    const chart = createUPlotChart();
    chart.mount(sizedEl(800, 143), DATA);
    const opts = (uPlot as unknown as FakeUPlotCtor).instances[0].opts;
    expect(opts.width).toBe(800);
    expect(opts.height).toBe(143);
  });

  it('falls back to 600x220 when the element has no measured size yet', () => {
    const chart = createUPlotChart();
    chart.mount(document.createElement('div'), DATA);
    const opts = (uPlot as unknown as FakeUPlotCtor).instances[0].opts;
    expect(opts.width).toBe(600);
    expect(opts.height).toBe(220);
  });

  it('observes the mount element and setSizes the plot when it resizes', () => {
    const chart = createUPlotChart();
    const el = sizedEl(800, 143);
    chart.mount(el, DATA);

    const ro = FakeResizeObserver.instances[0];
    expect(ro.observed).toEqual([el]);

    Object.defineProperty(el, 'clientWidth', { value: 500, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 90, configurable: true });
    ro.cb([], ro as unknown as ResizeObserver);

    const instance = (uPlot as unknown as FakeUPlotCtor).instances[0];
    expect(instance.setSize).toHaveBeenCalledWith({ width: 500, height: 90 });
  });

  it('disconnects the observer on destroy', () => {
    const chart = createUPlotChart();
    chart.mount(sizedEl(800, 143), DATA);
    chart.destroy();
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
  });
});
```

Add `afterEach` to the vitest import at the top of the file: `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';`

- [ ] **Step 2: Run tests to verify they fail**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals\studio\frontend
npx vitest run src/plugins/math/charts/UPlotChart.spec.tsx
```

Expected: the 4 new tests FAIL (height is 220 regardless of element; no ResizeObserver constructed). The pre-existing tests must still PASS.

- [ ] **Step 3: Implement container-driven sizing in `createUPlotChart`**

Replace the factory in `UPlotChart.tsx` (keep `toAlignedData`, `bandSeriesIndices`, `toOptions`, `shapeOf` as-is):

```ts
/** The uPlot-backed `IChart` implementation. Construction stays behind this factory
 * so components (and their tests) depend only on `IChart`. Size always comes from
 * the mount element (600x220 only as a zero-size fallback), and a ResizeObserver
 * keeps the canvas matched to the container across Dockview pane resizes. */
export function createUPlotChart(): IChart {
  let plot: uPlot | null = null;
  let mountEl: HTMLElement | null = null;
  let shape = '';
  let ro: ResizeObserver | null = null;

  function sizeOf(el: HTMLElement): { width: number; height: number } {
    return { width: el.clientWidth || 600, height: el.clientHeight || 220 };
  }

  function build(el: HTMLElement, data: IChartData) {
    const { width, height } = sizeOf(el);
    plot = new uPlot(toOptions(data, width, height), toAlignedData(data), el);
    shape = shapeOf(data);
  }

  return {
    mount(el, data) {
      mountEl = el;
      build(el, data);
      // jsdom (vitest) has no ResizeObserver; guard so non-resize tests can
      // mount without stubbing it. Real browsers always take this branch.
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => {
          if (plot && mountEl) plot.setSize(sizeOf(mountEl));
        });
        ro.observe(el);
      }
    },
    update(data) {
      if (!plot || !mountEl) return;
      if (shapeOf(data) !== shape) {
        // Series/band count changed since construction — rebuild the uPlot
        // instance from scratch (new options + data) rather than feeding
        // `setData` a mismatched column count.
        plot.destroy();
        build(mountEl, data);
        return;
      }
      plot.setData(toAlignedData(data));
    },
    destroy() {
      ro?.disconnect();
      ro = null;
      plot?.destroy();
      plot = null;
      mountEl = null;
    },
  };
}
```

- [ ] **Step 4: Run the full spec file to verify everything passes**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals\studio\frontend
npx vitest run src/plugins/math/charts/UPlotChart.spec.tsx
```

Expected: ALL tests PASS (new sizing block + pre-existing shape-change/band blocks).

- [ ] **Step 5: Commit**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals
git add studio/frontend/src/plugins/math/charts/UPlotChart.tsx studio/frontend/src/plugins/math/charts/UPlotChart.spec.tsx
git commit -m "fix(math): size uPlot charts from their container with resize tracking"
```

---

### Task 2: Playhead drawn inside the chart

Replace the percentage-positioned overlay div (which ignores uPlot's axis gutter and drifts off the plot area) with a dashed vertical line drawn by the adapter at the true data-space position.

**Files:**

- Modify: `studio/frontend/src/plugins/math/charts/IChart.ts` (add `playheadX` to `IChartData`)
- Modify: `studio/frontend/src/plugins/math/charts/UPlotChart.tsx` (`toOptions` gains a playhead getter param; `createUPlotChart` tracks current data)
- Modify: `studio/frontend/src/plugins/math/charts/FitnessLandscape.tsx` (delete overlay + `playheadPercent`, add `playheadGeneration`)
- Test: `studio/frontend/src/plugins/math/charts/UPlotChart.spec.tsx`, `studio/frontend/src/plugins/math/charts/FitnessLandscape.spec.tsx`

**Interfaces:**

- Consumes: Task 1's `createUPlotChart` shape (no size params, `build(el, data)` inner function).
- Produces:
  - `IChartData.playheadX?: number` — data-space x value; adapter draws a dashed vertical line there.
  - `toOptions(data: IChartData, width: number, height: number, playheadX?: () => number | undefined): uPlot.Options` — 4th param is a **getter** (not a value) so the draw hook, captured at construction, always reads the latest scrub position.
  - `playheadGeneration(frames: IGenFrame[], selectedGeneration: number | 'live'): number | undefined` — exported from `FitnessLandscape.tsx`; replaces the deleted `playheadPercent`.
  - Deleted: `playheadPercent`, the `fitness-landscape-playhead` testid/overlay div.

- [ ] **Step 1: Write the failing adapter tests**

Append to `UPlotChart.spec.tsx`:

```ts
// The playhead is drawn by the adapter inside the plot area (a draw hook at
// valToPos(playheadX)), not an overlay div — the old percentage overlay
// ignored uPlot's axis gutter and drifted off the plot area. The hook reads
// playheadX through a getter so scrubbing (which flows through `update`, not
// a rebuild) always draws at the latest position.
describe('toOptions (playhead draw hook)', () => {
  function fakePlot(valToPosResult: number) {
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      strokeStyle: '',
    };
    return {
      ctx,
      bbox: { top: 10, height: 100, left: 0, width: 400 },
      valToPos: vi.fn(() => valToPosResult),
    } as unknown as uPlot;
  }

  it('registers no draw hook when no playhead getter is passed', () => {
    const opts = toOptions(DATA, 400, 200);
    expect(opts.hooks?.draw ?? []).toEqual([]);
  });

  it('draws a dashed vertical line across the plot area at valToPos(playheadX)', () => {
    const opts = toOptions(DATA, 400, 200, () => 2);
    const draw = opts.hooks!.draw![0];
    const u = fakePlot(123);
    draw(u);
    const ctx = (u as unknown as { ctx: Record<string, ReturnType<typeof vi.fn>> }).ctx;
    expect((u.valToPos as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([2, 'x', true]);
    expect(ctx.setLineDash).toHaveBeenCalledWith([4, 4]);
    expect(ctx.moveTo).toHaveBeenCalledWith(123, 10);
    expect(ctx.lineTo).toHaveBeenCalledWith(123, 110);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
  });

  it('draws nothing when the getter returns undefined', () => {
    const opts = toOptions(DATA, 400, 200, () => undefined);
    const u = fakePlot(123);
    opts.hooks!.draw![0](u);
    const ctx = (u as unknown as { ctx: Record<string, ReturnType<typeof vi.fn>> }).ctx;
    expect(ctx.beginPath).not.toHaveBeenCalled();
  });

  it('the adapter wires the getter to the CURRENT data, so update() moves the playhead without a rebuild', () => {
    const chart = createUPlotChart();
    const el = document.createElement('div');
    chart.mount(el, { ...DATA, playheadX: 1 });

    const ctor = uPlot as unknown as FakeUPlotCtor;
    const opts = ctor.instances[0].opts;
    const u = fakePlot(50);

    chart.update({ ...DATA, playheadX: 3 }); // scrub — same shape, no rebuild
    expect(ctor.instances).toHaveLength(1);

    opts.hooks!.draw![0](u);
    expect((u.valToPos as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(3);
  });
});
```

Note: `opts.hooks!.draw![0]` has uPlot's hook signature `(u: uPlot) => void`; if TypeScript complains about the argument type, call it as `(opts.hooks!.draw![0] as (u: uPlot) => void)(u)`.

- [ ] **Step 2: Run to verify the new block fails**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals\studio\frontend
npx vitest run src/plugins/math/charts/UPlotChart.spec.tsx
```

Expected: FAIL — `toOptions` accepts no 4th param / registers no hooks; adapter never passes a getter.

- [ ] **Step 3: Implement `playheadX` in the seam + adapter**

In `IChart.ts`, add to `IChartData` (after `logX`):

```ts
  /** Draw a dashed vertical playhead at this data-space x value (the Evolution
   * scrubber's generation). Rendered by the adapter inside the plot area. */
  playheadX?: number;
```

In `UPlotChart.tsx`:

1. `toOptions` gains the getter param and, at the end of the returned options object, a `hooks` entry:

```ts
export function toOptions(data: IChartData, width: number, height: number, playheadX?: () => number | undefined): uPlot.Options {
```

```ts
    legend: { show: data.series.length > 1 },
    hooks: playheadX
      ? {
          draw: [
            (u: uPlot) => {
              const xVal = playheadX();
              if (xVal == null) return;
              const x = u.valToPos(xVal, 'x', true);
              const { ctx, bbox } = u;
              ctx.save();
              ctx.strokeStyle = cssVar('--chart-playhead');
              ctx.setLineDash([4, 4]);
              ctx.beginPath();
              ctx.moveTo(x, bbox.top);
              ctx.lineTo(x, bbox.top + bbox.height);
              ctx.stroke();
              ctx.restore();
            },
          ],
        }
      : undefined,
```

2. `createUPlotChart` tracks the latest data so the getter stays live across `update()`:

```ts
export function createUPlotChart(): IChart {
  let plot: uPlot | null = null;
  let mountEl: HTMLElement | null = null;
  let shape = '';
  let ro: ResizeObserver | null = null;
  let current: IChartData | null = null;
```

In `build`: set `current = data;` as the first line, and pass the getter:

```ts
function build(el: HTMLElement, data: IChartData) {
  current = data;
  const { width, height } = sizeOf(el);
  plot = new uPlot(
    toOptions(data, width, height, () => current?.playheadX),
    toAlignedData(data),
    el,
  );
  shape = shapeOf(data);
}
```

In `update`: set `current = data;` as the first line after the `if (!plot || !mountEl) return;` guard. In `destroy`: add `current = null;`.

- [ ] **Step 4: Run to verify the adapter tests pass**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals\studio\frontend
npx vitest run src/plugins/math/charts/UPlotChart.spec.tsx
```

Expected: ALL PASS.

- [ ] **Step 5: Rewrite the FitnessLandscape tests for `playheadGeneration`**

Replace the whole of `FitnessLandscape.spec.tsx` with:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FitnessLandscape, buildFitnessLandscapeData, playheadGeneration } from './FitnessLandscape';
import type { IChartData } from './IChart';
import type { IGenFrame } from '../state';

// The stub surfaces the playheadX the component feeds the seam — the playhead
// is drawn inside the chart by the adapter now, not as an overlay div.
vi.mock('./UPlotChart', () => ({
  UPlotChart: ({ className, data }: { className?: string; data: IChartData }) => (
    <div data-testid="uplot-chart-stub" className={className} data-playhead-x={data.playheadX ?? ''} />
  ),
}));

function frame(generation: number): IGenFrame {
  return {
    generation,
    best: { fitness: -1 / (generation + 1), rtp: 0.9, volatility: 2 },
    population: { min: 0.1 + generation * 0.01, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5 - generation * 0.01, mean: 0.3, diversity: 0.4 },
    geneAgreement: [0.5],
  };
}

const FRAMES = [frame(0), frame(1), frame(2)];

describe('buildFitnessLandscapeData', () => {
  it('builds a best-fitness series aligned to generation', () => {
    const data = buildFitnessLandscapeData(FRAMES);
    expect(data.x).toEqual([0, 1, 2]);
    expect(data.series).toHaveLength(1);
    expect(data.series[0].values).toEqual(FRAMES.map((f) => f.best.fitness));
  });

  it('builds a min-max band and a q1-q3 (IQR) band', () => {
    const data = buildFitnessLandscapeData(FRAMES);
    expect(data.bands).toHaveLength(2);
    const [range, iqr] = data.bands!;
    expect(range.loValues).toEqual(FRAMES.map((f) => f.population.min));
    expect(range.hiValues).toEqual(FRAMES.map((f) => f.population.max));
    expect(iqr.loValues).toEqual(FRAMES.map((f) => f.population.q1));
    expect(iqr.hiValues).toEqual(FRAMES.map((f) => f.population.q3));
  });
});

describe('playheadGeneration', () => {
  it('is the newest generation in live mode', () => {
    expect(playheadGeneration(FRAMES, 'live')).toBe(2);
  });

  it('is the scrubbed generation when it exists in the frames', () => {
    expect(playheadGeneration(FRAMES, 1)).toBe(1);
    expect(playheadGeneration(FRAMES, 0)).toBe(0);
  });

  it('falls back to the newest generation when the scrubbed one is unknown', () => {
    expect(playheadGeneration(FRAMES, 99)).toBe(2);
  });

  it('is undefined with no frames (nothing to mark)', () => {
    expect(playheadGeneration([], 'live')).toBeUndefined();
  });
});

describe('FitnessLandscape', () => {
  it('feeds the newest generation as playheadX in live mode', () => {
    render(<FitnessLandscape frames={FRAMES} selectedGeneration="live" />);
    expect(screen.getByTestId('fitness-landscape')).toBeTruthy();
    expect(screen.getByTestId('uplot-chart-stub').getAttribute('data-playhead-x')).toBe('2');
  });

  it('feeds the scrubbed generation as playheadX when one is selected', () => {
    render(<FitnessLandscape frames={FRAMES} selectedGeneration={1} />);
    expect(screen.getByTestId('uplot-chart-stub').getAttribute('data-playhead-x')).toBe('1');
  });
});
```

- [ ] **Step 6: Run to verify it fails**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals\studio\frontend
npx vitest run src/plugins/math/charts/FitnessLandscape.spec.tsx
```

Expected: FAIL — `playheadGeneration` is not exported; component doesn't set `playheadX`.

- [ ] **Step 7: Rewrite `FitnessLandscape.tsx`**

Replace `playheadPercent` and the component (keep `buildFitnessLandscapeData` and the file's imports, adding `IChartData` if not imported):

```tsx
/** The generation the playhead marks: the scrubbed generation when it exists,
 * otherwise the newest recorded one (live mode, or a stale scrub position
 * after frames reset). Undefined with no frames. */
export function playheadGeneration(frames: IGenFrame[], selectedGeneration: number | 'live'): number | undefined {
  if (frames.length === 0) return undefined;
  if (selectedGeneration !== 'live' && frames.some((f) => f.generation === selectedGeneration)) return selectedGeneration;
  return frames[frames.length - 1].generation;
}

/** Hero chart of the Evolution tab — see docs/superpowers/specs/2026-07-02-math-analytics-dashboard-design.md
 * Tab 1 §1. The line + bands render through the `IChart`/`UPlotChart` seam; the
 * playhead rides inside the chart as `IChartData.playheadX` (drawn by the
 * adapter at the true data-space position — an overlay div can't know uPlot's
 * axis gutter; see docs/superpowers/specs/2026-07-04-math-evolution-visual-polish-design.md §2). */
export function FitnessLandscape({ frames, selectedGeneration }: IFitnessLandscapeProps) {
  const data: IChartData = { ...buildFitnessLandscapeData(frames), playheadX: playheadGeneration(frames, selectedGeneration) };

  return (
    <div data-testid="fitness-landscape" className="flex min-h-0 flex-col overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <span className="flex-none px-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2">Fitness landscape</span>
      <UPlotChart data={data} className="min-h-0 flex-1" />
    </div>
  );
}
```

Deleted: `playheadPercent`, the `relative` wrapper div, and the `fitness-landscape-playhead` overlay div.

- [ ] **Step 8: Verify no other code references the deleted names**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals
git grep -n "playheadPercent\|fitness-landscape-playhead" -- studio
```

Expected: no matches (also check `studio/frontend/e2e` — the grep above covers it).

- [ ] **Step 9: Run both spec files to verify they pass**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals\studio\frontend
npx vitest run src/plugins/math/charts/FitnessLandscape.spec.tsx src/plugins/math/charts/UPlotChart.spec.tsx
```

Expected: ALL PASS.

- [ ] **Step 10: Commit**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals
git add studio/frontend/src/plugins/math/charts/IChart.ts studio/frontend/src/plugins/math/charts/UPlotChart.tsx studio/frontend/src/plugins/math/charts/FitnessLandscape.tsx studio/frontend/src/plugins/math/charts/FitnessLandscape.spec.tsx studio/frontend/src/plugins/math/charts/UPlotChart.spec.tsx
git commit -m "fix(math): draw the fitness-landscape playhead inside the chart at true data position"
```

---

### Task 3: Sparkline homing tiles

`IChartData.sparkline` strips all chart chrome (axes, grid, legend, cursor); the two homing panels become stat tiles — tiny label, big current value, sparkline filling the rest.

**Files:**

- Modify: `studio/frontend/src/plugins/math/charts/IChart.ts` (add `sparkline`)
- Modify: `studio/frontend/src/plugins/math/charts/UPlotChart.tsx` (`toOptions` honors `sparkline`)
- Modify: `studio/frontend/src/plugins/math/tabs/EvolutionTab.tsx` (replace `RtpHoming`/`VolHoming` with one `HomingTile`)
- Test: `studio/frontend/src/plugins/math/charts/UPlotChart.spec.tsx`, `studio/frontend/src/plugins/math/tabs/EvolutionTab.spec.tsx`

**Interfaces:**

- Consumes: `toOptions` from Tasks 1–2 (4-arg signature).
- Produces:
  - `IChartData.sparkline?: boolean` — when true, `toOptions` emits `axes: [{ show: false }, { show: false }]`, `legend: { show: false }`, `cursor: { show: false }`.
  - `EvolutionTab` renders `data-testid="rtp-homing-value"` / `"vol-homing-value"` spans with the latest best value (RTP `toFixed(4)`, volatility `toFixed(3)`). Series labels stay exactly `'Best RTP'` / `'Best volatility'` (an existing test asserts them).

- [ ] **Step 1: Write the failing `toOptions` tests**

Append to `UPlotChart.spec.tsx`:

```ts
// Sparkline mode: the homing tiles show a big current value + a bare line —
// no axes, grid, legend, or cursor (small heights leave no room for gutters).
describe('toOptions (sparkline mode)', () => {
  it('strips axes, legend, and cursor when sparkline is set', () => {
    const opts = toOptions({ ...DATA, sparkline: true }, 400, 80);
    expect(opts.axes).toEqual([{ show: false }, { show: false }]);
    expect(opts.legend).toEqual({ show: false });
    expect(opts.cursor).toEqual({ show: false });
  });

  it('keeps full chrome on non-sparkline charts', () => {
    const opts = toOptions(DATA, 400, 200);
    expect((opts.axes as uPlot.Axis[])[0].show).not.toBe(false);
    expect(opts.cursor).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals\studio\frontend
npx vitest run src/plugins/math/charts/UPlotChart.spec.tsx
```

Expected: the sparkline block FAILS (axes always full).

- [ ] **Step 3: Implement `sparkline` in the seam + `toOptions`**

In `IChart.ts`, add to `IChartData` (after `playheadX`):

```ts
  /** Bare-line mode for stat tiles: no axes, grid, legend, or cursor. */
  sparkline?: boolean;
```

In `toOptions`, replace the fixed `axes` array and `legend`/add `cursor`:

```ts
const axes: uPlot.Axis[] = data.sparkline
  ? [{ show: false }, { show: false }]
  : [
      { label: data.xLabel, stroke: cssVar('--text-2'), grid: { stroke: cssVar('--hairline') } },
      { label: data.yLabel, stroke: cssVar('--text-2'), grid: { stroke: cssVar('--hairline') } },
    ];
```

and in the returned object:

```ts
    axes,
    ...
    legend: { show: !data.sparkline && data.series.length > 1 },
    cursor: data.sparkline ? { show: false } : undefined,
```

- [ ] **Step 4: Run to verify it passes**

Same command as Step 2. Expected: ALL PASS.

- [ ] **Step 5: Write the failing EvolutionTab tests**

In `EvolutionTab.spec.tsx`, update the mock stub to also surface `sparkline`:

```tsx
vi.mock('../charts/UPlotChart', () => ({
  UPlotChart: ({ className, data }: { className?: string; data: IChartData }) => (
    <div
      data-testid="uplot-chart-stub"
      className={className}
      data-series-labels={data.series.map((s) => s.label).join('|')}
      data-sparkline={data.sparkline === true ? 'true' : 'false'}
    />
  ),
}));
```

Append inside the existing `describe('EvolutionTab', ...)`:

```tsx
it('renders the homing charts as sparklines with a big current-value readout', () => {
  render(<EvolutionTab frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
  // Latest frame: rtp = 0.9 + 2*0.001 = 0.902, volatility = 2 + 2*0.01 = 2.02.
  expect(screen.getByTestId('rtp-homing-value').textContent).toBe('0.9020');
  expect(screen.getByTestId('vol-homing-value').textContent).toBe('2.020');
  for (const testId of ['rtp-homing', 'vol-homing'] as const) {
    const stub = screen.getByTestId(testId).querySelector('[data-testid="uplot-chart-stub"]');
    expect(stub?.getAttribute('data-sparkline')).toBe('true');
  }
});

it('the fitness landscape is NOT a sparkline (keeps full axes)', () => {
  render(<EvolutionTab frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
  const stub = screen.getByTestId('fitness-landscape').querySelector('[data-testid="uplot-chart-stub"]');
  expect(stub?.getAttribute('data-sparkline')).toBe('false');
});
```

Note: the second test renders `FitnessLandscape` through the same stub — it works because `EvolutionTab` composes the real `FitnessLandscape`, whose `UPlotChart` import resolves to this file's mock (`../charts/UPlotChart` and `./UPlotChart` are the same module).

- [ ] **Step 6: Run to verify it fails**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals\studio\frontend
npx vitest run src/plugins/math/tabs/EvolutionTab.spec.tsx
```

Expected: FAIL — no `rtp-homing-value` testid, `data-sparkline` is `'false'` on homing stubs.

- [ ] **Step 7: Replace `RtpHoming`/`VolHoming` with `HomingTile`**

In `EvolutionTab.tsx`, replace both bottom components (and their two call sites) with:

```tsx
<div className="grid min-h-0 grid-rows-2 gap-2">
  <HomingTile testId="rtp-homing" title="RTP homing" seriesLabel="Best RTP" frames={frames} pick={(f) => f.best.rtp} format={(v) => v.toFixed(4)} />
  <HomingTile
    testId="vol-homing"
    title="Volatility homing"
    seriesLabel="Best volatility"
    frames={frames}
    pick={(f) => f.best.volatility}
    format={(v) => v.toFixed(3)}
  />
</div>
```

```tsx
/** Best-of-generation convergence as a stat tile: tiny label, the latest best
 * value as the headline number, and a bare sparkline of the homing path. The
 * `analytics_progress` wire carries no target-band bounds (only the
 * best-of-generation scalar), so there is intentionally NO reference line:
 * drawing one at the run's own latest value would be tautological and would
 * falsely imply convergence-to-a-target. Rendering a genuine target band is a
 * tracked fast-follow, gated on the wire growing target bounds. */
function HomingTile({
  testId,
  title,
  seriesLabel,
  frames,
  pick,
  format,
}: {
  testId: string;
  title: string;
  seriesLabel: string;
  frames: IGenFrame[];
  pick: (f: IGenFrame) => number;
  format: (v: number) => string;
}) {
  const data: IChartData = {
    x: frames.map((f) => f.generation),
    series: [{ label: seriesLabel, values: frames.map(pick), colorVar: '--chart-series-1' }],
    sparkline: true,
  };
  return (
    <div data-testid={testId} className="flex min-h-0 flex-col overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <div className="flex flex-none items-baseline justify-between px-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-2">{title}</span>
        <span data-testid={`${testId}-value`} className="text-lg font-medium tabular-nums leading-none text-text-1">
          {format(pick(frames[frames.length - 1]))}
        </span>
      </div>
      <UPlotChart data={data} className="min-h-0 flex-1" />
    </div>
  );
}
```

(`frames` is never empty here — `EvolutionTab` early-returns the no-data placeholder.) Delete the now-unused `RtpHoming`/`VolHoming` functions and their doc comments (the constraint comment moved onto `HomingTile`).

- [ ] **Step 8: Run to verify it passes**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals\studio\frontend
npx vitest run src/plugins/math/tabs/EvolutionTab.spec.tsx src/plugins/math/charts/UPlotChart.spec.tsx
```

Expected: ALL PASS (including the pre-existing `'Best RTP'`/`'Best volatility'` series-label test).

- [ ] **Step 9: Commit**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals
git add studio/frontend/src/plugins/math/charts/IChart.ts studio/frontend/src/plugins/math/charts/UPlotChart.tsx studio/frontend/src/plugins/math/charts/UPlotChart.spec.tsx studio/frontend/src/plugins/math/tabs/EvolutionTab.tsx studio/frontend/src/plugins/math/tabs/EvolutionTab.spec.tsx
git commit -m "feat(math): sparkline stat tiles for RTP/volatility homing"
```

---

### Task 4: Compact gene heatmap + rebalanced tab grid

Fixed 14px gene rows (content height instead of ~35% of the pane), a cold→hot legend chip, and the freed space handed to the top chart row.

**Files:**

- Modify: `studio/frontend/src/plugins/math/charts/GeneHeatmap.tsx`
- Modify: `studio/frontend/src/plugins/math/tabs/EvolutionTab.tsx` (root grid rows)
- Test: `studio/frontend/src/plugins/math/charts/GeneHeatmap.spec.tsx`, `studio/frontend/src/plugins/math/tabs/EvolutionTab.spec.tsx`

**Interfaces:**

- Consumes: nothing new.
- Produces: `data-testid="gene-heatmap-legend"` chip; heatmap grid rows fixed at 14px; `EvolutionTab` root grid `grid-rows-[minmax(0,1fr)_auto_auto]`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('GeneHeatmap', ...)` in `GeneHeatmap.spec.tsx`:

```tsx
it('sizes gene rows at a fixed 14px so the strip hugs its content', () => {
  render(<GeneHeatmap frames={FRAMES} selectedGeneration="live" />);
  const grid = screen.getAllByTestId('gene-heatmap-row')[0].parentElement!;
  expect(grid.style.gridTemplateRows).toBe('repeat(3, 14px)');
});

it('shows the cold-to-hot legend chip', () => {
  render(<GeneHeatmap frames={FRAMES} selectedGeneration="live" />);
  expect(screen.getByTestId('gene-heatmap-legend')).toBeTruthy();
});

it('hides the legend chip when there is no gene data', () => {
  render(<GeneHeatmap frames={[]} selectedGeneration="live" />);
  expect(screen.queryByTestId('gene-heatmap-legend')).toBeNull();
});
```

Append inside `describe('EvolutionTab', ...)` in `EvolutionTab.spec.tsx`:

```tsx
it('gives the chart row all flexible space; heatmap and scrubber size to content', () => {
  render(<EvolutionTab frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
  expect(screen.getByTestId('evolution-tab').className).toContain('grid-rows-[minmax(0,1fr)_auto_auto]');
});
```

- [ ] **Step 2: Run to verify they fail**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals\studio\frontend
npx vitest run src/plugins/math/charts/GeneHeatmap.spec.tsx src/plugins/math/tabs/EvolutionTab.spec.tsx
```

Expected: the 4 new tests FAIL (rows are `minmax(0, 1fr)`, no legend testid, old grid-rows classes).

- [ ] **Step 3: Implement**

In `GeneHeatmap.tsx`, replace the header `<span>` and the grid wrapper:

```tsx
    <div data-testid="gene-heatmap" className="flex min-h-0 flex-col gap-1 overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <div className="flex flex-none items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-2">Gene convergence</span>
        {geneCount > 0 && (
          <span className="flex items-center gap-1 text-[9px] text-text-3">
            drifting
            <span
              data-testid="gene-heatmap-legend"
              className="h-1.5 w-14 rounded-full"
              style={{ background: 'linear-gradient(to right, var(--chart-gene-cold), var(--chart-gene-hot))' }}
            />
            converged
          </span>
        )}
      </div>
      {geneCount === 0 ? (
        <div className="flex items-center justify-center py-3 text-xs text-text-3">No gene data yet.</div>
      ) : (
        <div className="grid gap-[2px]" style={{ gridTemplateRows: `repeat(${geneCount}, 14px)` }}>
```

(The row/cell mapping inside stays exactly as it is. The outer container loses nothing else; the inner grid loses `min-h-0 flex-1` since it now sizes to content, and the empty placeholder trades `flex-1` for `py-3` because the tab row is `auto` now.) Update the component's doc comment sentence about sizing: rows are fixed-height so the strip hugs its content — the tab's flexible space belongs to the charts.

In `EvolutionTab.tsx`, change the root grid classes:

```tsx
    <div data-testid="evolution-tab" className="bloom-tab-fill grid grid-rows-[minmax(0,1fr)_auto_auto] gap-2 bg-surface p-2">
```

- [ ] **Step 4: Run to verify they pass**

Same command as Step 2. Expected: ALL PASS.

- [ ] **Step 5: Commit**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals
git add studio/frontend/src/plugins/math/charts/GeneHeatmap.tsx studio/frontend/src/plugins/math/charts/GeneHeatmap.spec.tsx studio/frontend/src/plugins/math/tabs/EvolutionTab.tsx studio/frontend/src/plugins/math/tabs/EvolutionTab.spec.tsx
git commit -m "fix(math): gene-convergence heatmap hugs content; chart row absorbs freed space"
```

---

### Task 5: Full gates, e2e, PR

**Files:** none new — verification and delivery.

**Interfaces:**

- Consumes: Tasks 1–4 committed.
- Produces: green frontend CI gates, green Playwright suite, an open PR.

- [ ] **Step 1: Run all four frontend CI gates** (vitest green ≠ types valid — run all of them; see the repo's CI Frontend job)

```powershell
cd C:\code\bloom.wt\math-evolution-visuals
node_modules\.bin\prettier --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
```

Expected: all four exit 0. If prettier flags files, run `node_modules\.bin\prettier --write <files>` and amend the relevant commit — never use `npx prettier` (pulls a newer version that disagrees).

- [ ] **Step 2: Start the replay backend on this worktree's ports**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals
just backend-serve-replay
```

Run in background; wait until `http://localhost:8001/health` responds (offset 1). Verify nothing is squatting the port first.

- [ ] **Step 3: Run the Playwright suite**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals
$env:BLOOM_PORT_OFFSET = '1'
just e2e
```

Expected: suite green (86+ specs). The Evolution-tab specs are the behavioral contract for this change — if one fails, the suite decides, not the prose: fix the code (or, only if the suite encodes the old overlay-playhead/oversized-heatmap behavior this change deliberately replaces, update the spec alongside the code and say so in the PR).

- [ ] **Step 4: Push and open the PR**

```powershell
cd C:\code\bloom.wt\math-evolution-visuals
git push -u origin fix/math-evolution-visuals
gh pr create --title "fix(math): Evolution tab fits its pane — resize-aware charts, in-chart playhead, sparkline tiles, compact heatmap" --body "..."
```

PR body: summarize the four changes, link the spec file, note the e2e run (tier, port offset) and that `IChart` grew only optional fields. Do not merge — hand back for review/`/bloom:complete-work`.

---

## Self-Review Notes

- **Spec coverage:** §1 resize → Task 1; §2 playhead → Task 2; §3 sparkline tiles → Task 3; §4 heatmap + grid + legend → Task 4; spec Testing section → per-task tests + Task 5 gates/e2e.
- **Type consistency:** `toOptions(data, width, height, playheadX?)` introduced in Task 2, consumed as 4-arg in Task 3's chrome changes (same function, no signature drift). `HomingTile` props defined and used only within Task 3. `playheadGeneration` defined and tested in Task 2 only.
- **Known intentional choices:** `ResizeObserver` guard (`typeof … !== 'undefined'`) keeps pre-existing jsdom tests green without stubbing; the 600×220 fallback only applies to zero-sized elements (first paint before layout).
