import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { MATH_PLUGIN_ID, makeInitialState, mathSlice } from './state';
import type { IMathRun } from './state';

const handlers: Record<string, (p: unknown) => void> = {};
const emit = vi.fn();
const disconnect = vi.fn();
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (event: string, cb: (p: unknown) => void) => {
      handlers[event] = cb;
    },
    emit,
    disconnect,
  }),
}));

// sync.ts's refresh helpers run for real (end-state assertions); only their fetches are mocked.
const getSlotModel = vi.fn();
const getTarget = vi.fn();
const getTuner = vi.fn();
const getComposedMathDoc = vi.fn();
vi.mock('./restClient', () => ({
  getSlotModel: (gameId: string) => getSlotModel(gameId),
  getTarget: (gameId: string) => getTarget(gameId),
  getTuner: (gameId: string) => getTuner(gameId),
  getComposedMathDoc: (gameId: string) => getComposedMathDoc(gameId),
}));

import { createMathSocket } from './socketClient';

function run(id: string): IMathRun {
  return {
    id,
    gameId: 'g1',
    params: {} as never,
    verdict: 'pass',
    metrics: null,
    trace: [
      {
        generation: 0,
        bestFitness: -0.2,
        bestRtp: 0.9,
        bestVolatility: 2,
        population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.4 },
        geneAgreement: [0.5, 0.6],
      },
    ],
    profile: null,
    createdAt: 't',
    durationMs: null,
    verify: null,
    locks: null,
  };
}

beforeEach(() => {
  rootStore.plugins.nested(MATH_PLUGIN_ID).set(makeInitialState() as never);
  createMathSocket().disconnect(); // reset module-level sock so connect() re-registers handlers
  for (const k of Object.keys(handlers)) delete handlers[k];
  emit.mockReset();
  disconnect.mockReset();
  getSlotModel.mockReset().mockRejectedValue(new Error('not stubbed'));
  getTarget.mockReset().mockRejectedValue(new Error('not stubbed'));
  getTuner.mockReset().mockRejectedValue(new Error('not stubbed'));
  getComposedMathDoc.mockReset().mockRejectedValue(new Error('not stubbed'));
  mathSlice().activeGameId.set('g1');
});

describe('math socketClient', () => {
  it('appends a live frame for the active game on analytics_progress', () => {
    createMathSocket().connect();
    handlers['analytics_progress']({
      gameId: 'g1',
      generation: 3,
      maxGenerations: 40,
      best: { fitness: -0.1, rtp: 0.91, volatility: 2.1 },
      population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.3 },
      geneAgreement: [0.4, 0.5],
    });
    const frames = mathSlice().frames.get();
    expect(frames).toHaveLength(1);
    expect(frames[0].generation).toBe(3);
    expect(frames[0].best.rtp).toBe(0.91);
  });

  it('ignores analytics_progress for other games', () => {
    createMathSocket().connect();
    handlers['analytics_progress']({
      gameId: 'other',
      generation: 1,
      maxGenerations: 40,
      best: { fitness: 0, rtp: 0, volatility: 0 },
      population: { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0, diversity: 0 },
      geneAgreement: [],
    });
    expect(mathSlice().frames.get()).toEqual([]);
  });

  it('freezes and stores the run for the active game on run_complete', () => {
    createMathSocket().connect();
    handlers['run_complete']({ gameId: 'g1', run: run('r1') });
    expect(
      mathSlice()
        .runs.get()
        .map((r) => r.id),
    ).toEqual(['r1']);
    expect(mathSlice().frames.get()).toHaveLength(1);
    expect(mathSlice().selectedGeneration.get()).toBe(0);
  });

  it('ignores run_complete for other games', () => {
    createMathSocket().connect();
    handlers['run_complete']({ gameId: 'other', run: run('r1') });
    expect(mathSlice().runs.get()).toEqual([]);
  });

  it('joinMath/leaveMath emit the room events', () => {
    const sock = createMathSocket();
    sock.connect();
    sock.joinMath('g1');
    sock.leaveMath('g1');
    expect(emit).toHaveBeenCalledWith('join_analytics', { gameId: 'g1' });
    expect(emit).toHaveBeenCalledWith('leave_analytics', { gameId: 'g1' });
  });

  it('analytics_progress also sets genProgress', () => {
    createMathSocket().connect();
    handlers['analytics_progress']({
      gameId: 'g1',
      generation: 3,
      maxGenerations: 40,
      best: { fitness: -0.1, rtp: 0.91, volatility: 2.1 },
      population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.3 },
      geneAgreement: [0.4, 0.5],
    });
    expect(mathSlice().genProgress.get()).toEqual({ generation: 3, maxGenerations: 40 });
  });
});

