import { createPaneRegistry } from '../host/paneRegistry';
import { createCommandRegistry } from '../host/commandRegistry';
import { createHost } from '../host/host';
import { createLayoutService } from '../host/layoutService';
import { boot } from '../host/boot';
import { setHost } from '../state/hostRef';
import { registerSlicePersistence } from '../state/persistSlices';
import { hydrateWorkspace, registerWorkspacePersistence } from '../state/persistWorkspace';
import { PLUGINS } from '../plugins';
import type { DockviewApi } from 'dockview-react';

function DEFAULT_LAYOUT(api: DockviewApi): void {
  const add = (id: string, ref?: { direction: 'right' | 'below'; referencePanel: string }) => {
    if (!api.getPanel(id)) api.addPanel({ id, component: id, params: { paneId: id }, position: ref });
  };
  add('demo-counter/editor');
  add('demo-counter/mirror', { direction: 'right', referencePanel: 'demo-counter/editor' });
  add('demo-scratch/main', { direction: 'below', referencePanel: 'demo-counter/editor' });
}

export function setupWorkbench() {
  const paneRegistry = createPaneRegistry();
  const commandRegistry = createCommandRegistry();
  let api: DockviewApi | null = null;

  const layoutService = createLayoutService({
    paneRegistry,
    defaultLayout: (a) => DEFAULT_LAYOUT(a),
  });

  const host = createHost({
    paneRegistry,
    commandRegistry,
    getApi: () => api,
    resetLayout: () => {
      layoutService.reset();
      if (api) DEFAULT_LAYOUT(api);
    },
  });

  setHost(host);
  boot(PLUGINS, host);
  registerSlicePersistence(PLUGINS);
  hydrateWorkspace();
  registerWorkspacePersistence();

  return {
    host,
    paneRegistry,
    onReady: (a: DockviewApi) => {
      api = a;
      layoutService.attach(a);
      if (!import.meta.env.PROD) (window as unknown as { __wbApi?: unknown }).__wbApi = a;
    },
  };
}
