import { describe, it, expect } from 'vitest';
import { computeViewport, resolveSafeAreas } from './viewport';

const SAFE = { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } };

describe('computeViewport', () => {
  it('picks landscape when wider-or-equal, portrait when taller', () => {
    expect(computeViewport({ width: 1000, height: 450 }, SAFE).orientation).toBe('landscape');
    expect(computeViewport({ width: 450, height: 1000 }, SAFE).orientation).toBe('portrait');
  });

  it('treats a square host as landscape (deterministic tiebreak)', () => {
    expect(computeViewport({ width: 500, height: 500 }, SAFE).orientation).toBe('landscape');
  });

  it('scales by the min ratio so the whole safe area fits', () => {
    // landscape 1280x720 into 1000x450 -> min(0.781, 0.625) = 0.625
    expect(computeViewport({ width: 1000, height: 450 }, SAFE).scale).toBeCloseTo(0.625, 6);
  });

  it('centers the safe area, leaving symmetric bleed on the larger axis', () => {
    const vp = computeViewport({ width: 1000, height: 450 }, SAFE);
    // x bleed: (1000 - 1280*0.625)/2 = 100 ; y: (450 - 720*0.625)/2 = 0
    expect(vp.offset).toEqual({ x: 100, y: 0 });
  });

  it('uses the portrait safe rect when portrait', () => {
    const vp = computeViewport({ width: 450, height: 1000 }, SAFE);
    expect(vp.safeArea).toEqual({ width: 720, height: 1280 });
    expect(vp.offset).toEqual({ x: 0, y: 100 });
  });

  it('reports canvas = host size and passes dpr through', () => {
    const vp = computeViewport({ width: 1000, height: 450 }, SAFE, 2);
    expect(vp.canvas).toEqual({ width: 1000, height: 450 });
    expect(vp.dpr).toBe(2);
  });
});

describe('resolveSafeAreas', () => {
  it('reads both orientation rects from safeArea', () => {
    expect(resolveSafeAreas({ safeArea: SAFE })).toEqual(SAFE);
  });

  it('uses a single defined orientation for both', () => {
    const only = { landscape: { width: 1280, height: 720 } };
    expect(resolveSafeAreas({ safeArea: only })).toEqual({
      landscape: { width: 1280, height: 720 },
      portrait: { width: 1280, height: 720 },
    });
  });

  it('falls back to width/height for both orientations when safeArea is absent', () => {
    expect(resolveSafeAreas({ width: 640, height: 480 })).toEqual({
      landscape: { width: 640, height: 480 },
      portrait: { width: 640, height: 480 },
    });
  });

  it('defaults to 800x600 when nothing is provided', () => {
    expect(resolveSafeAreas({})).toEqual({
      landscape: { width: 800, height: 600 },
      portrait: { width: 800, height: 600 },
    });
  });

  it('ignores a malformed safeArea entry (non-numeric / non-positive)', () => {
    expect(resolveSafeAreas({ safeArea: { landscape: { width: 0, height: 720 } }, width: 640, height: 480 })).toEqual({
      landscape: { width: 640, height: 480 },
      portrait: { width: 640, height: 480 },
    });
  });
});
