import { describe, it, expect } from 'vitest';
import { emptyDocument, applyOpToDocument } from './reducers';

describe('applyOpToDocument', () => {
  it('adds a node', () => {
    const d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 's', type: 'Sprite', props: { alpha: 1 } });
    expect(d.nodes.s).toEqual({ id: 's', type: 'Sprite', props: { alpha: 1 } });
  });

  it('addNode defaults props to {}', () => {
    const d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 'root', type: 'Root' });
    expect(d.nodes.root.props).toEqual({});
  });

  it('sets a nested prop immutably', () => {
    let d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 's', type: 'Sprite' });
    const before = d;
    d = applyOpToDocument(d, { kind: 'setProp', id: 's', path: 'position.x', value: 240 });
    expect(d.nodes.s.props.position).toEqual({ x: 240 });
    expect(before.nodes.s.props).toEqual({}); // original untouched
  });

  it('connects an edge', () => {
    let d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 'root', type: 'Root' });
    d = applyOpToDocument(d, { kind: 'addNode', id: 's', type: 'Sprite' });
    d = applyOpToDocument(d, {
      kind: 'connect',
      edgeId: 'e1',
      type: 'child',
      from: { node: 'root', port: 'children' },
      to: { node: 's', port: 'parent' },
    });
    expect(d.edges).toHaveLength(1);
    expect(d.edges[0].id).toBe('e1');
  });

  it('disconnects an edge', () => {
    let d = emptyDocument();
    d = applyOpToDocument(applyOpToDocument(d, { kind: 'addNode', id: 'a', type: 'Container' }), {
      kind: 'addNode',
      id: 'b',
      type: 'Sprite',
    });
    d = applyOpToDocument(d, { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'a', port: 'children' }, to: { node: 'b', port: 'parent' } });
    d = applyOpToDocument(d, { kind: 'disconnect', edgeId: 'e1' });
    expect(d.edges).toHaveLength(0);
  });

  it('ignores prototype-pollution setProp paths (no Object.prototype mutation)', () => {
    let d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 's', type: 'Sprite' });
    d = applyOpToDocument(d, { kind: 'setProp', id: 's', path: '__proto__', value: { polluted: true } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(d.nodes.s.props).toEqual({});
  });

  it('ignores nested prototype-pollution setProp paths', () => {
    let d = applyOpToDocument(emptyDocument(), { kind: 'addNode', id: 's', type: 'Sprite' });
    d = applyOpToDocument(d, { kind: 'setProp', id: 's', path: 'a.__proto__.x', value: 1 });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(d.nodes.s.props).toEqual({});
  });

  it('removeNode cascades incident edges', () => {
    let d = emptyDocument();
    for (const id of ['root', 's', 'tex'])
      d = applyOpToDocument(d, { kind: 'addNode', id, type: id === 'tex' ? 'Texture' : id === 'root' ? 'Root' : 'Sprite' });
    d = applyOpToDocument(d, { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } });
    d = applyOpToDocument(d, { kind: 'connect', edgeId: 'e2', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } });
    d = applyOpToDocument(d, { kind: 'removeNode', id: 's' });
    expect(d.nodes.s).toBeUndefined();
    expect(d.edges).toHaveLength(0);
  });
});
