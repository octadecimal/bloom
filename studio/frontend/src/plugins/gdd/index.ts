import type { IPlugin } from '../../host/types';
import { GddViewerPane } from './GddViewerPane';
import { GDD_PLUGIN_ID, makeInitialState, type IGddState } from './state';
import { initGdd } from './actions';

export const gdd: IPlugin<IGddState> = {
  id: GDD_PLUGIN_ID,
  title: 'Game Design Doc',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'gdd/viewer', title: 'Game Design Doc', component: GddViewerPane as never }],
  commands: [{ id: 'gdd/open-viewer', title: 'Open Game Design Doc', run: (host) => host.openPane('gdd/viewer') }],
  init: () => initGdd(),
};
