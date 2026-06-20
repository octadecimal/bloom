// studio/frontend/src/plugins/assets/reducers.ts
import type { IAsset, AssetStatus } from './state';

export function upsertAsset(assets: IAsset[], asset: IAsset): IAsset[] {
  const idx = assets.findIndex((a) => a.id === asset.id);
  if (idx === -1) return [...assets, asset];
  const next = assets.slice();
  next[idx] = asset;
  return next;
}

export function setAssetStatus(assets: IAsset[], assetId: string, status: AssetStatus): IAsset[] {
  const idx = assets.findIndex((a) => a.id === assetId);
  if (idx === -1) return assets;
  const next = assets.slice();
  next[idx] = { ...next[idx], status };
  return next;
}

export function setAssetProgress(assets: IAsset[], assetId: string, value: number, max: number): IAsset[] {
  const idx = assets.findIndex((a) => a.id === assetId);
  if (idx === -1) return assets;
  const next = assets.slice();
  next[idx] = { ...next[idx], progress: { value, max } };
  return next;
}
