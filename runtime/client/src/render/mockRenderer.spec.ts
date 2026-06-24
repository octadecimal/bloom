import { describe, it, expect } from 'vitest';
import { MockRenderer } from './mockRenderer';

describe('MockRenderer', () => {
  it('records calls and returns a texture handle', async () => {
    const r = new MockRenderer();
    r.mount('root', { width: 100, height: 100 });
    r.createObject('s', 'Sprite');
    r.setProp('s', 'alpha', 0.5);
    const tex = await r.loadTexture('asset:1');
    r.assignTexture('s', tex);
    expect(tex).toEqual({ src: 'asset:1' });
    expect(r.calls).toEqual([
      ['mount', 'root', { width: 100, height: 100 }],
      ['createObject', 's', 'Sprite'],
      ['setProp', 's', 'alpha', 0.5],
      ['loadTexture', 'asset:1'],
      ['assignTexture', 's', { src: 'asset:1' }],
    ]);
  });
});
