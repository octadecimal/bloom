// studio/frontend/e2e/global-setup.ts
const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const backendUrl = process.env.VITE_BLOOM_BACKEND_URL ?? `http://localhost:${8000 + offset}`;

export default async function globalSetup() {
  const res = await fetch(`${backendUrl}/health`).catch(() => null);
  if (!res || !res.ok) throw new Error(`e2e: backend not reachable at ${backendUrl}/health — start it first`);
  const body = (await res.json()) as { providerMode?: string };
  if (!body.providerMode) {
    throw new Error('e2e: backend has no providerMode on /health — it is too old or not the parity build. Refusing to run against an unknown stack.');
  }
  if (process.env.BLOOM_E2E_TIER === 'live' && body.providerMode !== 'live') {
    throw new Error(`e2e-live requires PROVIDER_MODE=live, but /health says "${body.providerMode}"`);
  }
}
