import { describe, it, expect } from 'vitest';
import { GraphModel } from './graphModel';
import { OpError } from './ops';

function withNodes(): GraphModel {
  const m = new GraphModel();
  m.apply({ kind: 'addNode', id: 'root', type: 'Root' });
  m.apply({ kind: 'addNode', id: 'box', type: 'Container' });
  m.apply({ kind: 'addNode', id: 's', type: 'Sprite' });
  m.apply({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: 'asset:1' } });
  return m;
}
const child = (id: string, parent: string, kid: string) =>
  ({ kind: 'connect', edgeId: id, type: 'child', from: { node: parent, port: 'children' }, to: { node: kid, port: 'parent' } }) as const;
const data = (id: string, src: string, dst: string) =>
  ({ kind: 'connect', edgeId: id, type: 'data', from: { node: src, port: 'data' }, to: { node: dst, port: 'texture' } }) as const;

describe('GraphModel connect/disconnect', () => {
  it('child connect emits parentSet', () => {
    const m = withNodes();
    expect(m.apply(child('e1', 'root', 'box'))).toEqual([{ kind: 'parentSet', childId: 'box', parentId: 'root' }]);
  });

  it('data connect emits dataBound', () => {
    const m = withNodes();
    const changes = m.apply(data('e2', 'tex', 's'));
    expect(changes).toEqual([{ kind: 'dataBound', edge: { id: 'e2', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } } }]);
  });

  it('child disconnect emits parentSet null', () => {
    const m = withNodes();
    m.apply(child('e1', 'root', 'box'));
    expect(m.apply({ kind: 'disconnect', edgeId: 'e1' })).toEqual([{ kind: 'parentSet', childId: 'box', parentId: null }]);
  });

  it('data disconnect emits dataUnbound', () => {
    const m = withNodes();
    m.apply(data('e2', 'tex', 's'));
    expect(m.apply({ kind: 'disconnect', edgeId: 'e2' })).toEqual([
      { kind: 'dataUnbound', edge: { id: 'e2', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } } },
    ]);
  });

  it('rejects an edge to an unknown node', () => {
    const m = withNodes();
    expect(() => m.apply(child('e1', 'root', 'ghost'))).toThrow(OpError);
  });

  it('rejects a duplicate edge id', () => {
    const m = withNodes();
    m.apply(child('e1', 'root', 'box'));
    expect(() => m.apply(child('e1', 'box', 's'))).toThrow(OpError);
  });

  it('rejects a node gaining two parents', () => {
    const m = withNodes();
    m.apply(child('e1', 'root', 's'));
    expect(() => m.apply(child('e2', 'box', 's'))).toThrow(OpError);
  });

  it('rejects a child cycle', () => {
    const m = withNodes();
    m.apply({ kind: 'addNode', id: 'box2', type: 'Container' });
    m.apply(child('e1', 'box', 'box2'));
    expect(() => m.apply(child('e2', 'box2', 'box'))).toThrow(OpError);
  });

  it('rejects a reversed data edge (Sprite.data -> Texture.texture)', () => {
    const m = withNodes();
    try {
      m.apply({ kind: 'connect', edgeId: 'bad', type: 'data', from: { node: 's', port: 'data' }, to: { node: 'tex', port: 'texture' } });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OpError);
      expect((e as OpError).code).toBe('invalid_edge');
    }
  });

  it('rejects a data edge to a non-texture port', () => {
    const m = withNodes();
    try {
      m.apply({ kind: 'connect', edgeId: 'bad', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'parent' } });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OpError);
      expect((e as OpError).code).toBe('invalid_edge');
    }
  });

  it('rejects a child edge with swapped ports', () => {
    const m = withNodes();
    try {
      m.apply({ kind: 'connect', edgeId: 'bad', type: 'child', from: { node: 'root', port: 'parent' }, to: { node: 'box', port: 'children' } });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OpError);
      expect((e as OpError).code).toBe('invalid_edge');
    }
  });

  it('rejects a child edge into a Texture', () => {
    const m = withNodes();
    try {
      m.apply({ kind: 'connect', edgeId: 'bad', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'tex', port: 'parent' } });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OpError);
      expect((e as OpError).code).toBe('invalid_edge');
    }
  });

  it('removeNode cascades incident edges', () => {
    const m = withNodes();
    m.apply(child('e1', 'root', 'box'));
    m.apply(data('e2', 'tex', 's'));
    m.apply(child('e3', 'box', 's'));
    const changes = m.apply({ kind: 'removeNode', id: 's' });
    expect(changes).toContainEqual({ kind: 'parentSet', childId: 's', parentId: null });
    expect(changes).toContainEqual({
      kind: 'dataUnbound',
      edge: { id: 'e2', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } },
    });
    expect(changes[changes.length - 1]).toEqual({ kind: 'nodeRemoved', id: 's' });
    expect(m.getEdge('e2')).toBeUndefined();
    expect(m.getEdge('e3')).toBeUndefined();
  });

  it('edgesBySource / edgesByTarget filter by node and port', () => {
    const m = withNodes();
    m.apply(data('e2', 'tex', 's'));
    expect(m.edgesBySource('tex', 'data').map((e) => e.id)).toEqual(['e2']);
    expect(m.edgesByTarget('s', 'texture').map((e) => e.id)).toEqual(['e2']);
  });

  it('getEdge returns a copy that cannot mutate internal state', () => {
    const m = withNodes();
    m.apply(data('e2', 'tex', 's'));
    const got = m.getEdge('e2')!;
    got.from.node = 'HACKED';
    got.to.port = 'HACKED';
    expect(m.getEdge('e2')!.from.node).toBe('tex');
    expect(m.getEdge('e2')!.to.port).toBe('texture');
  });
});
