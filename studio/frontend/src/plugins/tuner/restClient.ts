import { BACKEND_URL } from './config';
import type { ITunerJobDoc, ITuneResult, ITuningParams } from './state';

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getTuner(gameId: string): Promise<ITunerJobDoc> {
  return okJson<ITunerJobDoc>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner`));
}

export async function putTuner(gameId: string, params: ITuningParams): Promise<ITunerJobDoc> {
  return okJson<ITunerJobDoc>(
    await fetch(`${BACKEND_URL}/games/${gameId}/tuner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params }),
    }),
  );
}

export async function getTunerSeed(gameId: string): Promise<{ model: unknown }> {
  return okJson<{ model: unknown }>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/seed`));
}

export async function getTunerTarget(gameId: string): Promise<{ target?: unknown; gap?: string }> {
  return okJson<{ target?: unknown; gap?: string }>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/target`));
}

export async function tune(gameId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/tuner/tune`, { method: 'POST' });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
}

export async function applyTuner(gameId: string): Promise<{ model: unknown }> {
  return okJson<{ model: unknown }>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/apply`, { method: 'POST' }));
}

export async function getTunerResult(gameId: string): Promise<ITuneResult | null> {
  return okJson<ITuneResult | null>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/result`));
}
