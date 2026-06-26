import type { IPlugin } from '../host/types';
import { SCENE_STORE_ID, makeInitialSceneState, type ISceneStoreState } from './sceneStore';

// Headless plugin: owns no panes/commands, only seeds the shared scene document
// slice via boot()'s standard initialState path. Registered before `game` so the
// slice exists before the game socket writes the first snapshot.
export const sceneStorePlugin: IPlugin<ISceneStoreState> = {
  id: SCENE_STORE_ID,
  title: 'Scene',
  persist: false,
  initialState: makeInitialSceneState(),
  panes: [],
};
