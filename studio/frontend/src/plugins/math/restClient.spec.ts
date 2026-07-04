import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRuns, fetchRun } from './restClient';

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
});
