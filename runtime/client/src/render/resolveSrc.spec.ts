import { describe, it, expect } from 'vitest';
import { resolveTextureSrc } from './resolveSrc';

describe('resolveTextureSrc', () => {
  it('prefixes a root-relative /media path with the media base', () => {
    expect(resolveTextureSrc('/media/g1/a1/gen1.png', 'http://host:8000')).toBe('http://host:8000/media/g1/a1/gen1.png');
  });
  it('passes an absolute http(s) URL through unchanged', () => {
    expect(resolveTextureSrc('https://cdn.example/x.png', 'http://host:8000')).toBe('https://cdn.example/x.png');
  });
  it('is identity when mediaBase is empty (standalone)', () => {
    expect(resolveTextureSrc('/media/g1/a1/gen1.png', '')).toBe('/media/g1/a1/gen1.png');
  });
  it('leaves a non-root, non-absolute src unchanged (forward-compatible)', () => {
    expect(resolveTextureSrc('bundled/tile.png', 'http://host:8000')).toBe('bundled/tile.png');
  });
});
