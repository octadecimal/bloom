import { describe, it, expect, beforeEach } from 'vitest';
import { rootStore } from '../state/rootStore';
import { SCENE_STORE_ID, sceneStore, makeInitialSceneState } from './sceneStore';
import { emptyDocument } from './reducers';

beforeEach(() => {
  rootStore.plugins.nested(SCENE_STORE_ID).set(makeInitialSceneState() as never);
});

describe('sceneStore', () => {
  it('makeInitialSceneState wraps an empty document', () => {
    expect(makeInitialSceneState()).toEqual({ document: { version: 1, nodes: {}, edges: [] } });
  });

  it('seeds an empty document into the slice', () => {
    expect(sceneStore().document.get({ noproxy: true })).toEqual(emptyDocument());
  });

  it('holds a document set through the slice', () => {
    sceneStore().document.set({ version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] } as never);
    expect(sceneStore().document.nodes.get({ noproxy: true })).toHaveProperty('root');
  });
});
