import { describe, it, expect } from 'vitest';
import { GraphModel } from './graphModel';
import { OpError } from './ops';
import type { IGameDocument } from './document';

describe('GraphModel applyBatch', () => {
  it('applies all ops and concatenates changes', () => {
    const m = new GraphModel();
    const changes = m.applyBatch([
      { kind: 'addNode', id: 'root', type: 'Root' },
      { kind: 'addNode', id: 's', type: 'Sprite' },
      { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } },
    ]);
    expect(changes).toHaveLength(3);
    expect(m.getNode('s')).toBeDefined();
  });

  it('is transactional: a bad op rolls back the whole batch', () => {
    const m = new GraphModel();
    expect(() =>
      m.applyBatch([
        { kind: 'addNode', id: 'a', type: 'Sprite' },
        { kind: 'addNode', id: 'a', type: 'Sprite' }, // duplicate -> throws
      ]),
    ).toThrow(OpError);
    expect(m.getNode('a')).toBeUndefined(); // first op rolled back
  });
});

describe('GraphModel load', () => {
  it('loads a document into an empty scene', () => {
    const doc: IGameDocument = {
      version: 1,
      nodes: {
        root: { id: 'root', type: 'Root', props: { width: 800, height: 600 } },
        s: { id: 's', type: 'Sprite', props: { alpha: 1 } },
      },
      edges: [{ id: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } }],
    };
    const m = new GraphModel();
    const changes = m.load(doc);
    expect(changes.some((c) => c.kind === 'nodeCreated')).toBe(true);
    expect(changes.some((c) => c.kind === 'parentSet')).toBe(true);
    expect(m.toDocument()).toEqual(doc);
  });
});
