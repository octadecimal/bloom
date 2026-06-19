import { rootStore, onRootStoreSet } from './rootStore';
import { loadPersisted, makeDebouncedSaver } from './persistence';

const WS_KEY = 'workspace';
const WS_VERSION = 1;

export function hydrateWorkspace(): void {
  const saved = loadPersisted(WS_KEY, WS_VERSION, { theme: 'dark' as const });
  rootStore.workspace.set(saved);
}

export function registerWorkspacePersistence(): () => void {
  const save = makeDebouncedSaver<{ theme: 'light' | 'dark' }>(
    WS_KEY,
    WS_VERSION,
    50,
  );
  return onRootStoreSet(() => save(rootStore.workspace.get({ noproxy: true })));
}
