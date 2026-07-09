import type { IHandshakeResponse, IRuntimeClient, ISpinResponse } from './wireTypes';

/** A thin transport over runtime/server. The base URL is resolved elsewhere
 *  (host-derived, never hardcoded localhost). `fetch` is injectable for tests. */
export function createRuntimeClient(baseUrl: string, fetchImpl: typeof fetch = fetch, packageId?: string): IRuntimeClient {
  const base = baseUrl.replace(/\/+$/, '');
  const handshakeUrl = packageId ? `${base}/handshake?package=${encodeURIComponent(packageId)}` : `${base}/handshake`;
  return {
    async handshake(): Promise<IHandshakeResponse> {
      const r = await fetchImpl(handshakeUrl);
      if (!r.ok) throw new Error(`handshake failed: ${r.status}`);
      return (await r.json()) as IHandshakeResponse;
    },
    async spin(bet = 1): Promise<ISpinResponse> {
      const body: Record<string, unknown> = { bet };
      if (packageId) body.package = packageId;
      const r = await fetchImpl(`${base}/spin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`spin failed: ${r.status}`);
      return (await r.json()) as ISpinResponse;
    },
  };
}
