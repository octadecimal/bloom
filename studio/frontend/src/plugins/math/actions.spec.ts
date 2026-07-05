import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from './state';
import type { IMathRun, ISectionLocks, ICurationParams, ICurationResult, ITuningParams, ITuneResult, ITargetSpec } from './state';

const fetchRuns = vi.fn();
const getSlotModel = vi.fn();
const putCurationParams = vi.fn();
const curate = vi.fn();
const generate = vi.fn();
const cancelGenerateMock = vi.fn();
const getTuner = vi.fn();
const putTunerParams = vi.fn();
const applyTuned = vi.fn();
const getTarget = vi.fn();
const getGddDocs = vi.fn();
const putMathModelFields = vi.fn();

vi.mock('./restClient', () => ({
  fetchRuns: (gameId: string, limit?: number) => fetchRuns(gameId, limit),
  fetchRun: vi.fn(),
  getSlotModel: (gameId: string) => getSlotModel(gameId),
  putCurationParams: (gameId: string, params: unknown) => putCurationParams(gameId, params),
  curate: (gameId: string) => curate(gameId),
  generate: (gameId: string) => generate(gameId),
  cancelGenerate: (gameId: string) => cancelGenerateMock(gameId),
  getTuner: (gameId: string) => getTuner(gameId),
  putTunerParams: (gameId: string, params: unknown) => putTunerParams(gameId, params),
  applyTuned: (gameId: string) => applyTuned(gameId),
  getTarget: (gameId: string) => getTarget(gameId),
  getGddDocs: (gameId: string) => getGddDocs(gameId),
  putMathModelFields: (gameId: string, fields: unknown) => putMathModelFields(gameId, fields),
}));

// Avoid pulling in the real socket.io client at module load (mirrors the tuner
// plugin's actions.spec.ts).
const connect = vi.fn();
const joinMath = vi.fn();
const leaveMath = vi.fn();
vi.mock('./socketClient', () => ({
  mathSock: () => ({ connect, joinMath, leaveMath }),
}));

import { openGameMath, closeGameMath, editTargetField, flushTargetSave, TARGET_DEBOUNCE_MS, generateMath, verifyMath, applyMath, cancelMath } from './actions';

function run(id: string): IMathRun {
  return {
    id,
    gameId: 'g1',
    params: {} as never,
    verdict: 'pass',
    metrics: null,
    trace: [],
    profile: null,
    createdAt: 't',
    durationMs: null,
    verify: null,
    locks: null,
  };
}

const locksObj: ISectionLocks = { reels: false, paytable: true, bonus: false };
const curationParamsObj: ICurationParams = {
  poolSize: 10000,
  candidateCount: 200000,
  masterSeed: 1,
  rtpTolerance: 0.01,
  realizedCorrectionBand: 0.02,
  bonusRateTolerance: 0.01,
};
const verifyResultObj: ICurationResult = {
  status: 'pass',
  metrics: { rtp: 0.96, volatility: 3, hitFrequency: 0.3, baseRtp: 0.6, featureRtp: 0.36, bonusHitRates: [] },
  realizedRtp: 0.96,
  poolSize: 10000,
  failure: null,
  ranAt: 't1',
};
const tunerParamsObj: ITuningParams = {
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
};
const tuneResultObj: ITuneResult = {
  status: 'pass',
  verdict: 'pass',
  tunedModel: null,
  metrics: null,
  missed: [],
  failure: null,
  ranAt: 't2',
};
const targetSpecObj: ITargetSpec = {
  rtp_target: 0.96,
  rtp_tolerance: 0.01,
  volatility_min: 2,
  volatility_max: 4,
  bonus_hit_rate_bands: [{ min: 0.02, max: 0.06 }],
};

