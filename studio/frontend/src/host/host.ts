import type { IPluginHost, IPaneDef, ICommandDef } from './types';

interface IHostDeps {
  paneRegistry: { register(d: IPaneDef): void; get(id: string): IPaneDef | undefined; list(): IPaneDef[] };
  commandRegistry: { register(d: ICommandDef): void; get(id: string): ICommandDef | undefined; list(): ICommandDef[] };
  getApi: () => any | null; // DockviewApi once mounted
  resetLayout: () => void;
}

export function createHost(deps: IHostDeps): IPluginHost {
  const host: IPluginHost = {
    registerPane: (d) => deps.paneRegistry.register(d),
    registerCommand: (d) => deps.commandRegistry.register(d),
    listPanes: () => deps.paneRegistry.list(),
    listCommands: () => deps.commandRegistry.list(),
    openPane(paneId) {
      const api = deps.getApi();
      if (!api) return;
      const existing = api.getPanel(paneId);
      if (existing) { existing.api.setActive(); return; }
      api.addPanel({ id: paneId, component: paneId, params: { paneId } });
    },
    runCommand(commandId) {
      const cmd = deps.commandRegistry.get(commandId);
      if (!cmd) { console.warn('[host] unknown command:', commandId); return; }
      cmd.run(host);
    },
    resetLayout: () => deps.resetLayout(),
  };
  return host;
}
