import type { IPlugin } from '../../host/types';
import { GamePreviewPane } from './GamePreviewPane';
import { GAME_PLUGIN_ID, makeInitialState, type IGameState } from './state';
import { initGame } from './actions';

export const game: IPlugin<IGameState> = {
  id: GAME_PLUGIN_ID,
  title: 'Game Scene',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'game/preview', title: 'Game Scene', component: GamePreviewPane as never }],
  init: () => initGame(),
};
