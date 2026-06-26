import { describe, it, expect } from 'vitest';
import { advance, wrap, symbolAt, easeOutCubic, settleT, reelDelay, blurFor } from './reelsMath';

describe('reelsMath', () => {
  it('advance moves offset by speed*dt', () => {
    expect(advance(0, 2, 16)).toBe(32);
    expect(advance(10, 0.5, 100)).toBe(60);
  });

  it('wrap keeps offset within [0, span) including negatives', () => {
    expect(wrap(0, 100)).toBe(0);
    expect(wrap(150, 100)).toBe(50);
    expect(wrap(-10, 100)).toBe(90);
  });

  it('symbolAt indexes the strip with wraparound', () => {
    const strip = ['A', 'B', 'C'];
    expect(symbolAt(strip, 0)).toBe('A');
    expect(symbolAt(strip, 3)).toBe('A');
    expect(symbolAt(strip, -1)).toBe('C');
    expect(symbolAt(strip, 4)).toBe('B');
  });

  it('easeOutCubic is 0 at 0, 1 at 1, and clamps out-of-range t', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 5);
  });

  it('settleT is 0 before the delay, ramps to 1 over duration', () => {
    expect(settleT(0, 200, 400)).toBe(0);
    expect(settleT(200, 200, 400)).toBe(0);
    expect(settleT(400, 200, 400)).toBe(0.5);
    expect(settleT(600, 200, 400)).toBe(1);
    expect(settleT(9999, 200, 400)).toBe(1);
  });

  it('reelDelay staggers reels left-to-right', () => {
    expect(reelDelay(0, 120)).toBe(0);
    expect(reelDelay(3, 120)).toBe(360);
  });

  it('blurFor is proportional to speed and capped at maxBlur', () => {
    expect(blurFor(0, 8, 4)).toBe(0);
    expect(blurFor(2, 8, 4)).toBe(4);
    expect(blurFor(4, 8, 4)).toBe(8);
    expect(blurFor(100, 8, 4)).toBe(8);
  });
});
