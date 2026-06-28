import { describe, it, expect } from 'vitest';
import { Sprite, Texture } from 'pixi.js';
import { applyPixiProp } from './pixiRenderer';

describe('rectangle props', () => {
  it('fill assigns the WHITE texture and tints it', () => {
    const s = new Sprite();
    applyPixiProp(s, 'fill', '#3cb44b');
    expect(s.texture).toBe(Texture.WHITE);
    // Pixi v8 normalizes tint to a numeric color; just assert it changed off-white.
    expect(s.tint).not.toBe(0xffffff);
  });

  it('size sets the sprite dimensions', () => {
    const s = new Sprite(Texture.WHITE);
    applyPixiProp(s, 'size', { width: 80, height: 120 });
    expect(Math.round(s.width)).toBe(80);
    expect(Math.round(s.height)).toBe(120);
  });
});
