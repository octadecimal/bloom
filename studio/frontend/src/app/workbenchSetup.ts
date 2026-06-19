import { createPaneRegistry } from '../host/paneRegistry';
import { createCommandRegistry } from '../host/commandRegistry';
import { createHost } from '../host/host';
import { createLayoutService } from '../host/layoutService';
import { boot } from '../host/boot';
import { setHost } from '../state/hostRef';
import { registerSlicePersistence } from '../state/persistSlices';
import { PLUGINS } from '../plugins';
import type { DockviewApi } from 'dockview-react';

// Opens the temp pane as the default layout until Task 13 wires real panes.
function DEFAULT_LAYOUT(api: DockviewApi): void {
  if (!api.getPanel('temp/main')) {
    api.addPanel({ id: 'temp/main', component: 'temp/main', params: { paneId: 'temp/main' } });
  }
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

  return {
    host,
    paneRegistry,
    onReady: (a: DockviewApi) => {
      api = a;
      layoutService.attach(a);
    },
  };
}
