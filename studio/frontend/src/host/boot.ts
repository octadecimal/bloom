import { rootStore } from '../state/rootStore';
import { loadPersisted } from '../state/persistence';
import type { IPlugin, IPluginHost } from './types';

const SLICE_VERSION = 1;
export const pluginStorageKey = (id: string) => id;

export function boot(plugins: IPlugin[], host: IPluginHost): void {
  for (const p of plugins) {
    try {
      const seed = p.persist ? loadPersisted(pluginStorageKey(p.id), SLICE_VERSION, p.initialState ?? {}) : (p.initialState ?? {});
      rootStore.plugins.nested(p.id).set(seed as never);

      p.panes.forEach((pane) => host.registerPane(pane));
      p.commands?.forEach((cmd) => host.registerCommand(cmd));
      p.init?.(host);
    } catch (err) {
      console.error(`[boot] plugin "${p.id}" failed to initialise — skipping`, err);
    }
  }
}
