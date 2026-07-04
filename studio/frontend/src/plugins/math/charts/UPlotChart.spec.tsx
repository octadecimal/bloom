import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import uPlot from 'uplot';
import { UPlotChart, createUPlotChart, toAlignedData, toOptions } from './UPlotChart';
import type { IChart, IChartData } from './IChart';

// `createUPlotChart` (the real `IChart` adapter, as opposed to the fake used
// below) is exercised directly against a mocked `uplot` constructor — jsdom
// has no canvas, so a *real* uPlot instance can never be mounted (see the
// module comment on `toAlignedData`), but the shape-change rebuild logic
// (Compare-tab bug fix) lives entirely in `createUPlotChart`'s `update`, so it
// needs to observe real construct/destroy calls, not a black-box `IChart`
// fake that has no internal uPlot of its own.
vi.mock('uplot', () => {
  class FakeUPlot {
    static instances: FakeUPlot[] = [];
    destroy = vi.fn();
    setData = vi.fn();
    setSize = vi.fn();
    constructor(
      public opts: unknown,
      public data: unknown,
      public el: unknown,
    ) {
      FakeUPlot.instances.push(this);
    }
  }
  return { default: FakeUPlot };
});

type FakeUPlotCtor = { instances: { destroy: ReturnType<typeof vi.fn>; setData: ReturnType<typeof vi.fn>; setSize: ReturnType<typeof vi.fn>; opts: uPlot.Options }[] };

// Tests target the `IChart` seam via an injected fake factory — never the real
// uPlot instance (canvas isn't available in jsdom, and the point of the seam is
// that the React wrapper doesn't care which implementation it drives).
function fakeChart(): { chart: IChart; mount: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } {
  const mount = vi.fn();
  const update = vi.fn();
  const destroy = vi.fn();
  return { chart: { mount, update, destroy }, mount, update, destroy };
}

const DATA: IChartData = {
  x: [1, 2, 3],
  series: [{ label: 'Realized RTP', values: [0.1, 0.2, 0.3], colorVar: '--chart-series-1' }],
};

