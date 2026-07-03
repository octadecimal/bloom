import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MathAnalyticsPane } from './MathAnalyticsPane';
import { MATH_ANALYTICS_PLUGIN_ID, makeInitialState, analyticsSlice } from './state';
import { rootStore } from '../../state/rootStore';
import type { IMathRun } from './state';

vi.mock('./charts/UPlotChart', () => ({
  UPlotChart: ({ className }: { className?: string }) => <div data-testid="uplot-chart-stub" className={className} />,
}));

const openGameAnalytics = vi.fn();
const scrub = vi.fn();
vi.mock('./actions', () => ({
  openGameAnalytics: (id: string) => openGameAnalytics(id),
  closeGameAnalytics: vi.fn(),
  initAnalytics: vi.fn(),
  selectRun: vi.fn(),
  scrub: (n: number) => scrub(n),
}));

function run(id: string, trace: IMathRun['trace'] = []): IMathRun {
  return {
    id,
    gameId: 'g1',
    params: {} as never,
    verdict: 'pass',
    metrics: { rtp: 0.9, volatility: 3, hitFrequency: 0.3, baseRtp: 0.6, featureRtp: 0.3, bonusHitRates: [] },
    trace,
    profile: {
      distribution: { bins: [], zeroCount: 10 },
      tail: { maxWin: 100, pGE100x: 0.01, pLosingSpin: 0.5, longestDeadStreak: 5, bonusTriggerRate: 0.02 },
      rtpConvergence: [{ n: 100, realizedRtp: 0.9 }],
    },
    createdAt: 't',
    durationMs: null,
  };
}

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

beforeEach(() => {
  rootStore.plugins.nested(MATH_ANALYTICS_PLUGIN_ID).set(makeInitialState() as never);
  openGameAnalytics.mockReset();
});

describe('MathAnalyticsPane', () => {
  it('shows a no-game placeholder when no game is open', () => {
    render(<MathAnalyticsPane {...({} as never)} />);
    expect(screen.getByTestId('analytics-no-game')).toBeTruthy();
  });

  it('refreshes the run history when the pane opens for a game (mirrors tuner issue #82)', () => {
    analyticsSlice().activeGameId.set('g1');
    analyticsSlice().loadStatus.set('idle');
    render(<MathAnalyticsPane {...({} as never)} />);
    expect(openGameAnalytics).toHaveBeenCalledWith('g1');
  });

  it('does not refresh when no game is open', () => {
    render(<MathAnalyticsPane {...({} as never)} />);
    expect(openGameAnalytics).not.toHaveBeenCalled();
  });

  it('shows a loading state while runs are loading', () => {
    analyticsSlice().activeGameId.set('g1');
    analyticsSlice().loadStatus.set('loading');
    render(<MathAnalyticsPane {...({} as never)} />);
    expect(screen.getByTestId('analytics-loading')).toBeTruthy();
  });

  it('renders the Math Profile tab for the selected run once loaded', () => {
    analyticsSlice().activeGameId.set('g1');
    analyticsSlice().loadStatus.set('idle');
    analyticsSlice().runs.set([run('r1')]);
    analyticsSlice().selectedRunId.set('r1');
    render(<MathAnalyticsPane {...({} as never)} />);
    expect(screen.getByTestId('math-profile-tab')).toBeTruthy();
  });

  it('scaffolds a tab bar with the Math Profile tab active, Evolution selectable, Compare/Report still disabled', () => {
    analyticsSlice().activeGameId.set('g1');
    analyticsSlice().loadStatus.set('idle');
    analyticsSlice().runs.set([run('r1', [snapshot(0), snapshot(1)])]);
    analyticsSlice().selectedRunId.set('r1');
    analyticsSlice().frames.set([]); // populated separately by runLoaded/progressFrame; irrelevant to the tab-bar shape
    render(<MathAnalyticsPane {...({} as never)} />);
    const profileTabButton = screen.getByTestId('analytics-tab-profile');
    const evolutionTabButton = screen.getByTestId('analytics-tab-evolution');
    const compareTabButton = screen.getByTestId('analytics-tab-compare');
    expect(profileTabButton.getAttribute('aria-selected')).toBe('true');
    expect((evolutionTabButton as HTMLButtonElement).disabled).toBe(false);
    expect((compareTabButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches to the Evolution tab and renders it from the store-held frames', () => {
    analyticsSlice().activeGameId.set('g1');
    analyticsSlice().loadStatus.set('idle');
    analyticsSlice().runs.set([run('r1', [snapshot(0), snapshot(1)])]);
    analyticsSlice().selectedRunId.set('r1');
    analyticsSlice().frames.set([
      { generation: 0, best: { fitness: -0.1, rtp: 0.9, volatility: 2 }, population: snapshot(0).population, geneAgreement: [0.5, 0.6] },
      { generation: 1, best: { fitness: -0.05, rtp: 0.91, volatility: 2.1 }, population: snapshot(1).population, geneAgreement: [0.6, 0.7] },
    ]);
    analyticsSlice().selectedGeneration.set(1);
    render(<MathAnalyticsPane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('analytics-tab-evolution'));
    expect(screen.getByTestId('fitness-landscape')).toBeTruthy();
    expect(screen.getByTestId('gene-heatmap')).toBeTruthy();
    expect(screen.getByTestId('scrubber')).toBeTruthy();
  });

  it('dispatches scrub when the scrubber moves on the Evolution tab', () => {
    analyticsSlice().activeGameId.set('g1');
    analyticsSlice().loadStatus.set('idle');
    analyticsSlice().runs.set([run('r1', [snapshot(0), snapshot(1)])]);
    analyticsSlice().selectedRunId.set('r1');
    analyticsSlice().frames.set([
      { generation: 0, best: { fitness: -0.1, rtp: 0.9, volatility: 2 }, population: snapshot(0).population, geneAgreement: [0.5] },
      { generation: 1, best: { fitness: -0.05, rtp: 0.91, volatility: 2.1 }, population: snapshot(1).population, geneAgreement: [0.6] },
    ]);
    render(<MathAnalyticsPane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('analytics-tab-evolution'));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
    expect(scrub).toHaveBeenCalledWith(0);
  });
});
