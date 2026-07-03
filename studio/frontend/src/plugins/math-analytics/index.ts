import type { IPlugin } from '../../host/types';
import { MathAnalyticsPane } from './MathAnalyticsPane';
import { MATH_ANALYTICS_PLUGIN_ID, makeInitialState, type IAnalyticsState } from './state';
import { initAnalytics } from './actions';

export const mathAnalytics: IPlugin<IAnalyticsState> = {
  id: MATH_ANALYTICS_PLUGIN_ID,
  title: 'Math Analytics',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'math-analytics/viewer', title: 'Math Analytics', component: MathAnalyticsPane as never }],
  commands: [{ id: 'math-analytics/open-viewer', title: 'Open Math Analytics', run: (host) => host.openPane('math-analytics/viewer') }],
  init: () => initAnalytics(),
};
