import { describe, it, expect } from 'vitest';
import { emptyDocument } from './document';
import { unreachableNodes } from './document';

describe('emptyDocument', () => {
  it('is version 1 with no nodes or edges', () => {
    const doc = emptyDocument();
    expect(doc.version).toBe(1);
    expect(doc.nodes).toEqual({});
    expect(doc.edges).toEqual([]);
  });
});

describe('unreachableNodes', () => {
  it('flags an unparented sprite and clears once parented', () => {
    const doc = {
      version: 1,
      nodes: {
        root: { id: 'root', type: 'Root', props: {} },
        s: { id: 's', type: 'Sprite', props: {} },
        tex: { id: 'tex', type: 'Texture', props: { src: 'a' } },
      },
      edges: [],
    } as const;
    expect(unreachableNodes(doc as never)).toEqual(['s']); // tex never counts
    const parented = {
      ...doc,
      edges: [{ id: 'e', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } }],
    };
    expect(unreachableNodes(parented as never)).toEqual([]);
  });
});
