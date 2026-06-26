// studio/frontend/src/plugins/assets/prefs.ts
import { savePersisted, loadPersisted } from '../../state/persistence';
import type { AssetViewMode } from './viewConfig';

export const ASSET_PREFS_KEY = 'assets.prefs';
export const ASSET_PREFS_VERSION = 1;

export interface IAssetPrefs {
  viewMode: AssetViewMode;
}

export function loadPrefs(): IAssetPrefs {
  return loadPersisted<IAssetPrefs>(ASSET_PREFS_KEY, ASSET_PREFS_VERSION, { viewMode: 'medium' });
}

export function savePrefs(prefs: IAssetPrefs): void {
  savePersisted(ASSET_PREFS_KEY, ASSET_PREFS_VERSION, prefs);
}
