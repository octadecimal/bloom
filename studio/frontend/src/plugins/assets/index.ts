import type { IPlugin } from '../../host/types';
import type { IAssetsState } from './state';
import { ASSETS_PLUGIN_ID, makeInitialState } from './state';
import { initAssets } from './actions';
import { AssetBoardPane } from './AssetBoardPane';

export const assets: IPlugin<IAssetsState> = {
  id: ASSETS_PLUGIN_ID,
  title: 'Game Assets',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'assets/board', title: 'Asset Board', component: AssetBoardPane as never }],
  init: () => initAssets(),
};