function mockOpenGameMathDeps() {
  getSlotModel.mockResolvedValue({ id: 'm1', gameId: 'g1', model: {}, params: curationParamsObj, locks: locksObj, result: verifyResultObj, updatedAt: 'u0' });
  getTuner.mockResolvedValue({ id: 't1', gameId: 'g1', params: tunerParamsObj, result: tuneResultObj, updatedAt: 'u0' });
  getGddDocs.mockResolvedValue([{ aspect: 'math-model', data: { rtp: '0.96', volatility: '3', bonus_hit_rate: '0.05' }, updatedAt: 'gdd1' }]);
  fetchRuns.mockResolvedValue([run('r2'), run('r1')]);
  getTarget.mockResolvedValue({ target: targetSpecObj, gap: 'gap text' });
}

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  fetchRuns.mockReset();
  getSlotModel.mockReset();
  putCurationParams.mockReset();
  curate.mockReset();
  generate.mockReset();
  cancelGenerateMock.mockReset();
  getTuner.mockReset();
  putTunerParams.mockReset();
  applyTuned.mockReset();
  getTarget.mockReset();
  getGddDocs.mockReset();
  putMathModelFields.mockReset();
  connect.mockReset();
  joinMath.mockReset();
  leaveMath.mockReset();
  getTarget.mockResolvedValue({});
});

describe('openGameMath', () => {
  it('hydrates locks/curationParams/verifyResult, tunerParams/tuneResult, targetFields+gddWatermark, runs, and target bands', async () => {
    mockOpenGameMathDeps();
    await openGameMath('g1');
    expect(mathSlice().activeGameId.get()).toBe('g1');
    expect(mathSlice().locks.get()).toEqual(locksObj);
    expect(mathSlice().curationParams.get()).toEqual(curationParamsObj);
    expect(mathSlice().verifyResult.get()).toEqual(verifyResultObj);
    expect(mathSlice().tunerParams.get()).toEqual(tunerParamsObj);
    expect(mathSlice().tuneResult.get()).toEqual(tuneResultObj);
    expect(mathSlice().targetFields.get()).toEqual({ rtp: '0.96', volatility: '3', bonusHitRate: '0.05' });
    expect(mathSlice().gddWatermark.get()).toBe('gdd1');
    expect(
      mathSlice()
        .runs.get()
        .map((r) => r.id),
    ).toEqual(['r2', 'r1']);
    expect(mathSlice().selectedRunId.get()).toBe('r2');
    expect(mathSlice().loadStatus.get()).toBe('idle');
    expect(mathSlice().derivedTarget.get()).toEqual(targetSpecObj);
    expect(mathSlice().targetGap.get()).toBe('gap text');
  });

  it('defaults targetFields to blank strings when no math-model GDD doc exists yet', async () => {
    mockOpenGameMathDeps();
    getGddDocs.mockResolvedValue([]);
    await openGameMath('g1');
    expect(mathSlice().targetFields.get()).toEqual({ rtp: '', volatility: '', bonusHitRate: '' });
    expect(mathSlice().gddWatermark.get()).toBe('');
  });

  it('sets loadStatus to error when the fetch fails', async () => {
    mockOpenGameMathDeps();
    fetchRuns.mockRejectedValue(new Error('boom'));
    await openGameMath('g1');
    expect(mathSlice().loadStatus.get()).toBe('error');
  });

  it('joins the analytics socket room for the game', async () => {
    mockOpenGameMathDeps();
    await openGameMath('g1');
    expect(joinMath).toHaveBeenCalledWith('g1');
  });
});

describe('closeGameMath', () => {
  it('resets the slice back to its initial state', async () => {
    mockOpenGameMathDeps();
    await openGameMath('g1');
    closeGameMath();
    expect(mathSlice().activeGameId.get()).toBeNull();
    expect(mathSlice().runs.get()).toEqual([]);
    expect(mathSlice().selectedRunId.get()).toBeNull();
  });

  it('leaves the analytics socket room for the previously-active game', async () => {
    mockOpenGameMathDeps();
    await openGameMath('g1');
    closeGameMath();
    expect(leaveMath).toHaveBeenCalledWith('g1');
  });

  it('does not emit leave when no game was active', () => {
    closeGameMath();
    expect(leaveMath).not.toHaveBeenCalled();
  });
});

