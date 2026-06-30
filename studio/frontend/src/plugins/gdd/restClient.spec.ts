import { describe, it, expect, vi, afterEach } from 'vitest';
import { setGddFields } from './restClient';

afterEach(() => vi.restoreAllMocks());

describe('setGddFields', () => {
  it('PUTs fields to the gdd aspect endpoint and returns the parsed body', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ doc: { aspect: 'ui-ux', data: { orientation: 'portrait' } }, warnings: [], rebuilt: true }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const res = await setGddFields('g1', 'ui-ux', { orientation: 'portrait' });
    expect(res.rebuilt).toBe(true);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toMatch(/\/games\/g1\/gdd\/ui-ux$/);
    expect(init).toMatchObject({ method: 'PUT' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ fields: { orientation: 'portrait' } });
  });
});
