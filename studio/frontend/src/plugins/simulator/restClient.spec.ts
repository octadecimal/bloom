import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSlotModel, putSlotModel, curate, getResult } from './restClient';

describe('simulator restClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs the slot model', async () => {
    const doc = { id: 'd1', gameId: 'g1', model: {}, params: {}, result: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(doc), { status: 200 })),
    );
    const got = await getSlotModel('g1');
    expect(got.gameId).toBe('g1');
  });

  it('PUTs a model patch', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ gameId: 'g1', model: { reels: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await putSlotModel('g1', { model: { reels: [] } });
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('/games/g1/slot-model');
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

  it('GETs the result', async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'pass',
            metrics: { rtp: 0.96, volatility: 2, hitFrequency: 0.5, baseRtp: 0.9, featureRtp: 0.06, bonusHitRates: [] },
            realizedRtp: 0.96,
            poolSize: 1000,
            failure: null,
            ranAt: 't',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', spy);
    const got = await getResult('g1');
    expect(got.status).toBe('pass');
    expect(String(spy.mock.calls[0][0])).toContain('/games/g1/slot-model/result');
  });
});
