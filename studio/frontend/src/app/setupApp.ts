import { createPaneRegistry } from '../host/paneRegistry';
import { createCommandRegistry } from '../host/commandRegistry';
import { createHost } from '../host/host';
import { createLayoutService } from '../host/layoutService';
import { boot } from '../host/boot';
import { setHost } from '../state/hostRef';
import { registerSlicePersistence } from '../state/persistSlices';
import { hydrateWorkspace, registerWorkspacePersistence } from '../state/persistWorkspace';
import { PLUGINS } from '../plugins';
import { DEFAULT_LAYOUT } from './workbenchSetup';
import type { IPlugin, IPluginHost } from '../host/types';
import type { DockviewApi } from 'dockview-react';

export interface IAppSetup {
  host: IPluginHost;
  paneRegistry: ReturnType<typeof createPaneRegistry>;
  components: Record<string, unknown>;
  attachDockview(api: DockviewApi): void;
}

let singleton: IAppSetup | null = null;

export function setupApp(): IAppSetup {
  if (singleton) return singleton;

  const paneRegistry = createPaneRegistry();
  const commandRegistry = createCommandRegistry();
  let api: DockviewApi | null = null;

  const layoutService = createLayoutService({
    paneRegistry,
    defaultLayout: (a) => DEFAULT_LAYOUT(a, paneRegistry),
  });

  const host = createHost({
    paneRegistry,
    commandRegistry,
    getApi: () => api,
    resetLayout: () => {
      layoutService.reset();
      if (api) DEFAULT_LAYOUT(api, paneRegistry);
    },
  });

  setHost(host);
  if (!import.meta.env.PROD) (window as unknown as { __host?: unknown }).__host = host;

  let extra: IPlugin[] = [];
  if (!import.meta.env.PROD && (window as unknown as { __injectPlugins?: IPlugin[] }).__injectPlugins) {
    extra = (window as unknown as { __injectPlugins?: IPlugin[] }).__injectPlugins!;
  }
  boot([...PLUGINS, ...extra], host);
  registerSlicePersistence(PLUGINS);
  hydrateWorkspace();
  registerWorkspacePersistence();

  singleton = {
    host,
    paneRegistry,
    components: paneRegistry.asComponentMap(),
    attachDockview: (a: DockviewApi) => {
      api = a;
      layoutService.attach(a);
      if (!import.meta.env.PROD) (window as unknown as { __wbApi?: unknown }).__wbApi = a;
    },
  };
  return singleton;
}