describe('editTargetField / flushTargetSave (debounced GDD save)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mathSlice().activeGameId.set('g1');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks saving immediately, then debounces a single PUT with rtp+volatility, omitting an empty bonus_hit_rate', async () => {
    mathSlice().targetFields.set({ rtp: '95', volatility: '3.5', bonusHitRate: '' });
    putMathModelFields.mockResolvedValue({ aspect: 'math-model', data: {}, updatedAt: 'u2' });

    editTargetField('rtp', '96.5');
    expect(mathSlice().targetSaveStatus.get()).toBe('saving');
    expect(putMathModelFields).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TARGET_DEBOUNCE_MS);

    expect(putMathModelFields).toHaveBeenCalledTimes(1);
    expect(putMathModelFields).toHaveBeenCalledWith('g1', { rtp: '96.5', volatility: '3.5' });
    expect(mathSlice().gddWatermark.get()).toBe('u2');
    expect(mathSlice().targetSaveStatus.get()).toBe('saved');
  });

  it('includes bonus_hit_rate in the PUT payload when it is non-empty', async () => {
    mathSlice().targetFields.set({ rtp: '95', volatility: '3.5', bonusHitRate: '0.05' });
    putMathModelFields.mockResolvedValue({ aspect: 'math-model', data: {}, updatedAt: 'u3' });

    editTargetField('bonusHitRate', '0.06');
    await vi.advanceTimersByTimeAsync(TARGET_DEBOUNCE_MS);

    expect(putMathModelFields).toHaveBeenCalledWith('g1', { rtp: '95', volatility: '3.5', bonus_hit_rate: '0.06' });
  });

  it('coalesces two rapid edits into a single PUT carrying the latest value', async () => {
    mathSlice().targetFields.set({ rtp: '95', volatility: '3.5', bonusHitRate: '' });
    putMathModelFields.mockResolvedValue({ aspect: 'math-model', data: {}, updatedAt: 'u4' });

    editTargetField('rtp', '96');
    editTargetField('rtp', '96.5');
    await vi.advanceTimersByTimeAsync(TARGET_DEBOUNCE_MS);

    expect(putMathModelFields).toHaveBeenCalledTimes(1);
    expect(putMathModelFields).toHaveBeenCalledWith('g1', { rtp: '96.5', volatility: '3.5' });
  });

  it('sets targetSaveStatus to error when the PUT fails', async () => {
    mathSlice().targetFields.set({ rtp: '95', volatility: '3.5', bonusHitRate: '' });
    putMathModelFields.mockRejectedValue(new Error('boom'));

    editTargetField('rtp', '96.5');
    await vi.advanceTimersByTimeAsync(TARGET_DEBOUNCE_MS);

    expect(mathSlice().targetSaveStatus.get()).toBe('error');
  });

  it('flushTargetSave is a no-op when there is nothing to persist, but resets targetSaveStatus to idle', async () => {
    mathSlice().targetSaveStatus.set('saving');
    mathSlice().targetFields.set({ rtp: '', volatility: '', bonusHitRate: '' });
    await flushTargetSave();
    expect(putMathModelFields).not.toHaveBeenCalled();
    expect(mathSlice().targetSaveStatus.get()).toBe('idle');
  });

  it('does not mutate watermark/status if activeGameId changed while the PUT was pending', async () => {
    mathSlice().targetFields.set({ rtp: '95', volatility: '3.5', bonusHitRate: '' });
    let resolvePut!: (v: { aspect: string; data: unknown; updatedAt: string }) => void;
    putMathModelFields.mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );

    const flushed = flushTargetSave();
    mathSlice().activeGameId.set('g2');
    resolvePut({ aspect: 'math-model', data: {}, updatedAt: 'u-stale' });
    await flushed;

    expect(mathSlice().gddWatermark.get()).not.toBe('u-stale');
    expect(mathSlice().targetSaveStatus.get()).not.toBe('saved');
  });
});

