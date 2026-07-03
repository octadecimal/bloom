import { describe, it, expect, vi, beforeEach } from 'vitest';
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

type FakeUPlotCtor = { instances: { destroy: ReturnType<typeof vi.fn>; setData: ReturnType<typeof vi.fn> }[] };

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
