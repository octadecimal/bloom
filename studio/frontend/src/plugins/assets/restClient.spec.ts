// studio/frontend/src/plugins/assets/restClient.spec.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getGames, createAsset } from './restClient';

afterEach(() => vi.restoreAllMocks());

describe('assets restClient', () => {
  it('getGames fetches /games', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 'g1', name: 'G', createdAt: '' }] });
    vi.stubGlobal('fetch', fetchMock);
    const games = await getGames();
    expect(games[0].id).toBe('g1');
    expect(fetchMock.mock.calls[0][0]).toContain('/games');
  });

  it('createAsset POSTs to /games/{id}/assets', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'a1' }) });
    vi.stubGlobal('fetch', fetchMock);
    await createAsset('g1', { name: 'W', prompt: 'p', width: 64, height: 64, workflow: 'schnell-opaque' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/games/g1/assets');
    expect(opts.method).toBe('POST');
  });
});
