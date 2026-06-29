import { describe, it, expect, vi } from 'vitest';
import { createRuntimeClient } from './runtimeClient';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('createRuntimeClient', () => {
  it('GETs /handshake and parses the response', async () => {
    const body = { package_id: 'p', package_version: 1, mechanic: 'slots@1', presentation: { cols: 3, rows: 3, symbols: ['0'] } };
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const hs = await createRuntimeClient('http://h:9001/', fetchImpl as unknown as typeof fetch).handshake();
    expect(fetchImpl).toHaveBeenCalledWith('http://h:9001/handshake');
    expect(hs).toEqual(body);
  });

  it('POSTs /spin with a JSON bet body and parses the response', async () => {
    const body = { seed: '33', bet: 1, outcome: { mechanic: 'slots@1', base_grid: [[0]], base_payout: 0, feature_payout: 0, total_payout: 0, features: [] } };
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const res = await createRuntimeClient('http://h:9001', fetchImpl as unknown as typeof fetch).spin(1);
    expect(fetchImpl).toHaveBeenCalledWith('http://h:9001/spin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bet: 1 }),
    });
    expect(res.seed).toBe('33');
  });

  it('rejects when the server returns a non-2xx status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 500));
    await expect(createRuntimeClient('http://h:9001', fetchImpl as unknown as typeof fetch).spin()).rejects.toThrow(/spin failed: 500/);
  });
});
