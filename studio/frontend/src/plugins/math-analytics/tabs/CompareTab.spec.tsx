import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CompareTab, resolveSelectedRuns } from './CompareTab';
import type { IMathRun } from '../state';
import type { IChartData } from '../charts/IChart';

// Composition test, not a chart-rendering test — real uPlot needs a canvas 2D
// context jsdom doesn't provide (mirrors EvolutionTab.spec.tsx / MathProfileTab.spec.tsx).
// The stub surfaces each overlay's series labels (pipe-joined) so tests can assert
// how many per-run series Compare feeds the seam, without a real uPlot instance.
vi.mock('../charts/UPlotChart', () => ({
  UPlotChart: ({ className, data }: { className?: string; data: IChartData }) => (
    <div data-testid="uplot-chart-stub" className={className} data-series-labels={data.series.map((s) => s.label).join('|')} />
  ),
}));

function snapshot(generation: number) {
  return {
    generation,
    bestFitness: -0.1 * generation,
    bestRtp: 0.9,
    bestVolatility: 2,
    population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.4 },
    geneAgreement: [0.5, 0.6],
  };
}

function run(id: string, createdAt: string, verdict: IMathRun['verdict'] = 'pass'): IMathRun {
  return {
    id,
    gameId: 'g1',
    params: {} as never,
    verdict,
    metrics: { rtp: 0.9, volatility: 3, hitFrequency: 0.3, baseRtp: 0.6, featureRtp: 0.3, bonusHitRates: [] },
    trace: [snapshot(0), snapshot(1)],
    profile: {
      distribution: { bins: [{ binLo: 0, binHi: 1, base: 100, feature: 0 }], zeroCount: 50 },
      tail: { maxWin: 500, pGE100x: 0.01, pLosingSpin: 0.5, longestDeadStreak: 10, bonusTriggerRate: 0.02 },
      rtpConvergence: [
        { n: 100, realizedRtp: 1.1 },
        { n: 1000, realizedRtp: 0.95 },
      ],
    },
    createdAt,
    durationMs: 1000,
  };
}

const RUN_A = run('r1', '2026-07-01T00:00:00Z', 'pass');
const RUN_B = run('r2', '2026-07-02T00:00:00Z', 'near_miss');
const RUN_C = run('r3', '2026-07-03T00:00:00Z', 'pass');
const ALL_RUNS = [RUN_A, RUN_B, RUN_C];

describe('resolveSelectedRuns', () => {
  it('resolves ids to runs in selection order, not history order', () => {
    expect(resolveSelectedRuns(ALL_RUNS, ['r2', 'r1'])).toEqual([RUN_B, RUN_A]);
  });

  it('silently skips a stale id no longer in history', () => {
    expect(resolveSelectedRuns(ALL_RUNS, ['r1', 'gone', 'r3'])).toEqual([RUN_A, RUN_C]);
  });
});

