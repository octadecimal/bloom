import { BACKEND_URL } from '../gdd/config';

export interface IRegionFields {
  x: number;
  y: number;
  region_w: number;
  region_h: number;
  anchor_x: number;
  anchor_y: number;
}

export interface IOverrideView {
  canvas: [number, number];
  plan: Record<string, IRegionFields>;
  overrides: Record<string, Partial<IRegionFields>>;
}

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getOverrides(gameId: string): Promise<IOverrideView> {
  return okJson<IOverrideView>(await fetch(`${BACKEND_URL}/games/${gameId}/scene/overrides`));
}

export async function putOverride(gameId: string, role: string, fields: Partial<IRegionFields>): Promise<{ rebuilt: boolean }> {
  return okJson<{ rebuilt: boolean }>(
    await fetch(`${BACKEND_URL}/games/${gameId}/scene/overrides/${role}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  );
}

export async function deleteOverride(gameId: string, role: string): Promise<{ rebuilt: boolean }> {
  return okJson<{ rebuilt: boolean }>(await fetch(`${BACKEND_URL}/games/${gameId}/scene/overrides/${role}`, { method: 'DELETE' }));
}
