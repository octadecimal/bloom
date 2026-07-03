import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSlotModel, putSlotModel } from './restClient';
import { BACKEND_URL } from './config';

const okResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe('game-config restClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getSlotModel GETs the doc', async () => {
    const doc = { id: 'd1', gameId: 'g1', model: {}, updatedAt: 't1' };
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(doc));
    expect(await getSlotModel('g1')).toEqual(doc);
    expect(spy).toHaveBeenCalledWith(`${BACKEND_URL}/games/g1/slot-model`);
  });

  it('putSlotModel PUTs only the provided fields plus source', async () => {
    const doc = { id: 'd1', gameId: 'g1', model: { rows: 3 }, updatedAt: 't2' };
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(doc));
    await putSlotModel('g1', { presentation: { symbols: {} }, source: 'editor' });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BACKEND_URL}/games/g1/slot-model`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ presentation: { symbols: {} }, source: 'editor' });
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
    await expect(getSlotModel('g1')).rejects.toThrow('request failed: 500');
  });
});
