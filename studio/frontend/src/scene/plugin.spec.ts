import { describe, it, expect } from 'vitest';
import { sceneStorePlugin } from './plugin';

describe('sceneStorePlugin', () => {
  it('is a headless, seed-only plugin for the scene slice', () => {
    expect(sceneStorePlugin.id).toBe('scene');
    expect(sceneStorePlugin.panes).toEqual([]);
    expect(sceneStorePlugin.commands).toBeUndefined();
    expect(sceneStorePlugin.persist).toBe(false);
    expect(sceneStorePlugin.initialState).toEqual({ document: { version: 1, nodes: {}, edges: [] } });
  });
});
