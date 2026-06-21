import { describe, it, expect } from 'vitest';
import { avatarHue } from './avatarColor';

describe('avatarHue', () => {
  it('is deterministic for the same seed', () => {
    expect(avatarHue('alice')).toBe(avatarHue('alice'));
  });

  it('returns a hue in [0, 360)', () => {
    for (const s of ['alice', 'bob', 'carol', 'dave', 'eve', '']) {
      const h = avatarHue(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('differs for distinct seeds', () => {
    expect(avatarHue('alice')).not.toBe(avatarHue('bob'));
  });
});
