import { BACKEND_URL } from './config';
import type { ISlotModelDoc, ICurationResult, ICurationParams } from './state';

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getSlotModel(gameId: string): Promise<ISlotModelDoc> {
  return okJson<ISlotModelDoc>(await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`));
}

export async function putSlotModel(gameId: string, patch: { model?: unknown; params?: ICurationParams }): Promise<ISlotModelDoc> {
  return okJson<ISlotModelDoc>(
    await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function curate(gameId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/slot-model/curate`, { method: 'POST' });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
}

export async function getResult(gameId: string): Promise<ICurationResult | null> {
  return okJson<ICurationResult | null>(await fetch(`${BACKEND_URL}/games/${gameId}/slot-model/result`));
}
