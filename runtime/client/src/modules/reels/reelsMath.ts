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

/** Smallest multiple of span at least minTravel past base — the settle landing offset. */
export function settleTarget(base: number, minTravel: number, span: number): number {
  return Math.ceil((base + minTravel) / span) * span;
}

/** Positional settle: full-speed linear through the stagger delay, then eased travel to target.
 *  A pure function of elapsed — no per-frame integration, so it lands on target exactly. */
export function settleOffset(elapsedMs: number, delayMs: number, durationMs: number, start: number, target: number, speedPxPerMs: number): number {
  const linear = start + Math.min(elapsedMs, delayMs) * speedPxPerMs;
  const base = start + delayMs * speedPxPerMs;
  return linear + (target - base) * easeOutCubic(settleT(elapsedMs, delayMs, durationMs));
}

/** Resting row (top hidden row = -1) cell `cellIndex` occupies at a span-aligned offset.
 *  Matches the render-frame formula wrap(cellIndex*span + offset, total*span) - span. */
export function finalRow(cellIndex: number, offset: number, span: number, total: number): number {
  return ((cellIndex + Math.round(offset / span)) % total) - 1;
}

/** Motion blur proportional to speed, capped at maxBlur. refSpeed maps to maxBlur. */
export function blurFor(speedPxPerMs: number, maxBlur: number, refSpeed: number): number {
  if (refSpeed <= 0) return 0;
  return Math.min(maxBlur, (Math.abs(speedPxPerMs) / refSpeed) * maxBlur);
}
