import { describe, it, expect } from 'vitest';
import { GraphModel } from './graphModel';
import { OpError } from './ops';

describe('GraphModel setProp', () => {
  it('sets a top-level prop and emits propSet', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 's', type: 'Sprite' });
    const changes = m.apply({ kind: 'setProp', id: 's', path: 'alpha', value: 0.5 });
    expect(changes).toEqual([{ kind: 'propSet', id: 's', path: 'alpha', value: 0.5 }]);
    expect(m.getNode('s')?.props.alpha).toBe(0.5);
  });

  it('sets a nested prop, creating intermediate objects', () => {
    const m = new GraphModel();
    m.apply({ kind: 'addNode', id: 's', type: 'Sprite' });
    m.apply({ kind: 'setProp', id: 's', path: 'position.x', value: 240 });
    expect(m.getNode('s')?.props.position).toEqual({ x: 240 });
  });

  it('rejects setProp on a missing node', () => {
    const m = new GraphModel();
    expect(() => m.apply({ kind: 'setProp', id: 'ghost', path: 'alpha', value: 1 })).toThrow(OpError);
  });
});
