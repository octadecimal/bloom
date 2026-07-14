import type { IPlugin } from '../../host/types';
import { RegionOverridePane } from './RegionOverridePane';

export const REGION_OVERRIDES_PLUGIN_ID = 'region-overrides';

export const regionOverrides: IPlugin = {
  id: REGION_OVERRIDES_PLUGIN_ID,
  title: 'Layout Regions',
  persist: false,
  initialState: {},
  panes: [{ id: 'region-overrides/preview', title: 'Layout Regions', component: RegionOverridePane as never }],
  init: () => {},
};
