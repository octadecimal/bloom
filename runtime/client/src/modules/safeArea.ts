import type { IGameDocument } from '../model/document';

/** The Root's landscape safe area, defaulting to 1280×720. Extracted from
 *  ReelsModule so meter and reels center against the same frame. */
export function landscapeSafeArea(doc: IGameDocument): { width: number; height: number } {
  const root = Object.values(doc.nodes).find((n) => n.type === 'Root');
  const land = (root?.props?.safeArea as { landscape?: { width?: number; height?: number } } | undefined)?.landscape;
  const w = typeof land?.width === 'number' && land.width > 0 ? land.width : 1280;
  const h = typeof land?.height === 'number' && land.height > 0 ? land.height : 720;
  return { width: w, height: h };
}
