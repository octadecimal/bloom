import type { State } from '@hookstate/core';
import { rootStore } from '../state/rootStore';
import { makePluginHooks } from '../state/makePluginHooks';
import { emptyDocument } from './reducers';
import type { ISceneDocument } from './types';

export const SCENE_STORE_ID = 'scene';

export interface ISceneStoreState {
  document: ISceneDocument;
}

export function makeInitialSceneState(): ISceneStoreState {
  return { document: emptyDocument() };
}

export const sceneHooks = makePluginHooks<ISceneStoreState>(SCENE_STORE_ID);

export function sceneStore(): State<ISceneStoreState> {
  return rootStore.plugins.nested(SCENE_STORE_ID) as unknown as State<ISceneStoreState>;
}
