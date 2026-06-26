import { describe, it, expect } from 'vitest';
import { MockRenderer } from './mockRenderer';

describe('MockRenderer', () => {
  it('records calls and returns a texture handle', async () => {
    const r = new MockRenderer();
    r.mount('root');
    r.createObject('s', 'Sprite');
    r.setProp('s', 'alpha', 0.5);
    const tex = await r.loadTexture('asset:1');
    r.assignTexture('s', tex);
    expect(tex).toEqual({ src: 'asset:1' });
    expect(r.calls).toEqual([
      ['mount', 'root'],
      ['createObject', 's', 'Sprite'],
      ['setProp', 's', 'alpha', 0.5],
      ['loadTexture', 'asset:1'],
      ['assignTexture', 's', { src: 'asset:1' }],
    ]);
  });

  it('records applyViewport calls', () => {
    const r = new MockRenderer();
    const vp = {
      orientation: 'landscape' as const,
      safeArea: { width: 1280, height: 720 },
      scale: 0.625,
      offset: { x: 100, y: 0 },
      canvas: { width: 1000, height: 450 },
      dpr: 1,
    };
    r.applyViewport(vp);
    expect(r.calls).toEqual([['applyViewport', vp]]);
  });
});
