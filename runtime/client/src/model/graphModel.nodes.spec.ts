import { describe, it, expect } from 'vitest';
import { GraphModel } from './graphModel';
import { OpError } from './ops';

describe('GraphModel addNode/removeNode', () => {
  it('adds a node and emits nodeCreated', () => {
    const m = new GraphModel();
    const changes = m.apply({ kind: 'addNode', id: 'sprite.a', type: 'Sprite', props: { alpha: 1 } });
    expect(changes).toEqual([{ kind: 'nodeCreated', node: { id: 'sprite.a', type: 'Sprite', props: { alpha: 1 } } }]);
    expect(m.getNode('sprite.a')).toEqual({ id: 'sprite.a', type: 'Sprite', props: { alpha: 1 } });
  });

  it('defaults props to {} when omitted', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 'root', type: 'Root' });
    expect(m.getNode('root')).toEqual({ id: 'root', type: 'Root', props: {} });
  });

  it('rejects a duplicate id without mutating', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 'x', type: 'Container' });
    expect(() => m.apply({ kind: 'addNode', id: 'x', type: 'Sprite' })).toThrow(OpError);
    expect(m.getNode('x')?.type).toBe('Container');
  });

  it('rejects an unknown node type', () => {
    const m = new GraphModel();
    expect(() => m.apply({ kind: 'addNode', id: 'x', type: 'Nope' as never })).toThrow(OpError);
  });

  it('removes a node and emits nodeRemoved', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 'x', type: 'Sprite' });
    const changes = m.apply({ kind: 'removeNode', id: 'x' });
    expect(changes).toEqual([{ kind: 'nodeRemoved', id: 'x' }]);
    expect(m.getNode('x')).toBeUndefined();
  });

  it('rejects removing an unknown node', () => {
    const m = new GraphModel();
    expect(() => m.apply({ kind: 'removeNode', id: 'ghost' })).toThrow(OpError);
  });

  it('toDocument reflects current nodes', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 'x', type: 'Sprite' });
    expect(m.toDocument()).toEqual({ version: 1, nodes: { x: { id: 'x', type: 'Sprite', props: {} } }, edges: [] });
  });
});
