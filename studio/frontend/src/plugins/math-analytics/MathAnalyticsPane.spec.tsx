import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MathAnalyticsPane } from './MathAnalyticsPane';
import { MATH_ANALYTICS_PLUGIN_ID, makeInitialState, analyticsSlice } from './state';
import { rootStore } from '../../state/rootStore';
import type { IMathRun } from './state';

vi.mock('./charts/UPlotChart', () => ({
  UPlotChart: ({ className }: { className?: string }) => <div data-testid="uplot-chart-stub" className={className} />,
}));

function run(id: string): IMathRun {
  return {
    id,
    gameId: 'g1',
    params: {} as never,
    verdict: 'pass',
    metrics: { rtp: 0.9, volatility: 3, hitFrequency: 0.3, baseRtp: 0.6, featureRtp: 0.3, bonusHitRates: [] },
    trace: [],
    profile: {
      distribution: { bins: [], zeroCount: 10 },
      tail: { maxWin: 100, pGE100x: 0.01, pLosingSpin: 0.5, longestDeadStreak: 5, bonusTriggerRate: 0.02 },
      rtpConvergence: [{ n: 100, realizedRtp: 0.9 }],
    },
    createdAt: 't',
    durationMs: null,
  };
}

beforeEach(() => {
  rootStore.plugins.nested(MATH_ANALYTICS_PLUGIN_ID).set(makeInitialState() as never);
});

describe('MathAnalyticsPane', () => {
  it('shows a no-game placeholder when no game is open', () => {
    render(<MathAnalyticsPane {...({} as never)} />);
    expect(screen.getByTestId('analytics-no-game')).toBeTruthy();
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

  it('scaffolds a tab bar with the Math Profile tab active and other tabs disabled', () => {
    analyticsSlice().activeGameId.set('g1');
    analyticsSlice().loadStatus.set('idle');
    analyticsSlice().runs.set([run('r1')]);
    analyticsSlice().selectedRunId.set('r1');
    render(<MathAnalyticsPane {...({} as never)} />);
    const profileTabButton = screen.getByTestId('analytics-tab-profile');
    const evolutionTabButton = screen.getByTestId('analytics-tab-evolution');
    expect(profileTabButton.getAttribute('aria-selected')).toBe('true');
    expect((evolutionTabButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(evolutionTabButton);
    expect(screen.getByTestId('math-profile-tab')).toBeTruthy(); // disabled tab: no-op
  });
});
