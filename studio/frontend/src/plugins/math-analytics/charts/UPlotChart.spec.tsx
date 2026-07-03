import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { UPlotChart } from './UPlotChart';
import type { IChart, IChartData } from './IChart';

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
