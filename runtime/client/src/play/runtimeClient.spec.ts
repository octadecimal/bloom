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

  it('handshake and spin carry the package id when configured', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
      return { ok: true, json: async () => ({}) } as Response;
    }) as typeof fetch;
    const client = createRuntimeClient('http://s:9000', fetchImpl, 'g1');
    await client.handshake();
    await client.spin(2);
    expect(calls[0].url).toBe('http://s:9000/handshake?package=g1');
    expect(JSON.parse(calls[1].body!)).toEqual({ bet: 2, package: 'g1' });
  });

  it('omits the package field entirely when not configured', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
      return { ok: true, json: async () => ({}) } as Response;
    }) as typeof fetch;
    const client = createRuntimeClient('http://s:9000', fetchImpl);
    await client.handshake();
    await client.spin();
    expect(calls[0].url).toBe('http://s:9000/handshake');
    expect(JSON.parse(calls[1].body!)).toEqual({ bet: 1 });
  });
});
