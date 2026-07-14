import type { IPlugin } from '../../host/types';
import { InspectorPane } from './InspectorPane';
import { PROPERTY_INSPECTOR_PLUGIN_ID, makeInitialState, type IPropertyInspectorState } from './state';

export const propertyInspector: IPlugin<IPropertyInspectorState> = {
  id: PROPERTY_INSPECTOR_PLUGIN_ID,
  title: 'Inspector',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'property-inspector/panel', title: 'Inspector', component: InspectorPane as never }],
};
