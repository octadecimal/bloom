import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MathPane } from './MathPane';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from './state';
import { rootStore } from '../../state/rootStore';
import type { IMathRun } from './state';

vi.mock('./charts/UPlotChart', () => ({
  UPlotChart: ({ className }: { className?: string }) => <div data-testid="uplot-chart-stub" className={className} />,
}));

const exportReport = vi.fn();
vi.mock('./lib/exportReport', () => ({
  exportReport: (el: HTMLElement, format: 'pdf' | 'png') => exportReport(el, format),
}));

const openGameMath = vi.fn();
const scrub = vi.fn();
const toggleRunSelected = vi.fn();
vi.mock('./actions', () => ({
  openGameMath: (id: string) => openGameMath(id),
  closeGameMath: vi.fn(),
  initMath: vi.fn(),
  selectRun: vi.fn(),
  scrub: (n: number) => scrub(n),
  toggleRunSelected: (id: string) => toggleRunSelected(id),
}));

function run(id: string, trace: IMathRun['trace'] = []): IMathRun {
  return {
    id,
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
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  openGameMath.mockReset();
  // jsdom has no createObjectURL/revokeObjectURL by default — the Report tab's
  // export-and-download path needs both.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:mock');
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
});

describe('MathPane', () => {
  it('shows a no-game placeholder when no game is open', () => {
    render(<MathPane {...({} as never)} />);
    expect(screen.getByTestId('math-no-game')).toBeTruthy();
  });

  it('refreshes the run history when the pane opens for a game (mirrors tuner issue #82)', () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().loadStatus.set('idle');
    render(<MathPane {...({} as never)} />);
    expect(openGameMath).toHaveBeenCalledWith('g1');
  });

  it('does not refresh when no game is open', () => {
    render(<MathPane {...({} as never)} />);
    expect(openGameMath).not.toHaveBeenCalled();
  });

  it('shows a loading state while runs are loading', () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().loadStatus.set('loading');
    render(<MathPane {...({} as never)} />);
    expect(screen.getByTestId('analytics-loading')).toBeTruthy();
  });

  it('renders the Math Profile tab for the selected run once loaded', () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().loadStatus.set('idle');
    mathSlice().runs.set([run('r1')]);
    mathSlice().selectedRunId.set('r1');
    render(<MathPane {...({} as never)} />);
    expect(screen.getByTestId('math-profile-tab')).toBeTruthy();
  });

  it('scaffolds a tab bar with the Math Profile tab active and Evolution/Compare/Report all selectable', () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().loadStatus.set('idle');
    mathSlice().runs.set([run('r1', [snapshot(0), snapshot(1)])]);
    mathSlice().selectedRunId.set('r1');
    mathSlice().frames.set([]); // populated separately by runLoaded/progressFrame; irrelevant to the tab-bar shape
    render(<MathPane {...({} as never)} />);
    const profileTabButton = screen.getByTestId('analytics-tab-profile');
    const evolutionTabButton = screen.getByTestId('analytics-tab-evolution');
    const compareTabButton = screen.getByTestId('analytics-tab-compare');
    const reportTabButton = screen.getByTestId('analytics-tab-report');
    expect(profileTabButton.getAttribute('aria-selected')).toBe('true');
    expect((evolutionTabButton as HTMLButtonElement).disabled).toBe(false);
    expect((compareTabButton as HTMLButtonElement).disabled).toBe(false);
    expect((reportTabButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('switches to the Report tab and renders the stacked document for the selected run', () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().loadStatus.set('idle');
    mathSlice().runs.set([run('r1')]);
    mathSlice().selectedRunId.set('r1');
    render(<MathPane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('analytics-tab-report'));
    expect(screen.getByTestId('report-tab')).toBeTruthy();
    expect(screen.getByTestId('report-summary')).toBeTruthy();
    expect(screen.getByTestId('report-config')).toBeTruthy();
  });

  it('dispatches exportReport when Export is clicked on the Report tab', async () => {
    exportReport.mockReset();
    exportReport.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    mathSlice().activeGameId.set('g1');
    mathSlice().loadStatus.set('idle');
    mathSlice().runs.set([run('r1')]);
    mathSlice().selectedRunId.set('r1');
    render(<MathPane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('analytics-tab-report'));
    fireEvent.click(screen.getByTestId('export-button'));
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
  });

  it('switches to the Compare tab and renders it over the store-held run history and selection', () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().loadStatus.set('idle');
    mathSlice().runs.set([run('r1'), run('r2')]);
    mathSlice().selectedRunId.set('r1');
    mathSlice().selectedRunIds.set(['r1', 'r2']);
    render(<MathPane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('analytics-tab-compare'));
    expect(screen.getByTestId('compare-tab')).toBeTruthy();
    expect(screen.getByTestId('compare-rtp-overlay')).toBeTruthy();
    expect(screen.getByTestId('compare-vol-overlay')).toBeTruthy();
    expect(screen.getByTestId('delta-table')).toBeTruthy();
    expect(screen.getByTestId('delta-col-r1')).toBeTruthy();
    expect(screen.getByTestId('delta-col-r2')).toBeTruthy();
  });

  it('dispatches toggleRunSelected when a run row is clicked in the Compare tab', () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().loadStatus.set('idle');
    mathSlice().runs.set([run('r1'), run('r2')]);
    mathSlice().selectedRunId.set('r1');
    mathSlice().selectedRunIds.set(['r1']);
    render(<MathPane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('analytics-tab-compare'));
    fireEvent.click(screen.getByTestId('run-selector-row-r2'));
    expect(toggleRunSelected).toHaveBeenCalledWith('r2');
  });

  it('switches to the Evolution tab and renders it from the store-held frames', () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().loadStatus.set('idle');
    mathSlice().runs.set([run('r1', [snapshot(0), snapshot(1)])]);
    mathSlice().selectedRunId.set('r1');
    mathSlice().frames.set([
      { generation: 0, best: { fitness: -0.1, rtp: 0.9, volatility: 2 }, population: snapshot(0).population, geneAgreement: [0.5, 0.6] },
      { generation: 1, best: { fitness: -0.05, rtp: 0.91, volatility: 2.1 }, population: snapshot(1).population, geneAgreement: [0.6, 0.7] },
    ]);
    mathSlice().selectedGeneration.set(1);
    render(<MathPane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('analytics-tab-evolution'));
    expect(screen.getByTestId('fitness-landscape')).toBeTruthy();
    expect(screen.getByTestId('gene-heatmap')).toBeTruthy();
    expect(screen.getByTestId('scrubber')).toBeTruthy();
  });

  it('dispatches scrub when the scrubber moves on the Evolution tab', () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().loadStatus.set('idle');
    mathSlice().runs.set([run('r1', [snapshot(0), snapshot(1)])]);
    mathSlice().selectedRunId.set('r1');
    mathSlice().frames.set([
      { generation: 0, best: { fitness: -0.1, rtp: 0.9, volatility: 2 }, population: snapshot(0).population, geneAgreement: [0.5] },
      { generation: 1, best: { fitness: -0.05, rtp: 0.91, volatility: 2.1 }, population: snapshot(1).population, geneAgreement: [0.6] },
    ]);
    render(<MathPane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('analytics-tab-evolution'));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
    expect(scrub).toHaveBeenCalledWith(0);
  });
});
