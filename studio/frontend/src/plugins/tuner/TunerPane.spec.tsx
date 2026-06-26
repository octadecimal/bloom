import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TunerPane } from './TunerPane';
import { TUNER_PLUGIN_ID, makeInitialState, tunerSlice } from './state';
import { rootStore } from '../../state/rootStore';

const refreshTunerResult = vi.fn();
vi.mock('./actions', () => ({
  openGameTuner: vi.fn(),
  closeGameTuner: vi.fn(),
  initTuner: vi.fn(),
  refreshSeedAndTarget: vi.fn(),
  refreshTunerResult: (id: string) => refreshTunerResult(id),
}));
vi.mock('./restClient', () => ({ tune: vi.fn(), applyTuner: vi.fn(), putTuner: vi.fn() }));

beforeEach(() => {
  rootStore.plugins.nested(TUNER_PLUGIN_ID).set(makeInitialState() as never);
  tunerSlice().activeGameId.set(null);
  tunerSlice().status.set('idle');
  tunerSlice().result.set(null);
  refreshTunerResult.mockReset();
});

describe('TunerPane', () => {
  it('refreshes the persisted tuner result when the pane opens for a game (issue #82)', () => {
    tunerSlice().activeGameId.set('g1');
    render(<TunerPane {...({} as never)} />);
    expect(refreshTunerResult).toHaveBeenCalledWith('g1');
  });

  it('does not refresh when no game is open', () => {
    render(<TunerPane {...({} as never)} />);
    expect(refreshTunerResult).not.toHaveBeenCalled();
  });

  it('shows a no-game placeholder when no game is open', () => {
    render(<TunerPane {...({} as never)} />);
    expect(screen.getByTestId('tuner-no-game')).toBeTruthy();
  });

  it('shows the PASS verdict and enables apply when a tuned model exists', () => {
    tunerSlice().activeGameId.set('g1');
    tunerSlice().status.set('pass');
    tunerSlice().result.set({
      status: 'pass',
      verdict: 'pass',
      tunedModel: { reels: [[0]] },
      metrics: { rtp: 0.9, volatility: 2.0, hitFrequency: 0.4, baseRtp: 0.9, featureRtp: 0, bonusHitRates: [] },
      missed: [],
      trace: [],
      failure: null,
      ranAt: 't',
    });
    render(<TunerPane {...({} as never)} />);
    expect(screen.getByTestId('tuning-status').textContent).toContain('PASS');
    expect((screen.getByTestId('apply-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('lists missed bands on near-miss', () => {
    tunerSlice().activeGameId.set('g1');
    tunerSlice().status.set('near_miss');
    tunerSlice().result.set({
      status: 'near_miss',
      verdict: 'near_miss',
      tunedModel: { reels: [[0]] },
      metrics: { rtp: 0.8, volatility: 2.0, hitFrequency: 0.4, baseRtp: 0.8, featureRtp: 0, bonusHitRates: [] },
      missed: [{ metric: 'rtp', measured: 0.8, bandLo: 0.89, bandHi: 0.91 }],
      trace: [],
      failure: null,
      ranAt: 't',
    });
    render(<TunerPane {...({} as never)} />);
    expect(screen.getByTestId('tuner-missed').textContent).toContain('rtp');
  });
});