describe('UPlotChart', () => {
  it('mounts the chart from the seam once on mount', () => {
    const { chart, mount } = fakeChart();
    render(<UPlotChart data={DATA} factory={() => chart} />);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[0][1]).toEqual(DATA);
  });

  it('calls update (not a re-mount) when data changes', () => {
    const { chart, mount, update } = fakeChart();
    const { rerender } = render(<UPlotChart data={DATA} factory={() => chart} />);
    const next: IChartData = { ...DATA, series: [{ ...DATA.series[0], values: [0.4, 0.5, 0.6] }] };
    rerender(<UPlotChart data={next} factory={() => chart} />);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(next);
  });

  it('destroys the chart on unmount', () => {
    const { chart, destroy } = fakeChart();
    const { unmount } = render(<UPlotChart data={DATA} factory={() => chart} />);
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('passes className through to the mount element', () => {
    const { chart } = fakeChart();
    const { container } = render(<UPlotChart data={DATA} factory={() => chart} className="h-40" />);
    expect(container.querySelector('.h-40')).toBeTruthy();
  });
});

// Regression coverage for the Compare-tab overlay bug: uPlot fixes its series
// (and derived options like `legend.show`) at *construction* time, so
// `plot.setData` can silently drop or misalign columns when the caller's
// series/band count changes after mount (`OverlayLines` mounts one chart,
// then selecting a 2nd/3rd Compare run only added a data column — no 2nd
// line, no legend). `createUPlotChart#update` must detect that shape change
// and destroy+rebuild instead.
describe('createUPlotChart (shape-change rebuild)', () => {
  beforeEach(() => {
    (uPlot as unknown as FakeUPlotCtor).instances = [];
  });

  it('destroys and reconstructs the uPlot instance when the series count changes', () => {
    const chart = createUPlotChart();
    const el = document.createElement('div');
    chart.mount(el, DATA); // 1 series

    const ctor = uPlot as unknown as FakeUPlotCtor;
    expect(ctor.instances).toHaveLength(1);
    const first = ctor.instances[0];

    const twoSeries: IChartData = {
      ...DATA,
      series: [...DATA.series, { label: 'Run 2', values: [0.4, 0.5, 0.6], colorVar: '--chart-series-2' }],
    };
    chart.update(twoSeries);

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(ctor.instances).toHaveLength(2); // a fresh instance was constructed
    expect(ctor.instances[1].setData).not.toHaveBeenCalled(); // built directly from data, not fed via setData
  });

  it('destroys and reconstructs when a band is added even with the same series count', () => {
    const chart = createUPlotChart();
    const el = document.createElement('div');
    chart.mount(el, DATA); // 1 series, 0 bands

    const ctor = uPlot as unknown as FakeUPlotCtor;
    const first = ctor.instances[0];

    const withBand: IChartData = {
      ...DATA,
      bands: [{ loValues: [0, 0, 0], hiValues: [1, 1, 1], colorVar: '--chart-population-band' }],
    };
    chart.update(withBand);

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(ctor.instances).toHaveLength(2);
  });

  it('does NOT recreate the instance when the series count is unchanged, only values differ', () => {
    const chart = createUPlotChart();
    const el = document.createElement('div');
    chart.mount(el, DATA);

    const ctor = uPlot as unknown as FakeUPlotCtor;
    const first = ctor.instances[0];

    const sameShapeNewValues: IChartData = { ...DATA, series: [{ ...DATA.series[0], values: [0.9, 0.8, 0.7] }] };
    chart.update(sameShapeNewValues);

    expect(first.destroy).not.toHaveBeenCalled();
    expect(ctor.instances).toHaveLength(1); // no rebuild
    expect(first.setData).toHaveBeenCalledTimes(1); // fast path
  });

  it('shrinking the series count (deselecting runs) also triggers a rebuild, not a mismatched setData', () => {
    const chart = createUPlotChart();
    const el = document.createElement('div');
    const twoSeries: IChartData = {
      ...DATA,
      series: [...DATA.series, { label: 'Run 2', values: [0.4, 0.5, 0.6], colorVar: '--chart-series-2' }],
    };
    chart.mount(el, twoSeries);

    const ctor = uPlot as unknown as FakeUPlotCtor;
    const first = ctor.instances[0];

    chart.update(DATA); // back down to 1 series

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(ctor.instances).toHaveLength(2);
  });
});

// The Evolution tab's FitnessLandscape draws a shaded population band under its
// best-fitness line (Task 13) — `IChartData.bands` was scaffolded in Task 10 but
// never wired up. These target `toAlignedData`/`toOptions` directly (pure
// functions), not a mounted uPlot instance (no canvas in jsdom).
describe('band support', () => {
  const BANDED: IChartData = {
    x: [0, 1, 2],
    series: [{ label: 'Best fitness', values: [1, 2, 3], colorVar: '--chart-series-1' }],
    bands: [{ label: 'Population', loValues: [0, 0, 0], hiValues: [2, 3, 4], colorVar: '--chart-population-band' }],
  };

  it('appends one hi/lo column pair per band to the aligned data, after the plain series', () => {
    expect(toAlignedData(BANDED)).toEqual([
      [0, 1, 2], // x
      [1, 2, 3], // "Best fitness" series
      [2, 3, 4], // band hi
      [0, 0, 0], // band lo
    ]);
  });

  it('declares a uPlot series entry per band edge and wires the bands option to their indices', () => {
    const opts = toOptions(BANDED, 400, 200);
    // idx 0 = x placeholder, idx 1 = "Best fitness", idx 2 = band hi, idx 3 = band lo.
    expect(opts.series).toHaveLength(4);
    expect(opts.bands).toEqual([{ series: [2, 3], fill: expect.any(String) }]);
  });

  it('supports multiple stacked bands (e.g. min–max + IQR) with distinct index pairs', () => {
    const twoBands: IChartData = {
      ...BANDED,
      bands: [
        { label: 'Range', loValues: [0, 0, 0], hiValues: [2, 3, 4], colorVar: '--chart-population-band' },
        { label: 'IQR', loValues: [1, 1, 1], hiValues: [1.5, 2, 3], colorVar: '--chart-iqr-band' },
      ],
    };
    const opts = toOptions(twoBands, 400, 200);
    expect(opts.series).toHaveLength(6);
    expect(opts.bands).toEqual([
      { series: [2, 3], fill: expect.any(String) },
      { series: [4, 5], fill: expect.any(String) },
    ]);
  });

  it('omits the bands option entirely when data has no bands', () => {
    const opts = toOptions(DATA, 400, 200);
    expect(opts.bands ?? []).toEqual([]);
  });
});

// The playhead is drawn by the adapter inside the plot area (a draw hook at
// valToPos(playheadX)), not an overlay div — the old percentage overlay
// ignored uPlot's axis gutter and drifted off the plot area. The hook reads
// playheadX through a getter so scrubbing (which flows through `update`, not
// a rebuild) always draws at the latest position.
describe('toOptions (playhead draw hook)', () => {
  beforeEach(() => {
    (uPlot as unknown as FakeUPlotCtor).instances = [];
  });

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
