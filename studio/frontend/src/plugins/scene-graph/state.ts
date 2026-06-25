import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const SCENE_GRAPH_PLUGIN_ID = 'scene-graph';

export interface ISceneGraphState {
  selectedId: string | null;
  collapsed: Record<string, boolean>; // node id -> true when collapsed; absent = expanded
}

export function makeInitialState(): ISceneGraphState {
  return { selectedId: null, collapsed: {} };
}

export const sceneGraphHooks = makePluginHooks<ISceneGraphState>(SCENE_GRAPH_PLUGIN_ID);

export function sceneGraphSlice(): State<ISceneGraphState> {
  return rootStore.plugins.nested(SCENE_GRAPH_PLUGIN_ID) as unknown as State<ISceneGraphState>;
}
