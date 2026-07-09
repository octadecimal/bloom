import type { IPlugin } from '../../host/types';
import { GameStructurePane } from './GameStructurePane';
import { GAME_STRUCTURE_PLUGIN_ID, makeInitialState, type IGameStructureState } from './state';
import { initGameStructure } from './actions';

export const gameStructure: IPlugin<IGameStructureState> = {
  id: GAME_STRUCTURE_PLUGIN_ID,
  title: 'Game Structure',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'game-structure/editor', title: 'Game Structure', component: GameStructurePane as never }],
  commands: [{ id: 'game-structure/open-editor', title: 'Open Game Structure', run: (host) => host.openPane('game-structure/editor') }],
  init: () => initGameStructure(),
};
