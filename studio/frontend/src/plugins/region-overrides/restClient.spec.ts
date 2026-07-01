import { describe, it, expect, vi, afterEach } from 'vitest';
import { putOverride, getOverrides } from './restClient';

afterEach(() => vi.restoreAllMocks());

describe('region-overrides restClient', () => {
  it('PUTs a role override and returns the parsed body', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ rebuilt: true }) })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const res = await putOverride('g1', 'reels', { x: 100 });
    expect(res.rebuilt).toBe(true);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toMatch(/\/games\/g1\/scene\/overrides\/reels$/);
    expect(init).toMatchObject({ method: 'PUT' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ x: 100 });
  });

  it('GETs the override view', async () => {
    const view = { canvas: [1280, 720], plan: { reels: { x: 640, y: 396, region_w: 794, region_h: 432, anchor_x: 0.5, anchor_y: 0.5 } }, overrides: {} };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => view })) as unknown as typeof fetch);
    expect((await getOverrides('g1')).plan.reels.region_w).toBe(794);
  });
});
