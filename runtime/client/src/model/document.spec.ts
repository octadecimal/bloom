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

  it('flags a whole subtree unreachable when its only link to root breaks', () => {
    const nodes = {
      root: { id: 'root', type: 'Root', props: {} },
      box: { id: 'box', type: 'Container', props: {} },
      s: { id: 's', type: 'Sprite', props: {} },
    };
    const connected = {
      version: 1,
      nodes,
      edges: [
        { id: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'box', port: 'parent' } },
        { id: 'e2', type: 'child', from: { node: 'box', port: 'children' }, to: { node: 's', port: 'parent' } },
      ],
    };
    // root -> box -> sprite: the whole chain is reachable.
    expect(unreachableNodes(connected as never)).toEqual([]);
    // Break root -> box; both the container AND its grandchild sprite drop off.
    const broken = { ...connected, edges: connected.edges.filter((e) => e.id !== 'e1') };
    expect(unreachableNodes(broken as never)).toEqual(['box', 's']);
  });
});
