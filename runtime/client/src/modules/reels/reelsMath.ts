/** Advance a scroll offset by speed (px/ms) over dt (ms). */
export function advance(offset: number, speedPxPerMs: number, dtMs: number): number {
  return offset + speedPxPerMs * dtMs;
}

/** Wrap a value into [0, span), handling negatives. */
export function wrap(offset: number, span: number): number {
  return ((offset % span) + span) % span;
}

/** Strip lookup with wraparound (supports negative absolute rows). */
export function symbolAt(strip: string[], absoluteRow: number): string {
  const n = strip.length;
  return strip[((absoluteRow % n) + n) % n];
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Ease-out cubic; t clamped to [0,1]. */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

/** Settle progress in [0,1] after a per-reel delay. 0 until delay, then linear over duration. */
export function settleT(elapsedMs: number, delayMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  return clamp01((elapsedMs - delayMs) / durationMs);
}

/** Left-to-right stagger: reel `i` starts settling `i * perReelMs` after stop. */
export function reelDelay(reelIndex: number, perReelMs: number): number {
  return reelIndex * perReelMs;
}

/** Motion blur proportional to speed, capped at maxBlur. refSpeed maps to maxBlur. */
export function blurFor(speedPxPerMs: number, maxBlur: number, refSpeed: number): number {
  if (refSpeed <= 0) return 0;
  return Math.min(maxBlur, (Math.abs(speedPxPerMs) / refSpeed) * maxBlur);
}
