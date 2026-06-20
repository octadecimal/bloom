import { savePersisted, loadPersisted } from '../../state/persistence';

export const PREFS_KEY = 'llm-chat.prefs';
export const PREFS_VERSION = 1;

export interface IChatPrefs {
  displayName: string;
  activeRoomId: string | null;
}

export function generateGuestName(): string {
  const n = Math.floor(1000 + Math.random() * 9000); // 1000–9999
  return `guest-${n}`;
}

export function loadPrefs(): IChatPrefs {
  const fallback: IChatPrefs = { displayName: generateGuestName(), activeRoomId: null };
  return loadPersisted<IChatPrefs>(PREFS_KEY, PREFS_VERSION, fallback);
}

export function savePrefs(prefs: IChatPrefs): void {
  savePersisted(PREFS_KEY, PREFS_VERSION, prefs);
}
