import { describe, it, expect } from 'vitest';
import { emptyDocument } from './document';

describe('emptyDocument', () => {
  it('is version 1 with no nodes or edges', () => {
    const doc = emptyDocument();
    expect(doc.version).toBe(1);
    expect(doc.nodes).toEqual({});
    expect(doc.edges).toEqual([]);
  });
});
