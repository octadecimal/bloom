import { describe, it, expect } from 'vitest';
import type { ISceneDocument } from '../../scene/types';
import { buildTree } from './buildTree';

function doc(partial: Partial<ISceneDocument>): ISceneDocument {
  return { version: 1, nodes: {}, edges: [], ...partial };
}

// child edge: from = parent, to = child
function childEdge(id: string, parent: string, child: string) {
  return { id, type: 'child' as const, from: { node: parent, port: 'children' }, to: { node: child, port: 'parent' } };
}

describe('buildTree', () => {
  it('returns [] for an empty document', () => {
    expect(buildTree(doc({}))).toEqual([]);
  });

  it('returns [] when there is no Root node', () => {
    const d = doc({ nodes: { s: { id: 's', type: 'Sprite', props: {} } } });
    expect(buildTree(d)).toEqual([]);
  });

  it('returns a single row for a lone Root', () => {
    const d = doc({ nodes: { root: { id: 'root', type: 'Root', props: {} } } });
    expect(buildTree(d)).toEqual([{ id: 'root', type: 'Root', depth: 0, name: undefined, hasChildren: false }]);
  });

  it('walks child edges pre-order with depth and hasChildren', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        c1: { id: 'c1', type: 'Container', props: {} },
        s1: { id: 's1', type: 'Sprite', props: {} },
      },
      edges: [childEdge('e1', 'root', 'c1'), childEdge('e2', 'c1', 's1')],
    });
    expect(buildTree(d)).toEqual([
      { id: 'root', type: 'Root', depth: 0, name: undefined, hasChildren: true },
      { id: 'c1', type: 'Container', depth: 1, name: undefined, hasChildren: true },
      { id: 's1', type: 'Sprite', depth: 2, name: undefined, hasChildren: false },
    ]);
  });

  it('orders siblings by child-edge order', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        a: { id: 'a', type: 'Sprite', props: {} },
        b: { id: 'b', type: 'Sprite', props: {} },
      },
      edges: [childEdge('e1', 'root', 'b'), childEdge('e2', 'root', 'a')],
    });
    expect(buildTree(d).map((r) => r.id)).toEqual(['root', 'b', 'a']);
  });

  it('excludes data-only nodes (Texture wired by a data edge)', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        s1: { id: 's1', type: 'Sprite', props: {} },
        t1: { id: 't1', type: 'Texture', props: {} },
      },
      edges: [childEdge('e1', 'root', 's1'), { id: 'e2', type: 'data', from: { node: 't1', port: 'out' }, to: { node: 's1', port: 'texture' } }],
    });
    expect(buildTree(d).map((r) => r.id)).toEqual(['root', 's1']);
  });

  it('skips child edges that point at a missing node', () => {
    const d = doc({
      nodes: { root: { id: 'root', type: 'Root', props: {} } },
      edges: [childEdge('e1', 'root', 'ghost')],
    });
    expect(buildTree(d).map((r) => r.id)).toEqual(['root']);
  });

  it('guards against cycles', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        a: { id: 'a', type: 'Container', props: {} },
      },
      edges: [childEdge('e1', 'root', 'a'), childEdge('e2', 'a', 'root')],
    });
    // root, a — and root is not re-emitted under a
    expect(buildTree(d).map((r) => r.id)).toEqual(['root', 'a']);
  });

  it('uses a string name prop, ignoring non-string names', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: { name: 'Stage' } },
        s1: { id: 's1', type: 'Sprite', props: { name: 42 } },
      },
      edges: [childEdge('e1', 'root', 's1')],
    });
    const rows = buildTree(d);
    expect(rows[0].name).toBe('Stage');
    expect(rows[1].name).toBeUndefined();
  });

  it('hides descendants of a collapsed node but keeps hasChildren', () => {
    const d = doc({
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        c1: { id: 'c1', type: 'Container', props: {} },
        s1: { id: 's1', type: 'Sprite', props: {} },
      },
      edges: [childEdge('e1', 'root', 'c1'), childEdge('e2', 'c1', 's1')],
    });
    const rows = buildTree(d, { c1: true });
    expect(rows.map((r) => r.id)).toEqual(['root', 'c1']);
    expect(rows.find((r) => r.id === 'c1')?.hasChildren).toBe(true);
  });
});
