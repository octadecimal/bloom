import { describe, it, expect } from 'vitest';
import { advance, wrap, symbolAt, easeOutCubic, settleT, reelDelay, blurFor, settleTarget, settleOffset, finalRow } from './reelsMath';

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

  it('settleTarget is the smallest span multiple at least minTravel past base', () => {
    expect(settleTarget(0, 180, 100)).toBe(200);
    expect(settleTarget(50, 180, 100)).toBe(300);
    expect(settleTarget(20, 180, 100)).toBe(200); // exact multiple stays
    expect(settleTarget(437.5, 180, 108)).toBe(648);
  });

  it('settleOffset runs linear at full speed through the delay, then eases to target', () => {
    // start 100, delay 150 @ 1.2 px/ms -> base 280; target 500.
    expect(settleOffset(0, 150, 600, 100, 500, 1.2)).toBe(100);
    expect(settleOffset(75, 150, 600, 100, 500, 1.2)).toBe(190);
    expect(settleOffset(150, 150, 600, 100, 500, 1.2)).toBe(280);
    expect(settleOffset(450, 150, 600, 100, 500, 1.2)).toBeCloseTo(280 + 220 * easeOutCubic(0.5), 9);
  });

  it('settleOffset lands exactly on target at delay+duration and stays there', () => {
    expect(settleOffset(750, 150, 600, 100, 500, 1.2)).toBe(500);
    expect(settleOffset(9999, 150, 600, 100, 500, 1.2)).toBe(500);
  });

  it('finalRow gives the resting row (top hidden row = -1) for a cell at a span-aligned offset', () => {
    expect(finalRow(0, 100, 100, 4)).toBe(0);
    expect(finalRow(2, 100, 100, 4)).toBe(2);
    expect(finalRow(3, 100, 100, 4)).toBe(-1); // wrapped above the top
    expect(finalRow(2, 300, 100, 4)).toBe(0);
    // agrees with the render-frame position formula
    for (let r = 0; r < 4; r++) {
      expect(finalRow(r, 700, 100, 4) * 100).toBe(wrap(r * 100 + 700, 400) - 100);
    }
  });
});