describe('CompareTab', () => {
  it('fills the pane with no inner scroll', () => {
    render(<CompareTab runs={ALL_RUNS} selectedRunIds={['r1', 'r2']} onToggleRun={vi.fn()} />);
    const root = screen.getByTestId('compare-tab');
    expect(root.className).toContain('bloom-tab-fill');
  });

  it('mounts the RunSelector in multi mode over the full run history', () => {
    render(<CompareTab runs={ALL_RUNS} selectedRunIds={['r1']} onToggleRun={vi.fn()} />);
    expect(screen.getByTestId('run-selector')).toBeTruthy();
    expect(screen.getByTestId('run-selector-row-r1')).toBeTruthy();
    expect(screen.getByTestId('run-selector-row-r2')).toBeTruthy();
    expect(screen.getByTestId('run-selector-row-r3')).toBeTruthy();
  });

  it('renders two series in the overlaid RTP-convergence chart for two selected runs', () => {
    render(<CompareTab runs={ALL_RUNS} selectedRunIds={['r1', 'r2']} onToggleRun={vi.fn()} />);
    const overlay = screen.getByTestId('compare-rtp-overlay');
    const stub = overlay.querySelector('[data-testid="uplot-chart-stub"]');
    const labels = stub?.getAttribute('data-series-labels')?.split('|') ?? [];
    expect(labels).toHaveLength(2);
    // `data-series-count` on the OverlayLines wrapper itself — a plain
    // React-rendered signal (unlike uPlot's real legend, whose `legend.show`
    // is fixed at mount and won't reflect a series count that grows via a
    // later `setData`) so e2e/inspection has a reliable series-count DOM hook.
    expect(overlay.getAttribute('data-series-count')).toBe('2');
  });

  it('renders two series in the overlaid volatility (win-distribution) chart for two selected runs', () => {
    render(<CompareTab runs={ALL_RUNS} selectedRunIds={['r1', 'r2']} onToggleRun={vi.fn()} />);
    const overlay = screen.getByTestId('compare-vol-overlay');
    const stub = overlay.querySelector('[data-testid="uplot-chart-stub"]');
    const labels = stub?.getAttribute('data-series-labels')?.split('|') ?? [];
    expect(labels).toHaveLength(2);
    expect(overlay.getAttribute('data-series-count')).toBe('2');
  });

  it('renders a delta-table with one column per selected run', () => {
    render(<CompareTab runs={ALL_RUNS} selectedRunIds={['r1', 'r2']} onToggleRun={vi.fn()} />);
    const table = screen.getByTestId('delta-table');
    expect(table).toBeTruthy();
    expect(screen.getByTestId('delta-col-r1')).toBeTruthy();
    expect(screen.getByTestId('delta-col-r2')).toBeTruthy();
    expect(screen.queryByTestId('delta-col-r3')).toBeNull();
  });

  it('notifies the toggle handler when a run row is clicked in the mounted RunSelector', () => {
    const onToggleRun = vi.fn();
    render(<CompareTab runs={ALL_RUNS} selectedRunIds={['r1']} onToggleRun={onToggleRun} />);
    fireEvent.click(screen.getByTestId('run-selector-row-r2'));
    expect(onToggleRun).toHaveBeenCalledWith('r2');
  });

  it('changes what is compared when selectedRunIds changes (deselecting drops a series/column)', () => {
    const { rerender } = render(<CompareTab runs={ALL_RUNS} selectedRunIds={['r1', 'r2']} onToggleRun={vi.fn()} />);
    expect(screen.getByTestId('delta-col-r2')).toBeTruthy();
    let stub = screen.getByTestId('compare-rtp-overlay').querySelector('[data-testid="uplot-chart-stub"]');
    expect(stub?.getAttribute('data-series-labels')?.split('|')).toHaveLength(2);

    rerender(<CompareTab runs={ALL_RUNS} selectedRunIds={['r1']} onToggleRun={vi.fn()} />);
    expect(screen.queryByTestId('delta-col-r2')).toBeNull();
    stub = screen.getByTestId('compare-rtp-overlay').querySelector('[data-testid="uplot-chart-stub"]');
    expect(stub?.getAttribute('data-series-labels')?.split('|')).toHaveLength(1);
  });

  it('shows a placeholder instead of empty charts when no runs are selected', () => {
    render(<CompareTab runs={ALL_RUNS} selectedRunIds={[]} onToggleRun={vi.fn()} />);
    expect(screen.getByTestId('compare-empty')).toBeTruthy();
    expect(screen.queryByTestId('compare-rtp-overlay')).toBeNull();
  });

  it('colors each series/column by Compare selection order via chartSeriesToken', () => {
    render(<CompareTab runs={ALL_RUNS} selectedRunIds={['r2', 'r1']} onToggleRun={vi.fn()} />);
    // r2 was selected first (index 0) -> series-1; r1 second (index 1) -> series-2.
    expect(screen.getByTestId('delta-col-r2').getAttribute('style')).toContain('--chart-series-1');
    expect(screen.getByTestId('delta-col-r1').getAttribute('style')).toContain('--chart-series-2');
  });
});
