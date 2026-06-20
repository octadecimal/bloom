import { savePersisted, loadPersisted } from '../state/persistence';

const SESSION_KEY = 'session';
const SESSION_VERSION = 1;

export interface ISession {
  username: string;
}

export function loadSession(): ISession | null {
  const s = loadPersisted<ISession | null>(SESSION_KEY, SESSION_VERSION, null);
  if (!s || typeof s.username !== 'string' || s.username.length === 0) return null;
  return s;
}

export function saveSession(username: string): void {
  savePersisted<ISession>(SESSION_KEY, SESSION_VERSION, { username });
}

export function clearSession(): void {
  localStorage.removeItem('bloom.studio.' + SESSION_KEY);
}