describe('generate_status', () => {
  it('phase tuning resets frames/genFailure/applied and sets genStatus', () => {
    createMathSocket().connect();
    mathSlice().frames.set([
      {
        generation: 0,
        best: { fitness: 0, rtp: 0, volatility: 0 },
        population: { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0, diversity: 0 },
        geneAgreement: [],
      },
    ]);
    mathSlice().genFailure.set('old failure');
    mathSlice().applied.set(true);
    mathSlice().selectedGeneration.set(5);
    handlers['generate_status']({ gameId: 'g1', phase: 'tuning' });
    expect(mathSlice().genStatus.get()).toBe('tuning');
    expect(mathSlice().frames.get()).toEqual([]);
    expect(mathSlice().genFailure.get()).toBeNull();
    expect(mathSlice().applied.get()).toBe(false);
    expect(mathSlice().selectedGeneration.get()).toBe('live');
  });

  it('phase failed just sets genStatus', () => {
    createMathSocket().connect();
    handlers['generate_status']({ gameId: 'g1', phase: 'failed' });
    expect(mathSlice().genStatus.get()).toBe('failed');
  });

  it('phase done just sets genStatus', () => {
    createMathSocket().connect();
    handlers['generate_status']({ gameId: 'g1', phase: 'done' });
    expect(mathSlice().genStatus.get()).toBe('done');
  });

  it('phase done refreshes verdictStale from the slot-model doc (tune completion emits no slot_model_changed)', async () => {
    createMathSocket().connect();
    mathSlice().verdictStale.set(true); // stale from an earlier target/model edit
    getSlotModel.mockResolvedValue({
      id: 'sm1',
      gameId: 'g1',
      model: {},
      params: { poolSize: 100, candidateCount: 10, masterSeed: 42, rtpTolerance: 0.01, realizedCorrectionBand: 0.02, bonusRateTolerance: 0.05 },
      locks: { reels: false, paytable: false, bonus: false },
      result: null,
      updatedAt: 't',
      verdictStale: false, // backend cleared the flag when it saved the tune result
    });
    handlers['generate_status']({ gameId: 'g1', phase: 'done' });
    await vi.waitFor(() => expect(mathSlice().verdictStale.get()).toBe(false));
  });

  it('generate_status cancelled resets progress and sets genStatus', () => {
    createMathSocket().connect();
    mathSlice().genStatus.set('cancelling');
    mathSlice().genProgress.set({ generation: 3, maxGenerations: 40 });
    handlers['generate_status']({ gameId: 'g1', phase: 'cancelled' });
    expect(mathSlice().genStatus.get()).toBe('cancelled');
    expect(mathSlice().genProgress.get()).toBeNull();
  });

  it('ignores events for a non-active game', () => {
    createMathSocket().connect();
    handlers['generate_status']({ gameId: 'other', phase: 'tuning' });
    expect(mathSlice().genStatus.get()).toBe('idle');
  });
});

describe('tuning_failed', () => {
  it('sets genFailure', () => {
    createMathSocket().connect();
    handlers['tuning_failed']({ gameId: 'g1', failure: 'boom' });
    expect(mathSlice().genFailure.get()).toBe('boom');
  });

  it('defaults the message when none is given', () => {
    createMathSocket().connect();
    handlers['tuning_failed']({ gameId: 'g1' });
    expect(mathSlice().genFailure.get()).toBe('tune failed');
  });

  it('ignores events for a non-active game', () => {
    createMathSocket().connect();
    handlers['tuning_failed']({ gameId: 'other', failure: 'boom' });
    expect(mathSlice().genFailure.get()).toBeNull();
  });
});

describe('curation_progress/complete/failed', () => {
  it('curation_progress drives verifyStatus/verifyProgress and clears verifyFailure', () => {
    createMathSocket().connect();
    mathSlice().verifyFailure.set('old');
    handlers['curation_progress']({ gameId: 'g1', phase: 'evaluating', done: 3, total: 10 });
    expect(mathSlice().verifyStatus.get()).toBe('running');
    expect(mathSlice().verifyProgress.get()).toEqual({ phase: 'evaluating', done: 3, total: 10 });
    expect(mathSlice().verifyFailure.get()).toBeNull();
  });

  it('curation_complete drives verifyResult/verifyStatus and refreshes locks/curationParams from p.doc', () => {
    createMathSocket().connect();
    const result = { status: 'pass' as const, metrics: {} as never, realizedRtp: 0.9, poolSize: 1000, failure: null, ranAt: 't' };
    const locks = { reels: true, paytable: false, bonus: false };
    const params = { poolSize: 100, candidateCount: 10, masterSeed: 42, rtpTolerance: 0.01, realizedCorrectionBand: 0.02, bonusRateTolerance: 0.05 };
    handlers['curation_complete']({
      gameId: 'g1',
      doc: { id: 'sm1', gameId: 'g1', model: {}, params, locks, result, updatedAt: 't', verdictStale: false },
    });
    expect(mathSlice().verifyResult.get({ noproxy: true })).toEqual(result);
    expect(mathSlice().verifyStatus.get()).toBe('pass');
    expect(mathSlice().verifyProgress.get()).toBeNull();
    expect(mathSlice().locks.get({ noproxy: true })).toEqual(locks);
    expect(mathSlice().curationParams.get({ noproxy: true })).toEqual(params);
    expect(mathSlice().verdictStale.get()).toBe(false);
  });

  it('curation_complete falls back to idle verifyStatus when result is null', () => {
    createMathSocket().connect();
    const locks = { reels: false, paytable: false, bonus: false };
    const params = { poolSize: 100, candidateCount: 10, masterSeed: 42, rtpTolerance: 0.01, realizedCorrectionBand: 0.02, bonusRateTolerance: 0.05 };
    handlers['curation_complete']({
      gameId: 'g1',
      doc: { id: 'sm1', gameId: 'g1', model: {}, params, locks, result: null, updatedAt: 't' },
    });
    expect(mathSlice().verifyStatus.get()).toBe('idle');
  });

  it('curation_failed sets verifyStatus error and verifyFailure', () => {
    createMathSocket().connect();
    handlers['curation_failed']({ gameId: 'g1', failure: 'bad seed' });
    expect(mathSlice().verifyStatus.get()).toBe('error');
    expect(mathSlice().verifyProgress.get()).toBeNull();
    expect(mathSlice().verifyFailure.get()).toBe('bad seed');
  });

  it('ignores curation events for a non-active game', () => {
    createMathSocket().connect();
    handlers['curation_progress']({ gameId: 'other', phase: 'evaluating', done: 1, total: 10 });
    expect(mathSlice().verifyStatus.get()).toBe('idle');
  });
});

