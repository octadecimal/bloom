import type { IPlugin } from '../../host/types';
import { SimulatorPane } from './SimulatorPane';
import { SIMULATOR_PLUGIN_ID, makeInitialState, type ISimulatorState } from './state';
import { initSim } from './actions';

export const simulator: IPlugin<ISimulatorState> = {
  id: SIMULATOR_PLUGIN_ID,
  title: 'Simulator',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'simulator/viewer', title: 'Simulator', component: SimulatorPane as never }],
  commands: [{ id: 'simulator/open-viewer', title: 'Open Simulator', run: (host) => host.openPane('simulator/viewer') }],
  init: () => initSim(),
};
