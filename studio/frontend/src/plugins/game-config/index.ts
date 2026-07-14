import type { IPlugin } from '../../host/types';
import { GameConfigPane } from './GameConfigPane';
import { GAME_CONFIG_PLUGIN_ID, makeInitialState, type IGameConfigState } from './state';
import { initGameConfig } from './actions';

export const gameConfig: IPlugin<IGameConfigState> = {
  id: GAME_CONFIG_PLUGIN_ID,
  title: 'Game Config',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'game-config/editor', title: 'Game Config', component: GameConfigPane as never }],
  init: () => initGameConfig(),
};