describe('gdd_doc_updated', () => {
  it('newer math-model doc updates targetFields + watermark', () => {
    createMathSocket().connect();
    handlers['gdd_doc_updated']({
      gameId: 'g1',
      doc: { aspect: 'math-model', data: { rtp: 0.95, volatility: 'high' }, updatedAt: '2026-01-02' },
    });
    expect(mathSlice().targetFields.get({ noproxy: true })).toEqual({ rtp: '0.95', volatility: 'high', bonusHitRate: '' });
    expect(mathSlice().gddWatermark.get()).toBe('2026-01-02');
  });

  it('ignores a stale doc (updatedAt <= gddWatermark)', () => {
    createMathSocket().connect();
    mathSlice().gddWatermark.set('2026-01-02');
    mathSlice().targetFields.set({ rtp: 'kept', volatility: 'kept', bonusHitRate: 'kept' });
    handlers['gdd_doc_updated']({
      gameId: 'g1',
      doc: { aspect: 'math-model', data: { rtp: 0.5 }, updatedAt: '2026-01-02' },
    });
    expect(mathSlice().targetFields.get({ noproxy: true })).toEqual({ rtp: 'kept', volatility: 'kept', bonusHitRate: 'kept' });
  });

  it('ignores a non math-model aspect', () => {
    createMathSocket().connect();
    handlers['gdd_doc_updated']({
      gameId: 'g1',
      doc: { aspect: 'theme', data: { rtp: 0.5 }, updatedAt: '2026-01-02' },
    });
    expect(mathSlice().targetFields.get()).toBeNull();
  });

  it('ignores events for a non-active game', () => {
    createMathSocket().connect();
    handlers['gdd_doc_updated']({
      gameId: 'other',
      doc: { aspect: 'math-model', data: { rtp: 0.5 }, updatedAt: '2026-01-02' },
    });
    expect(mathSlice().targetFields.get()).toBeNull();
  });
});

describe('game_definition_changed', () => {
  it('refreshes doc + target for the active composed@1 game', async () => {
    mathSlice().family.set('composed@1');
    createMathSocket().connect();
    const locks = { reels: true, paytable: false, bonus: false };
    const params = { poolSize: 100, candidateCount: 10, masterSeed: 42, rtpTolerance: 0.01, realizedCorrectionBand: 0.02, bonusRateTolerance: 0.05 };
    getComposedMathDoc.mockResolvedValue({
      id: 'x',
      gameId: 'g1',
      definition: { states: [{ id: 'base' }] },
      params,
      locks,
      result: null,
      verdictStale: false,
      updatedAt: 't',
    });
    getTarget.mockResolvedValue({ target: { rtp_target: 0.9, rtp_tolerance: 0.02, volatility_min: 0, volatility_max: 3, bonus_hit_rate_bands: [] } });
    handlers['game_definition_changed']({ gameId: 'g1', updatedAt: 't', source: 'agent' });
    await vi.waitFor(() => expect(mathSlice().locks.get({ noproxy: true })).toEqual(locks));
    expect(mathSlice().derivedTarget.get({ noproxy: true })).toMatchObject({ rtp_target: 0.9 });
  });

  it('ignores the event when the game is not composed@1', () => {
    mathSlice().family.set('slots@1');
    createMathSocket().connect();
    handlers['game_definition_changed']({ gameId: 'g1', updatedAt: 't', source: 'agent' });
    expect(getComposedMathDoc).not.toHaveBeenCalled();
  });

  it('ignores events for a non-active game', () => {
    mathSlice().family.set('composed@1');
    createMathSocket().connect();
    handlers['game_definition_changed']({ gameId: 'other', updatedAt: 't', source: 'agent' });
    expect(getComposedMathDoc).not.toHaveBeenCalled();
  });
});
