import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MathProfileTab } from './MathProfileTab';
import type { IMathRun } from '../state';

// This is a MathProfileTab composition test, not a chart-rendering test — real
// uPlot needs a canvas 2D context jsdom doesn't provide. Stub the `IChart` seam's
// React wrapper so the RTP-convergence cell renders as a plain marker instead of
// mounting a real chart (Histogram/StatTiles are hand-rolled SVG/CSS and need no
// such stub — jsdom renders SVG natively). See UPlotChart.spec.tsx for the seam's
// own coverage via an injected fake `IChart`.
vi.mock('../charts/UPlotChart', () => ({
  UPlotChart: ({ className }: { className?: string }) => <div data-testid="uplot-chart-stub" className={className} />,
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
    weights: { rtp: 1, volatility: 1, hitRate: 1 },
  },
  verdict: 'pass',
  metrics: { rtp: 0.912, volatility: 4.1, hitFrequency: 0.34, baseRtp: 0.7, featureRtp: 0.212, bonusHitRates: [0.02] },
  trace: [],
  profile: {
    distribution: {
      bins: [
        { binLo: 0, binHi: 1, base: 400, feature: 0 },
        { binLo: 1, binHi: 2, base: 200, feature: 20 },
        { binLo: 2, binHi: 5, base: 50, feature: 80 },
        { binLo: 100, binHi: 200, base: 0, feature: 3 },
        { binLo: 2000, binHi: null, base: 0, feature: 1 },
      ],
      zeroCount: 3000,
    },
    tail: { maxWin: 2450.0, pGE100x: 0.0021, pLosingSpin: 0.62, longestDeadStreak: 51, bonusTriggerRate: 0.018 },
    rtpConvergence: [
      { n: 100, realizedRtp: 1.2 },
      { n: 1000, realizedRtp: 0.95 },
      { n: 10000, realizedRtp: 0.915 },
      { n: 100000, realizedRtp: 0.912 },
    ],
  },
  createdAt: '2026-07-02T00:00:00Z',
  durationMs: 45231,
};

describe('MathProfileTab', () => {
  it('renders all five Math Profile charts', () => {
    render(<MathProfileTab run={RUN} />);
    expect(screen.getByTestId('win-distribution')).toBeTruthy();
    expect(screen.getByTestId('tail-tiles')).toBeTruthy();
    expect(screen.getByTestId('rtp-composition')).toBeTruthy();
    expect(screen.getByTestId('hit-by-band')).toBeTruthy();
    expect(screen.getByTestId('rtp-convergence')).toBeTruthy();
  });

  it('fills the pane with no inner scroll', () => {
    render(<MathProfileTab run={RUN} />);
    const root = screen.getByTestId('math-profile-tab');
    expect(root.className).toContain('bloom-tab-fill');
  });

  it('shows the tail stat tiles with max win and P(>=100x)', () => {
    render(<MathProfileTab run={RUN} />);
    expect(screen.getByTestId('stat-max-win').textContent).toContain('2450');
    expect(screen.getByTestId('stat-p-ge-100x')).toBeTruthy();
  });

  it('shows an RTP composition readout of base vs feature', () => {
    render(<MathProfileTab run={RUN} />);
    const composition = screen.getByTestId('rtp-composition');
    expect(composition.textContent).toContain('70.0%');
    expect(composition.textContent).toContain('21.2%');
  });

  it('renders a placeholder when the run has no profile yet', () => {
    render(<MathProfileTab run={{ ...RUN, profile: null }} />);
    expect(screen.getByTestId('math-profile-no-data')).toBeTruthy();
  });
});
