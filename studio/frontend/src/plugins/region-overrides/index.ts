import type { IPlugin } from '../../host/types';
import { RegionOverridePane } from './RegionOverridePane';

export const REGION_OVERRIDES_PLUGIN_ID = 'region-overrides';

export const regionOverrides: IPlugin = {
  id: REGION_OVERRIDES_PLUGIN_ID,
  title: 'Layout Regions',
  persist: false,
  initialState: {},
  panes: [{ id: 'region-overrides/preview', title: 'Layout Regions', component: RegionOverridePane as never }],
  commands: [{ id: 'region-overrides/open', title: 'Open Layout Regions', run: (host) => host.openPane('region-overrides/preview') }],
  init: () => {},
};
