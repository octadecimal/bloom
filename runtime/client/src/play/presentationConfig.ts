import type { JsonValue } from '../model/document';
import type { IHandshakeResponse, IPresentation } from './wireTypes';

/** A play-mode failure surfaced to the player (handshake/spin/validation). */
export class PlayModeError extends Error {}

/** Narrow an opaque handshake to a playable slots@1 presentation, or throw a
 *  PlayModeError the caller renders visibly (never a silent blank scene). */
export function validatePresentation(hs: IHandshakeResponse): IPresentation {
  if (hs.mechanic !== 'slots@1') {
    throw new PlayModeError(`unsupported mechanic: ${hs.mechanic}`);
  }
  const p = hs.presentation;
  if (!p || typeof p !== 'object') {
    throw new PlayModeError('handshake presentation is empty');
  }
  const rec = p as Record<string, unknown>;
  if (typeof rec.cols !== 'number' || typeof rec.rows !== 'number' || !Array.isArray(rec.symbols)) {
    throw new PlayModeError('handshake presentation missing cols/rows/symbols');
  }
  return p as IPresentation;
}

/** Map the presentation to the reels module's config fields, defaulting the
 *  parent; the module supplies defaults for everything else (cellSize, spacing). */
export function toReelsConfig(p: IPresentation): Record<string, JsonValue> {
  return {
    cols: p.cols,
    rows: p.rows,
    symbols: p.symbols,
    parentId: p.parentId ?? 'root',
  };
}
