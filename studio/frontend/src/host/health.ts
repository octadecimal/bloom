const BACKEND_URL: string = (import.meta.env.VITE_BLOOM_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';

export interface IHealth {
  status: string;
  providerMode: 'live' | 'replay';
}

export async function getHealth(): Promise<IHealth> {
  const res = await fetch(`${BACKEND_URL}/health`);
  if (!res.ok) throw new Error(`health ${res.status}`);
  return (await res.json()) as IHealth;
}
