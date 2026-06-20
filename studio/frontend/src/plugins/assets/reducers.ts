// studio/frontend/src/plugins/assets/reducers.ts
import type { IAsset } from './state';

export function upsertAsset(assets: IAsset[], asset: IAsset): IAsset[] {
  const idx = assets.findIndex((a) => a.id === asset.id);
  if (idx === -1) return [...assets, asset];
  const next = assets.slice();
  next[idx] = asset;
  return next;
}
