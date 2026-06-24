export interface IScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * True when the viewport is at (or within `threshold` px of) the bottom of the
 * scroll container. Used to decide whether streaming content should keep the
 * feed pinned. A zero-size container (jsdom / not yet laid out) reports as
 * pinned — the safe default for a fresh feed.
 */
export function isAtBottom(m: IScrollMetrics, threshold = 48): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}
