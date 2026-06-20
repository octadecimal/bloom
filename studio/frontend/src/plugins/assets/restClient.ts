// studio/frontend/src/plugins/assets/restClient.ts
import type { IGame, IAsset, Workflow } from './state';
import { BACKEND_URL } from './config';

export interface ICreateAssetInput {
  name: string;
  prompt: string;
  width: number;
  height: number;
  workflow: Workflow;
  seed?: number | null;
  category?: string | null;
}

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getGames(): Promise<IGame[]> {
  return okJson<IGame[]>(await fetch(`${BACKEND_URL}/games`));
}

export async function getAssets(gameId: string): Promise<IAsset[]> {
  return okJson<IAsset[]>(await fetch(`${BACKEND_URL}/games/${gameId}/assets`));
}

export async function createAsset(gameId: string, input: ICreateAssetInput): Promise<IAsset> {
  return okJson<IAsset>(
    await fetch(`${BACKEND_URL}/games/${gameId}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateAsset(assetId: string, patch: Partial<ICreateAssetInput>): Promise<IAsset> {
  return okJson<IAsset>(
    await fetch(`${BACKEND_URL}/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteAsset(assetId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/assets/${assetId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
}

export async function selectGeneration(assetId: string, generationId: string): Promise<IAsset> {
  return okJson<IAsset>(
    await fetch(`${BACKEND_URL}/assets/${assetId}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generationId }),
    }),
  );
}
