import { savePersisted, loadPersisted } from '../../state/persistence';

export const PREFS_KEY = 'llm-chat.prefs';
export const PREFS_VERSION = 2; // bump: dropped displayName + guest-name default

export interface IChatPrefs {
  activeRoomId: string | null;
}

export function loadPrefs(): IChatPrefs {
  return loadPersisted<IChatPrefs>(PREFS_KEY, PREFS_VERSION, { activeRoomId: null });
}

export function savePrefs(prefs: IChatPrefs): void {
  savePersisted(PREFS_KEY, PREFS_VERSION, prefs);
}
