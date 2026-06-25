import type { IPlugin } from '../../host/types';
import { TunerPane } from './TunerPane';
import { TUNER_PLUGIN_ID, makeInitialState, type ITunerState } from './state';
import { initTuner } from './actions';

export const tuner: IPlugin<ITunerState> = {
  id: TUNER_PLUGIN_ID,
  title: 'Tuner',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'tuner/viewer', title: 'Tuner', component: TunerPane as never }],
  commands: [{ id: 'tuner/open-viewer', title: 'Open Tuner', run: (host) => host.openPane('tuner/viewer') }],
  init: () => initTuner(),
};
