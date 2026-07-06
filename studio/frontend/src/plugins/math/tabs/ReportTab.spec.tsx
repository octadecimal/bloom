import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReportTab } from './ReportTab';
import type { IMathRun } from '../state';

// Composition test, not a chart-rendering test — real uPlot needs a canvas 2D
// context jsdom doesn't provide (mirrors MathProfileTab.spec.tsx / EvolutionTab.spec.tsx).
vi.mock('../charts/UPlotChart', () => ({
  UPlotChart: ({ className }: { className?: string }) => <div data-testid="uplot-chart-stub" className={className} />,
}));

const exportReport = vi.fn();
vi.mock('../lib/exportReport', () => ({
  exportReport: (el: HTMLElement, format: 'pdf' | 'png') => exportReport(el, format),
}));

const RUN: IMathRun = {
  id: 'r1',
  gameId: 'g1',
  params: {
    masterSeed: 2026,
    population: 24,
    maxGenerations: 40,
    searchCandidateCount: 20000,
    finalCandidateCount: 200000,
    elitism: 2,
    mutationRate: 0.25,
    crossoverRate: 0.9,
    stagnationWindow: 12,
    maxAttempts: 4,
    weights: { rtp: 1, volatility: 1, hitRate: 1 },
  },
  verdict: 'pass',
  metrics: { rtp: 0.912, volatility: 4.1, hitFrequency: 0.34, baseRtp: 0.7, featureRtp: 0.212, bonusHitRates: [0.02] },
  trace: [
    {
      generation: 0,
      bestFitness: -0.5,
      bestRtp: 0.88,
      bestVolatility: 4.0,
      population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.4 },
      geneAgreement: [0.3, 0.5],
    },
    {
      generation: 1,
      bestFitness: -0.1,
      bestRtp: 0.912,
      bestVolatility: 4.1,
      population: { min: 0.2, q1: 0.3, median: 0.4, q3: 0.5, max: 0.6, mean: 0.4, diversity: 0.2 },
      geneAgreement: [0.6, 0.8],
    },
  ],
  profile: {
    distribution: {
      bins: [
        { binLo: 0, binHi: 1, base: 400, feature: 0 },
        { binLo: 1, binHi: 2, base: 200, feature: 20 },
        { binLo: 100, binHi: 200, base: 0, feature: 3 },
      ],
      zeroCount: 3000,
    },
    tail: { maxWin: 2450.0, pGE100x: 0.0021, pLosingSpin: 0.62, longestDeadStreak: 51, bonusTriggerRate: 0.018 },
    rtpConvergence: [
      { n: 100, realizedRtp: 1.2 },
      { n: 10000, realizedRtp: 0.915 },
    ],
  },
  createdAt: '2026-07-02T00:00:00Z',
  durationMs: 45231,
};

beforeEach(() => {
  exportReport.mockReset();
  exportReport.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
  // jsdom has no createObjectURL/revokeObjectURL by default.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:mock');
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
});

describe('ReportTab', () => {
  it('renders every section of the stacked document', () => {
    render(<ReportTab run={RUN} />);
    expect(screen.getByTestId('report-summary')).toBeTruthy();
    expect(screen.getByTestId('report-evolution')).toBeTruthy();
    expect(screen.getByTestId('report-gene-convergence')).toBeTruthy();
    expect(screen.getByTestId('report-win-distribution')).toBeTruthy();
    expect(screen.getByTestId('report-tail')).toBeTruthy();
    expect(screen.getByTestId('report-rtp-convergence')).toBeTruthy();
    expect(screen.getByTestId('report-config')).toBeTruthy();
  });

  it('is the one scrollable tab — root has a scroll-container class, unlike the fill-to-pane tabs', () => {
    render(<ReportTab run={RUN} />);
    const root = screen.getByTestId('report-tab');
    expect(root.className).toContain('overflow-y-auto');
    expect(root.className).not.toContain('bloom-tab-fill');
  });

  it('shows the summary tiles for RTP, volatility, hit frequency, and max win', () => {
    render(<ReportTab run={RUN} />);
    expect(screen.getByTestId('summary-rtp').textContent).toContain('91.2%');
    expect(screen.getByTestId('summary-volatility').textContent).toContain('4.1');
    expect(screen.getByTestId('summary-hit-frequency').textContent).toContain('34.0%');
    expect(screen.getByTestId('summary-max-win').textContent).toContain('2450');
  });

  it("shows the config used, drawn from the run's tuning params", () => {
    render(<ReportTab run={RUN} />);
    const config = screen.getByTestId('report-config');
    expect(config.textContent).toContain('2026'); // master seed
    expect(config.textContent).toContain('24'); // population
    expect(config.textContent).toContain('40'); // max generations
  });

  it('has an export button pinned in the header', () => {
    render(<ReportTab run={RUN} />);
    expect(screen.getByTestId('export-button')).toBeTruthy();
  });

  it('dispatches exportReport on the report DOM node when Export is clicked (defaults to PDF)', async () => {
    render(<ReportTab run={RUN} />);
    fireEvent.click(screen.getByTestId('export-button'));
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    const [el, format] = exportReport.mock.calls[0];
    expect(el).toBeInstanceOf(HTMLElement);
    expect(format).toBe('pdf');
  });

  it('exports PNG when the format selector is switched to PNG', async () => {
    render(<ReportTab run={RUN} />);
    fireEvent.change(screen.getByTestId('export-format'), { target: { value: 'png' } });
    fireEvent.click(screen.getByTestId('export-button'));
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    expect(exportReport.mock.calls[0][1]).toBe('png');
  });

  it('disables the export button while an export is in flight', async () => {
    let resolveExport: (b: Blob) => void = () => {};
    exportReport.mockReturnValue(new Promise((resolve) => (resolveExport = resolve)));
    render(<ReportTab run={RUN} />);
    const button = screen.getByTestId('export-button') as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    resolveExport(new Blob(['x']));
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('renders a placeholder when the run has no profile yet', () => {
    render(<ReportTab run={{ ...RUN, profile: null }} />);
    expect(screen.getByTestId('report-no-data')).toBeTruthy();
    expect(screen.queryByTestId('report-summary')).toBeNull();
  });
});
