import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from './state';
import type { ITuningParams, ITuneResult } from './state';

const getSlotModel = vi.fn();
const getTarget = vi.fn();
const getTuner = vi.fn();
vi.mock('./restClient', () => ({
  getSlotModel: (gameId: string) => getSlotModel(gameId),
  getTarget: (gameId: string) => getTarget(gameId),
  getTuner: (gameId: string) => getTuner(gameId),
}));

import { fieldsFromGddData, refreshTarget, refreshDoc, refreshTuneResult } from './sync';

function makeTuningParams(): ITuningParams {
  return {
    masterSeed: 42,
    population: 100,
    maxGenerations: 50,
    searchCandidateCount: 10,
    finalCandidateCount: 5,
    elitism: 2,
    mutationRate: 0.1,
    crossoverRate: 0.7,
    stagnationWindow: 10,
    weights: { rtp: 1, volatility: 1, hitRate: 1 },
  };
}

function makeTuneResult(): ITuneResult {
  return {
    status: 'pass',
    verdict: 'pass',
    tunedModel: {},
    metrics: null,
    missed: [],
    failure: null,
    ranAt: '2026-01-01',
  };
}

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  getSlotModel.mockReset();
  getTarget.mockReset();
  getTuner.mockReset();
});

describe('fieldsFromGddData', () => {
  it('maps math-model data to editable strings, tolerating missing keys and numbers', () => {
    expect(fieldsFromGddData({ rtp: 0.9, volatility: 'low' })).toEqual({ rtp: '0.9', volatility: 'low', bonusHitRate: '' });
    expect(fieldsFromGddData({})).toEqual({ rtp: '', volatility: '', bonusHitRate: '' });
    expect(fieldsFromGddData({ bonus_hit_rate: '1:150' }).bonusHitRate).toBe('1:150');
  });
});

describe('refreshTarget', () => {
  it('stores bands on target and clears the gap', async () => {
    mathSlice().activeGameId.set('g1');
    getTarget.mockResolvedValue({
      target: { rtp_target: 0.9, rtp_tolerance: 0.02, volatility_min: 0, volatility_max: 3, bonus_hit_rate_bands: [] },
    });
    await refreshTarget('g1');
    expect(mathSlice().derivedTarget.get({ noproxy: true })).toMatchObject({ rtp_target: 0.9 });
    expect(mathSlice().targetGap.get()).toBeNull();
  });

  it('stores a gap and drops responses for a game that is no longer active', async () => {
    mathSlice().activeGameId.set('g1');
    getTarget.mockResolvedValue({ gap: 'missing rtp' });
    await refreshTarget('g1');
    expect(mathSlice().targetGap.get()).toBe('missing rtp');
    mathSlice().activeGameId.set('g2');
    getTarget.mockResolvedValue({ gap: 'stale' });
    await refreshTarget('g1'); // resolves after the user switched games
    expect(mathSlice().targetGap.get()).toBe('missing rtp'); // unchanged
  });
});

describe('refreshDoc', () => {
  it('hydrates locks, curationParams and verifyResult from the doc', async () => {
    mathSlice().activeGameId.set('g1');
    const locks = { reels: true, paytable: false, bonus: false };
    const params = { poolSize: 100, candidateCount: 10, masterSeed: 42, rtpTolerance: 0.01, realizedCorrectionBand: 0.02, bonusRateTolerance: 0.05 };
    getSlotModel.mockResolvedValue({ id: 'sm1', gameId: 'g1', model: {}, params, locks, result: null, updatedAt: 't' });
    await refreshDoc('g1');
    expect(mathSlice().locks.get({ noproxy: true })).toEqual(locks);
    expect(mathSlice().curationParams.get({ noproxy: true })).toEqual(params);
  });

  it('drops responses for a game that is no longer active', async () => {
    mathSlice().activeGameId.set('g1');
    getSlotModel.mockResolvedValue({
      id: 'sm1',
      gameId: 'g1',
      model: {},
      params: {},
      locks: { reels: true, paytable: true, bonus: true },
      result: null,
      updatedAt: 't',
    });
    mathSlice().activeGameId.set('g2');
    await refreshDoc('g1');
    expect(mathSlice().locks.get()).toBeNull();
  });
});

describe('refreshTuneResult', () => {
  it('skips while a generate is streaming (genStatus tuning/verifying)', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().genStatus.set('tuning');
    await refreshTuneResult('g1');
    expect(getTuner).not.toHaveBeenCalled();
  });

  it('hydrates the pending tuned result when idle', async () => {
    mathSlice().activeGameId.set('g1');
    getTuner.mockResolvedValue({ id: 'd1', gameId: 'g1', params: makeTuningParams(), result: makeTuneResult(), updatedAt: 't1' });
    await refreshTuneResult('g1');
    expect(mathSlice().tuneResult.get({ noproxy: true })).not.toBeNull();
  });
});
