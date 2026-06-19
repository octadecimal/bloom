import { useHookstate, type State } from '@hookstate/core';
import { rootStore } from './rootStore';
import { getHost } from './hostRef';

// Module-scope factory keyed by pluginId; binds to a scoped handle into the single
// root store. The `as State<TState>` cast is the single, contained type seam.
export function makePluginHooks<TState>(pluginId: string) {
  return {
    usePluginState: () =>
      useHookstate(
        rootStore.plugins.nested(pluginId),
      ) as unknown as State<TState>,
    useHost: () => getHost(),
  };
}
