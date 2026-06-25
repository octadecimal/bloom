import { describe, it, expect } from 'vitest';
import { sceneGraph } from './index';

describe('sceneGraph plugin', () => {
  it('declares the expected id, pane, and command', () => {
    expect(sceneGraph.id).toBe('scene-graph');
    expect(sceneGraph.panes.map((p) => p.id)).toContain('scene-graph/tree');
    expect(sceneGraph.commands?.map((c) => c.id)).toContain('scene-graph/open');
  });

  it('seeds a non-persistent initial state', () => {
    expect(sceneGraph.persist).toBe(false);
    expect(sceneGraph.initialState).toEqual({ selectedId: null, collapsed: {} });
  });
});
