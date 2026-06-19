import type { IPlugin } from '../host/types';
import { rootStore, onRootStoreSet } from './rootStore';
import { makeDebouncedSaver } from './persistence';

// Change-driven slice persistence using hookstate v4's Extension API.
//
// rootStore is created with a notifyExtension whose onSet fires all listeners
// registered via onRootStoreSet(). Here we register one listener that calls
// each persist:true plugin's debounced saver with the current plain snapshot
// of that plugin's slice. Debouncing coalesces rapid mutations; plugins with
// persist:false are simply not wired up and are never saved.

const SLICE_VERSION = 1;

export function registerSlicePersistence(plugins: IPlugin[]): () => void {
  const persistPlugins = plugins.filter((p) => p.persist === true);
  if (persistPlugins.length === 0) return () => {};

  // Create one debounced saver per persist:true plugin.
  const savers = new Map(
    persistPlugins.map((p) => [p.id, makeDebouncedSaver(p.id, SLICE_VERSION)]),
  );

  // Register a single root-store change listener. Path-agnostic: fires on any
  // mutation anywhere in the tree, but only persists the slices opted in.
  const unsubscribe = onRootStoreSet(() => {
    const pluginsMap = rootStore.plugins.get({ noproxy: true }) as Record<
      string,
      unknown
    >;
    savers.forEach((save, id) => {
      if (id in pluginsMap) {
        save(pluginsMap[id]);
      }
    });
  });
  return unsubscribe;
}
