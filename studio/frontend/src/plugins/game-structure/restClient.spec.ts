import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGameDefinition, getGameDefinition, putGameDefinition, validateGameDefinition } from './restClient';

function okResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('restClient', () => {
  it('GETs the game-definition doc', async () => {
    const fetchMock = vi.fn(async () => okResponse({ gameId: 'g1' }));
    vi.stubGlobal('fetch', fetchMock);
    const doc = await getGameDefinition('g1');
    expect(doc.gameId).toBe('g1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/games/g1/game-definition');
  });

  it('PUTs a partial patch with source', async () => {
    const fetchMock = vi.fn(async () => okResponse({ gameId: 'g1' }));
    vi.stubGlobal('fetch', fetchMock);
    await putGameDefinition('g1', { presentation: { x: 1 }, source: 'editor' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ presentation: { x: 1 }, source: 'editor' });
  });

  it('POSTs validate with the live definition', async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: false, errors: ['boom'] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await validateGameDefinition('g1', { family: 'composed@1' } as never);
    expect(res.errors).toEqual(['boom']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/games/g1/game-definition/validate');
    expect(JSON.parse(String(init.body))).toEqual({ definition: { family: 'composed@1' } });
  });

  it('POSTs build and surfaces failures as thrown errors', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(buildGameDefinition('g1')).rejects.toThrow('500');
  });
});
