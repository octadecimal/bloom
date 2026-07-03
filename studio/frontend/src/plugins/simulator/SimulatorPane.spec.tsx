import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { SIMULATOR_PLUGIN_ID, makeInitialState, simulatorSlice } from './state';
import { SimulatorPane } from './SimulatorPane';

vi.mock('./actions', () => ({ openGameSim: vi.fn(), closeGameSim: vi.fn(), initSim: vi.fn() }));
vi.mock('./restClient', () => ({ putSlotModel: vi.fn(), curate: vi.fn(), getSlotModel: vi.fn(), getResult: vi.fn() }));

describe('SimulatorPane', () => {
  beforeEach(() => {
    rootStore.plugins.nested(SIMULATOR_PLUGIN_ID).set(makeInitialState() as never);
  });

  it('shows empty state with no active game', () => {
    render(<SimulatorPane {...({} as never)} />);
    expect(screen.getByTestId('simulator-no-game')).toBeTruthy();
  });

  it('shows a PASS badge when the result passed', () => {
    act(() => {
      simulatorSlice().activeGameId.set('g1');
      simulatorSlice().status.set('pass');
      simulatorSlice().result.set({
        status: 'pass',
        metrics: { rtp: 0.96, volatility: 4, hitFrequency: 0.3, baseRtp: 0.9, featureRtp: 0.06, bonusHitRates: [] },
        realizedRtp: 0.96,
        poolSize: 1000,
        failure: null,
        ranAt: 't',
      });
    });
    render(<SimulatorPane {...({} as never)} />);
    expect(screen.getByTestId('curation-status').textContent).toContain('PASS');
  });

  it('has no JSON textarea and offers the Game Config hint', () => {
    act(() => {
      simulatorSlice().activeGameId.set('g1');
    });
    render(<SimulatorPane {...({} as never)} />);
    expect(screen.queryByTestId('simulator-model-json')).toBeNull();
    expect(screen.getByTestId('open-game-config-hint')).toBeTruthy();
  });
});
