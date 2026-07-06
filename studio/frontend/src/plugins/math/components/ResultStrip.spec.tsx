import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResultStrip } from './ResultStrip';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice, type IMathRun, type ITuneResult } from '../state';
import { rootStore } from '../../../state/rootStore';

const applyMath = vi.fn();
vi.mock('../actions', () => ({
  applyMath: () => applyMath(),
}));

function baseRun(overrides: Partial<IMathRun> = {}): IMathRun {
  return {
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
    metrics: { rtp: 0.9612, volatility: 3, hitFrequency: 0.3, baseRtp: 0.6, featureRtp: 0.3, bonusHitRates: [] },
    trace: [],
    profile: null,
    createdAt: '2026-01-01T00:00:00Z',
    durationMs: null,
    verify: null,
    locks: null,
    stopReason: null,
    attempts: null,
    loopStop: null,
    ...overrides,
  };
}

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  applyMath.mockReset();
});

describe('ResultStrip', () => {
  it('renders a placeholder dash when there is no outcome yet', () => {
    render(<ResultStrip />);
    expect(screen.getByTestId('result-verdict').textContent).toBe('—');
  });

  it('shows a FAIL badge for a run whose verify failed', () => {
    mathSlice().runs.set([
      baseRun({
        verify: { status: 'fail', metrics: baseRun().metrics!, realizedRtp: 0.9, poolSize: 100, failure: 'out of band', ranAt: '2026-01-02T00:00:00Z' },
      }),
    ]);
    render(<ResultStrip />);
    expect(screen.getByTestId('result-verdict').textContent).toBe('FAIL');
  });

  it('renders a locked-sections chip for a run with a locked bonus section', () => {
    mathSlice().runs.set([baseRun({ locks: { reels: false, paytable: false, bonus: true } })]);
    render(<ResultStrip />);
    expect(screen.getByTestId('result-lock-chips').textContent).toContain('locked: bonus');
  });

  it('omits the lock chip when no section is locked', () => {
    mathSlice().runs.set([baseRun({ locks: { reels: false, paytable: false, bonus: false } })]);
    render(<ResultStrip />);
    expect(screen.queryByTestId('result-lock-chips')).toBeNull();
  });

  it('disables Apply without a tuned model', () => {
    render(<ResultStrip />);
    expect((screen.getByTestId('apply-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Apply once tuneResult.tunedModel is set', () => {
    mathSlice().tuneResult.set({ status: 'pass', verdict: 'pass', tunedModel: { reels: [] }, metrics: null, missed: [], failure: null, ranAt: 't' });
    render(<ResultStrip />);
    expect((screen.getByTestId('apply-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls applyMath when Apply is clicked', () => {
    mathSlice().tuneResult.set({ status: 'pass', verdict: 'pass', tunedModel: { reels: [] }, metrics: null, missed: [], failure: null, ranAt: 't' });
    render(<ResultStrip />);
    fireEvent.click(screen.getByTestId('apply-button'));
    expect(applyMath).toHaveBeenCalled();
  });

  it('gives Apply warning styling when the outcome verdict is a fail', () => {
    mathSlice().tuneResult.set({ status: 'pass', verdict: 'pass', tunedModel: { reels: [] }, metrics: null, missed: [], failure: null, ranAt: 't' });
    mathSlice().runs.set([
      baseRun({ verify: { status: 'fail', metrics: baseRun().metrics!, realizedRtp: 0.9, poolSize: 100, failure: 'x', ranAt: '2026-01-02T00:00:00Z' } }),
    ]);
    render(<ResultStrip />);
    expect(screen.getByTestId('apply-button').className).toContain('warning');
  });

  it('shows math-applied once applied is true', () => {
    mathSlice().applied.set(true);
    render(<ResultStrip />);
    expect(screen.getByTestId('math-applied')).toBeTruthy();
  });

  it('does not show math-applied when applied is false', () => {
    render(<ResultStrip />);
    expect(screen.queryByTestId('math-applied')).toBeNull();
  });

  it('shows why the GA stopped, with the generation count', () => {
    const snap = (generation: number) => ({
      generation,
      bestFitness: -0.1,
      bestRtp: 0.9,
      bestVolatility: 3,
      population: { min: -1, q1: -0.7, median: -0.5, q3: -0.3, max: -0.1, mean: -0.5, diversity: 0.4 },
      geneAgreement: [1],
    });
    mathSlice().runs.set([baseRun({ verdict: 'near_miss', stopReason: 'stagnated', trace: [snap(0), snap(1), snap(2)] })]);
    render(<ResultStrip />);
    expect(screen.getByTestId('result-stop-reason').textContent).toBe('stagnated after 3 generations');
  });

  it('labels a feasible stop as target reached', () => {
    mathSlice().runs.set([baseRun({ stopReason: 'feasible' })]);
    render(<ResultStrip />);
    expect(screen.getByTestId('result-stop-reason').textContent).toContain('target reached');
  });

  it('omits the stop reason for runs that predate it', () => {
    mathSlice().runs.set([baseRun()]);
    render(<ResultStrip />);
    expect(screen.queryByTestId('result-stop-reason')).toBeNull();
  });

  it('shows the measured RTP with a target band derived from derivedTarget', () => {
    mathSlice().runs.set([baseRun()]);
    mathSlice().derivedTarget.set({ rtp_target: 0.96, rtp_tolerance: 0.005, volatility_min: 2, volatility_max: 4, bonus_hit_rate_bands: [] });
    render(<ResultStrip />);
    expect(screen.getByTestId('metric-rtp').textContent).toBe('0.9612');
    expect(screen.getByText(/band 0.955–0.965/)).toBeTruthy();
  });

  describe('in-flight state', () => {
    // A previous result rich enough that every hideable element would render.
    const staleRun = () =>
      baseRun({
        stopReason: 'feasible',
        locks: { reels: false, paytable: false, bonus: true },
      });
    const tunedResult = (): ITuneResult => ({
      status: 'pass',
      verdict: 'pass',
      tunedModel: { reels: [] },
      metrics: null,
      missed: [],
      failure: null,
      ranAt: 't',
    });

    it('shows RUNNING… and hides the previous result while genStatus is tuning', () => {
      mathSlice().runs.set([staleRun()]);
      mathSlice().applied.set(true);
      mathSlice().genStatus.set('tuning');
      render(<ResultStrip />);
      expect(screen.getByTestId('result-verdict').textContent).toBe('RUNNING…');
      expect(screen.queryByTestId('metric-rtp')).toBeNull();
      expect(screen.queryByTestId('result-stop-reason')).toBeNull();
      expect(screen.queryByTestId('result-lock-chips')).toBeNull();
      expect(screen.queryByTestId('math-applied')).toBeNull();
    });

    it('shows RUNNING… while genStatus is verifying', () => {
      mathSlice().runs.set([staleRun()]);
      mathSlice().genStatus.set('verifying');
      render(<ResultStrip />);
      expect(screen.getByTestId('result-verdict').textContent).toBe('RUNNING…');
    });

    it('shows CANCELLING… while genStatus is cancelling', () => {
      mathSlice().runs.set([staleRun()]);
      mathSlice().genStatus.set('cancelling');
      render(<ResultStrip />);
      expect(screen.getByTestId('result-verdict').textContent).toBe('CANCELLING…');
      expect(screen.queryByTestId('metric-rtp')).toBeNull();
    });

    it('shows RUNNING… while a verify-only curation is in flight', () => {
      mathSlice().runs.set([staleRun()]);
      mathSlice().verifyStatus.set('running');
      render(<ResultStrip />);
      expect(screen.getByTestId('result-verdict').textContent).toBe('RUNNING…');
      expect(screen.queryByTestId('metric-rtp')).toBeNull();
    });

    it('disables Apply during a verify-only run, even with a tuned model', () => {
      mathSlice().tuneResult.set(tunedResult());
      mathSlice().verifyStatus.set('running');
      render(<ResultStrip />);
      expect((screen.getByTestId('apply-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('disables Apply while cancelling, even with a tuned model', () => {
      mathSlice().tuneResult.set(tunedResult());
      mathSlice().genStatus.set('cancelling');
      render(<ResultStrip />);
      expect((screen.getByTestId('apply-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('reverts to the latest outcome once the run is done', () => {
      mathSlice().runs.set([staleRun()]);
      mathSlice().genStatus.set('done');
      render(<ResultStrip />);
      expect(screen.getByTestId('result-verdict').textContent).toBe('PASS');
      expect(screen.getByTestId('metric-rtp')).toBeTruthy();
      expect(screen.getByTestId('result-stop-reason')).toBeTruthy();
    });
  });

  describe('noise-aware SE display', () => {
    const seMetrics = () => ({
      rtp: 0.9819,
      volatility: 2.8,
      hitFrequency: 0.3,
      baseRtp: 0.6,
      featureRtp: 0.3819,
      bonusHitRates: [],
      se: { rtp: 0.0063, volatility: 0.0044, bonusHitRates: [] },
    });

    it('renders ±2·SE beside the measured RTP when se is present', () => {
      mathSlice().runs.set([baseRun({ metrics: seMetrics() })]);
      render(<ResultStrip />);
      expect(screen.getByTestId('metric-rtp').textContent).toBe('0.9819'); // stays Number()-parseable
      expect(screen.getByTestId('metric-rtp-se').textContent).toBe('±0.0126');
    });

    it('omits the ± cell for runs that predate se', () => {
      mathSlice().runs.set([baseRun()]);
      render(<ResultStrip />);
      expect(screen.getByTestId('metric-rtp-se').textContent).toBe('');
    });

    it('shows the within-noise chip when a pass measured outside the band', () => {
      mathSlice().runs.set([baseRun({ metrics: seMetrics(), verdict: 'pass' })]);
      mathSlice().derivedTarget.set({ rtp_target: 0.965, rtp_tolerance: 0.005, volatility_min: 0, volatility_max: 1e9, bonus_hit_rate_bands: [] });
      render(<ResultStrip />);
      expect(screen.getByTestId('within-noise').textContent).toBe('within noise');
      expect(screen.getByTestId('within-noise').title).toContain('2·SE');
    });

    it('omits the chip when the measurement is inside the band', () => {
      mathSlice().runs.set([baseRun({ metrics: { ...seMetrics(), rtp: 0.9612 } })]);
      mathSlice().derivedTarget.set({ rtp_target: 0.96, rtp_tolerance: 0.005, volatility_min: 0, volatility_max: 1e9, bonus_hit_rate_bands: [] });
      render(<ResultStrip />);
      expect(screen.queryByTestId('within-noise')).toBeNull();
    });

    it('omits the chip without se data, even outside the band', () => {
      mathSlice().runs.set([baseRun({ metrics: { ...seMetrics(), se: undefined } })]);
      mathSlice().derivedTarget.set({ rtp_target: 0.965, rtp_tolerance: 0.005, volatility_min: 0, volatility_max: 1e9, bonus_hit_rate_bands: [] });
      render(<ResultStrip />);
      expect(screen.queryByTestId('within-noise')).toBeNull();
    });
  });
});
