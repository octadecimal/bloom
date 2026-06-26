import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { TUNER_PLUGIN_ID, makeInitialState, tunerSlice, type ITunerJobDoc, type ITuneResult } from './state';

const getTuner = vi.fn();
vi.mock('./restClient', () => ({
  getTuner: (id: string) => getTuner(id),
  getTunerSeed: vi.fn(),
  getTunerTarget: vi.fn(),
}));
// Avoid pulling in the real socket.io client at module load.
vi.mock('./socketClient', () => ({
  tunerSock: () => ({ connect: vi.fn(), joinTuner: vi.fn(), leaveTuner: vi.fn() }),
}));

import { refreshTunerResult } from './actions';

const PASS_RESULT: ITuneResult = {
  status: 'pass',
  verdict: 'pass',
  tunedModel: { reels: [[0]] },
  metrics: null,
  missed: [],
  trace: [],
  failure: null,
  ranAt: 't',
};

function docWith(result: ITuneResult | null): ITunerJobDoc {
  return { id: 'd1', gameId: 'g1', params: {} as never, result };
}

beforeEach(() => {
  rootStore.plugins.nested(TUNER_PLUGIN_ID).set(makeInitialState() as never);
  tunerSlice().activeGameId.set('g1');
  getTuner.mockReset();
});

describe('refreshTunerResult', () => {
  it('hydrates a persisted tuned result so Apply can reflect an already-completed tune', async () => {
    getTuner.mockResolvedValue(docWith(PASS_RESULT));
    await refreshTunerResult('g1');
    expect(tunerSlice().result.get()?.tunedModel).toEqual({ reels: [[0]] });
    expect(tunerSlice().status.get()).toBe('pass');
  });

  it('does not clobber a live run that is streaming progress', async () => {
    tunerSlice().status.set('running');
    await refreshTunerResult('g1');
    expect(getTuner).not.toHaveBeenCalled();
    expect(tunerSlice().status.get()).toBe('running');
  });

  it('keeps existing state when the fetch fails', async () => {
    tunerSlice().result.set(PASS_RESULT);
    tunerSlice().status.set('pass');
    getTuner.mockRejectedValue(new Error('boom'));
    await refreshTunerResult('g1');
    expect(tunerSlice().result.get()?.tunedModel).toEqual({ reels: [[0]] });
    expect(tunerSlice().status.get()).toBe('pass');
  });
});
