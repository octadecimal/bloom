import type { IPlugin } from '../../host/types';
import { MathPane } from './MathPane';
import { MATH_PLUGIN_ID, makeInitialState, type IMathState } from './state';
import { initMath } from './actions';

export const math: IPlugin<IMathState> = {
  id: MATH_PLUGIN_ID,
  title: 'Math',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'math/viewer', title: 'Math', component: MathPane as never }],
  init: () => initMath(),
};
