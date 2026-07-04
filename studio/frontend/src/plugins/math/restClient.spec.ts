import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchRuns,
  fetchRun,
  getSlotModel,
  putCurationParams,
  curate,
  generate,
  getTuner,
  putTunerParams,
  applyTuned,
  getTarget,
  getGddDocs,
  putMathModelFields,
} from './restClient';

afterEach(() => vi.restoreAllMocks());

describe('math restClient', () => {
  it('fetchRuns GETs /analytics/runs for the game and returns typed runs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 'r1', gameId: 'g1' }] });
    vi.stubGlobal('fetch', fetchMock);
    const runs = await fetchRuns('g1');
    expect(runs).toEqual([{ id: 'r1', gameId: 'g1' }]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/analytics/runs');
    expect(url).toContain('game_id=g1');
  });

  it('fetchRuns forwards a limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    await fetchRuns('g1', 5);
    expect(String(fetchMock.mock.calls[0][0])).toContain('limit=5');
  });

  it('fetchRun GETs /analytics/runs/{id} and returns the typed run', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'r1', gameId: 'g1' }) });
    vi.stubGlobal('fetch', fetchMock);
    const run = await fetchRun('r1');
    expect(run.id).toBe('r1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/analytics/runs/r1');
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchRun('missing')).rejects.toThrow('404');
  });

  it('getSlotModel GETs /games/g1/slot-model and returns ISlotModelWire', async () => {
    const slotModel = { id: 'sm1', gameId: 'g1', model: {}, params: {}, locks: {}, result: null, updatedAt: '2026-01-01' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => slotModel });
    vi.stubGlobal('fetch', fetchMock);
    const result = await getSlotModel('g1');
    expect(result).toEqual(slotModel);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/games/g1/slot-model');
  });

  it('putCurationParams PUTs /games/g1/slot-model with params body', async () => {
    const slotModel = { id: 'sm1', gameId: 'g1', model: {}, params: {}, locks: {}, result: null, updatedAt: '2026-01-01' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => slotModel });
    vi.stubGlobal('fetch', fetchMock);
    const params = { poolSize: 100, candidateCount: 10, masterSeed: 42, rtpTolerance: 0.01, realizedCorrectionBand: 0.02, bonusRateTolerance: 0.05 };
    const result = await putCurationParams('g1', params);
    expect(result).toEqual(slotModel);
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/games/g1/slot-model');
    expect(call[1].method).toBe('PUT');
    expect(JSON.parse(call[1].body)).toEqual({ params });
  });

  it('curate POSTs /games/g1/slot-model/curate and returns void', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await curate('g1');
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/games/g1/slot-model/curate');
    expect(call[1].method).toBe('POST');
  });

  it('generate POSTs /games/g1/math/generate', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await generate('g1');
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/games/g1/math/generate');
    expect(call[1].method).toBe('POST');
  });

  it('generate throws with specific message on 409 conflict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(generate('g1')).rejects.toThrow('a run is already in progress');
  });

  it('getTuner GETs /games/g1/tuner and returns ITunerWire', async () => {
    const tuner = { id: 't1', gameId: 'g1', params: {}, result: null, updatedAt: '2026-01-01' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => tuner });
    vi.stubGlobal('fetch', fetchMock);
    const result = await getTuner('g1');
    expect(result).toEqual(tuner);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/games/g1/tuner');
  });

  it('putTunerParams PUTs /games/g1/tuner with params body', async () => {
    const tuner = { id: 't1', gameId: 'g1', params: {}, result: null, updatedAt: '2026-01-01' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => tuner });
    vi.stubGlobal('fetch', fetchMock);
    const params = {
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
    const result = await putTunerParams('g1', params);
    expect(result).toEqual(tuner);
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/games/g1/tuner');
    expect(call[1].method).toBe('PUT');
    expect(JSON.parse(call[1].body)).toEqual({ params });
  });

  it('applyTuned POSTs /games/g1/tuner/apply and returns ISlotModelWire', async () => {
    const slotModel = { id: 'sm1', gameId: 'g1', model: {}, params: {}, locks: {}, result: null, updatedAt: '2026-01-01' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => slotModel });
    vi.stubGlobal('fetch', fetchMock);
    const result = await applyTuned('g1');
    expect(result).toEqual(slotModel);
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/games/g1/tuner/apply');
    expect(call[1].method).toBe('POST');
  });

  it('getTarget GETs /games/g1/tuner/target and returns target with gap', async () => {
    const target = { gap: 'some gap message' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => target });
    vi.stubGlobal('fetch', fetchMock);
    const result = await getTarget('g1');
    expect(result).toEqual(target);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/games/g1/tuner/target');
  });

  it('getGddDocs GETs /games/g1/gdd/docs and returns IGddDocWire[]', async () => {
    const docs = [{ aspect: 'math-model', data: {}, updatedAt: '2026-01-01' }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => docs });
    vi.stubGlobal('fetch', fetchMock);
    const result = await getGddDocs('g1');
    expect(result).toEqual(docs);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/games/g1/gdd/docs');
  });

  it('putMathModelFields PUTs /games/g1/gdd/math-model with fields body and returns res.doc', async () => {
    const doc = { aspect: 'math-model', data: { rtp: '0.96' }, updatedAt: '2026-01-01' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ doc }) });
    vi.stubGlobal('fetch', fetchMock);
    const fields = { rtp: '0.96' };
    const result = await putMathModelFields('g1', fields);
    expect(result).toEqual(doc);
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/games/g1/gdd/math-model');
    expect(call[1].method).toBe('PUT');
    expect(JSON.parse(call[1].body)).toEqual({ fields });
  });
});
