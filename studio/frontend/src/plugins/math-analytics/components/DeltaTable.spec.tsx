import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeltaTable, generationsToConverge } from './DeltaTable';
import type { IMathRun } from '../state';

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

const RUN_A: IMathRun = {
  id: 'r1',
  gameId: 'g1',
  params: {} as never,
  verdict: 'pass',
  metrics: { rtp: 0.912, volatility: 4.1, hitFrequency: 0.34, baseRtp: 0.7, featureRtp: 0.212, bonusHitRates: [0.02] },
  trace: [snapshot(0), snapshot(1), snapshot(2)],
  profile: {
    distribution: { bins: [{ binLo: 0, binHi: 1, base: 400, feature: 0 }], zeroCount: 100 },
    tail: { maxWin: 2450.0, pGE100x: 0.0021, pLosingSpin: 0.62, longestDeadStreak: 51, bonusTriggerRate: 0.018 },
    rtpConvergence: [{ n: 100, realizedRtp: 0.9 }],
  },
  createdAt: '2026-07-01T00:00:00Z',
  durationMs: 45231,
};

const RUN_B: IMathRun = {
  id: 'r2',
  gameId: 'g1',
  params: {} as never,
  verdict: 'near_miss',
  metrics: { rtp: 0.87, volatility: 3.2, hitFrequency: 0.3, baseRtp: 0.6, featureRtp: 0.27, bonusHitRates: [0.01] },
  trace: [snapshot(0), snapshot(1)],
  profile: {
    distribution: { bins: [{ binLo: 0, binHi: 1, base: 300, feature: 10 }], zeroCount: 90 },
    tail: { maxWin: 1500.5, pGE100x: 0.001, pLosingSpin: 0.58, longestDeadStreak: 40, bonusTriggerRate: 0.012 },
    rtpConvergence: [{ n: 100, realizedRtp: 0.86 }],
  },
  createdAt: '2026-07-02T00:00:00Z',
  durationMs: 30000,
};

const RUN_NO_DATA: IMathRun = {
  id: 'r3',
  gameId: 'g1',
  params: {} as never,
  verdict: null,
  metrics: null,
  trace: [],
  profile: null,
  createdAt: '2026-07-03T00:00:00Z',
  durationMs: null,
};

describe('generationsToConverge', () => {
  it('derives the generation count from the last trace entry (0-indexed generation + 1)', () => {
    expect(generationsToConverge(RUN_A)).toBe(3);
    expect(generationsToConverge(RUN_B)).toBe(2);
  });

  it('is 0 for a run with no trace', () => {
    expect(generationsToConverge(RUN_NO_DATA)).toBe(0);
  });
});

describe('DeltaTable', () => {
  it('renders one column per run', () => {
    render(<DeltaTable runs={[RUN_A, RUN_B]} />);
    expect(screen.getByTestId('delta-table')).toBeTruthy();
    expect(screen.getByTestId('delta-col-r1')).toBeTruthy();
    expect(screen.getByTestId('delta-col-r2')).toBeTruthy();
  });

  it('tints each column header with that run’s series color', () => {
    render(<DeltaTable runs={[RUN_A, RUN_B]} />);
    const colA = screen.getByTestId('delta-col-r1');
    const colB = screen.getByTestId('delta-col-r2');
    expect(colA.getAttribute('style')).toContain('--chart-series-1');
    expect(colB.getAttribute('style')).toContain('--chart-series-2');
  });

  it('renders the six required rows', () => {
    render(<DeltaTable runs={[RUN_A, RUN_B]} />);
    expect(screen.getByTestId('delta-row-rtp')).toBeTruthy();
    expect(screen.getByTestId('delta-row-volatility')).toBeTruthy();
    expect(screen.getByTestId('delta-row-hit-frequency')).toBeTruthy();
    expect(screen.getByTestId('delta-row-max-win')).toBeTruthy();
    expect(screen.getByTestId('delta-row-generations')).toBeTruthy();
    expect(screen.getByTestId('delta-row-verdict')).toBeTruthy();
  });

  it('shows correct derived values per run', () => {
    render(<DeltaTable runs={[RUN_A, RUN_B]} />);
    expect(screen.getByTestId('delta-row-rtp-r1').textContent).toContain('91.2%');
    expect(screen.getByTestId('delta-row-rtp-r2').textContent).toContain('87.0%');
    expect(screen.getByTestId('delta-row-volatility-r1').textContent).toContain('4.1');
    expect(screen.getByTestId('delta-row-hit-frequency-r1').textContent).toContain('34.0%');
    expect(screen.getByTestId('delta-row-max-win-r1').textContent).toContain('2450.0');
    expect(screen.getByTestId('delta-row-max-win-r2').textContent).toContain('1500.5');
    expect(screen.getByTestId('delta-row-generations-r1').textContent).toBe('3');
    expect(screen.getByTestId('delta-row-generations-r2').textContent).toBe('2');
    expect(screen.getByTestId('delta-row-verdict-r1').textContent).toMatch(/pass/i);
    expect(screen.getByTestId('delta-row-verdict-r2').textContent).toMatch(/near.?miss/i);
  });

  it('falls back to a placeholder for a run with no metrics/profile yet', () => {
    render(<DeltaTable runs={[RUN_NO_DATA]} />);
    expect(screen.getByTestId('delta-row-rtp-r3').textContent).toBe('—');
    expect(screen.getByTestId('delta-row-max-win-r3').textContent).toBe('—');
    expect(screen.getByTestId('delta-row-generations-r3').textContent).toBe('0');
    expect(screen.getByTestId('delta-row-verdict-r3').textContent).toBe('—');
  });

  it('shows a placeholder when no runs are selected', () => {
    render(<DeltaTable runs={[]} />);
    expect(screen.getByTestId('delta-table').textContent).toMatch(/select/i);
  });
});