describe('generateMath', () => {
  it('PUTs tuner params first, marks tuning + not applied, then calls generate', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().tunerParams.set(tunerParamsObj);
    mathSlice().applied.set(true);
    putTunerParams.mockResolvedValue({ id: 't1', gameId: 'g1', params: tunerParamsObj, result: null, updatedAt: 'u' });
    generate.mockResolvedValue(undefined);

    await generateMath();

    expect(putTunerParams).toHaveBeenCalledWith('g1', tunerParamsObj);
    expect(generate).toHaveBeenCalledWith('g1');
    expect(mathSlice().genStatus.get()).toBe('tuning');
    expect(mathSlice().applied.get()).toBe(false);
  });

  it('sets genStatus failed + genFailure when generate rejects', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().tunerParams.set(tunerParamsObj);
    putTunerParams.mockResolvedValue({ id: 't1', gameId: 'g1', params: tunerParamsObj, result: null, updatedAt: 'u' });
    generate.mockRejectedValue(new Error('a run is already in progress'));

    await generateMath();

    expect(mathSlice().genStatus.get()).toBe('failed');
    expect(mathSlice().genFailure.get()).toBe('a run is already in progress');
  });
});

describe('verifyMath', () => {
  it('PUTs curation params, marks running, then calls curate', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().curationParams.set(curationParamsObj);
    putCurationParams.mockResolvedValue({ id: 'm1', gameId: 'g1', model: {}, params: curationParamsObj, locks: locksObj, result: null, updatedAt: 'u' });
    curate.mockResolvedValue(undefined);

    await verifyMath();

    expect(putCurationParams).toHaveBeenCalledWith('g1', curationParamsObj);
    expect(curate).toHaveBeenCalledWith('g1');
    expect(mathSlice().verifyStatus.get()).toBe('running');
  });
});

describe('applyMath', () => {
  it('calls applyTuned and sets applied true', async () => {
    mathSlice().activeGameId.set('g1');
    applyTuned.mockResolvedValue({ id: 'm1', gameId: 'g1', model: {}, params: curationParamsObj, locks: locksObj, result: verifyResultObj, updatedAt: 'u' });

    await applyMath();

    expect(applyTuned).toHaveBeenCalledWith('g1');
    expect(mathSlice().applied.get()).toBe(true);
  });

  it('sets genFailure to apply failed when applyTuned rejects', async () => {
    mathSlice().activeGameId.set('g1');
    applyTuned.mockRejectedValue(new Error('boom'));

    await applyMath();

    expect(mathSlice().genFailure.get()).toBe('apply failed');
    expect(mathSlice().applied.get()).toBe(false);
  });
});

describe('cancelMath', () => {
  it('sets cancelling and leaves the rest to the socket event on accepted', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().genStatus.set('tuning');
    cancelGenerateMock.mockResolvedValue('accepted');
    await cancelMath();
    expect(mathSlice().genStatus.get()).toBe('cancelling');
  });

  it('self-heals to idle when the backend reports no active run (409)', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().genStatus.set('tuning'); // stuck UI
    cancelGenerateMock.mockResolvedValue('idle');
    await cancelMath();
    expect(mathSlice().genStatus.get()).toBe('idle');
    expect(mathSlice().genProgress.get()).toBeNull();
  });

  it('restores the prior status when the cancel POST itself fails', async () => {
    mathSlice().activeGameId.set('g1');
    mathSlice().genStatus.set('tuning');
    cancelGenerateMock.mockRejectedValue(new Error('network'));
    await cancelMath();
    expect(mathSlice().genStatus.get()).toBe('tuning');
  });
});
