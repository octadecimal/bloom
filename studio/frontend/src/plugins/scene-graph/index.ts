import type { IPlugin } from '../../host/types';
import { SceneGraphPane } from './SceneGraphPane';
import { SCENE_GRAPH_PLUGIN_ID, makeInitialState, type ISceneGraphState } from './state';

export const sceneGraph: IPlugin<ISceneGraphState> = {
  id: SCENE_GRAPH_PLUGIN_ID,
  title: 'Scene Graph',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'scene-graph/tree', title: 'Scene Graph', component: SceneGraphPane as never }],
};
