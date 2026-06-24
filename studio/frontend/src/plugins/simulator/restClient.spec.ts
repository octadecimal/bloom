import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSlotModel, putSlotModel, curate } from './restClient';

describe('simulator restClient', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('GETs the slot model', async () => {
    const doc = { id: 'd1', gameId: 'g1', model: {}, params: {}, result: null };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(doc), { status: 200 })));
    const got = await getSlotModel('g1');
    expect(got.gameId).toBe('g1');
  });

  it('PUTs a model patch', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ gameId: 'g1', model: { reels: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await putSlotModel('g1', { model: { reels: [] } });
    const [, init] = spy.mock.calls[0];
    expect(init.method).toBe('PUT');
  });

  it('POSTs curate (202)', async () => {
    const spy = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', spy);
    await curate('g1');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('/games/g1/slot-model/curate');
    expect(init.method).toBe('POST');
  });
});
