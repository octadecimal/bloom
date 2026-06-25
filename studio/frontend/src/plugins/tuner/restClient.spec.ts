import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTuner, tune, applyTuner } from './restClient';

afterEach(() => vi.restoreAllMocks());

describe('tuner restClient', () => {
  it('GETs the tuner doc', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ gameId: 'g1' }) });
    vi.stubGlobal('fetch', fetchMock);
    const doc = await getTuner('g1');
    expect(doc.gameId).toBe('g1');
    expect(fetchMock.mock.calls[0][0]).toContain('/games/g1/tuner');
  });

  it('POSTs tune without throwing on 202', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await expect(tune('g1')).resolves.toBeUndefined();
  });

  it('POSTs apply and returns the updated slot-model doc', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ model: { reels: [[0]] } }) });
    vi.stubGlobal('fetch', fetchMock);
    const out = await applyTuner('g1');
    expect(out.model).toEqual({ reels: [[0]] });
    expect(fetchMock.mock.calls[0][0]).toContain('/games/g1/tuner/apply');
  });
});
