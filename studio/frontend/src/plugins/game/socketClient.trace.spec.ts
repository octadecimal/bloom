import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState } from './state';

const bridgeSpy = { trace: vi.fn() };
vi.mock('./protocolBridge', () => ({
  getBridge: vi.fn(() => bridgeSpy),
}));

import { applySpinTrace, applySpinError } from './socketClient';

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeInitialState() as never);
  bridgeSpy.trace.mockClear();
});

describe('game socket spin trace/error', () => {
  it('applySpinTrace forwards the trace to the bridge and clears spinError', () => {
    gameSlice().activeGameId.set('g1');
    gameSlice().spinError.set('old');

    applySpinTrace({ gameId: 'g1', trace: [{ t: 'round_end', total_payout: 5 }] });

    expect(bridgeSpy.trace).toHaveBeenCalledWith([{ t: 'round_end', total_payout: 5 }]);
    expect(gameSlice().spinError.get()).toBeNull();
  });

  it('applySpinError sets spinError only for the active game', () => {
    gameSlice().activeGameId.set('g1');

    applySpinError({ gameId: 'other', message: 'nope' });
    expect(gameSlice().spinError.get()).toBeNull();

    applySpinError({ gameId: 'g1', message: 'runtime server unreachable' });
    expect(gameSlice().spinError.get()).toBe('runtime server unreachable');
  });
});
