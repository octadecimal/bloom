export const STORAGE_PREFIX = 'bloom.studio.';

interface IEnvelope<T> {
  version: number;
  data: T;
}

export function savePersisted<T>(key: string, version: number, data: T): void {
  try {
    const env: IEnvelope<T> = { version, data };
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(env));
  } catch {
    // storage full / unavailable — non-fatal for UI preferences
  }
}

export function loadPersisted<T>(key: string, version: number, fallback: T): T {
  const raw = localStorage.getItem(STORAGE_PREFIX + key);
  if (raw == null) return fallback;
  try {
    const env = JSON.parse(raw) as IEnvelope<T>;
    if (env.version !== version) return fallback;
    return env.data;
  } catch {
    return fallback;
  }
}

export function makeDebouncedSaver<T>(key: string, version: number, delayMs = 250): (data: T) => void {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return (data: T) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => savePersisted(key, version, data), delayMs);
  };
}
