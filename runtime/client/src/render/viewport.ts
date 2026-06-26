import type { JsonValue } from '../model/document';

export interface ISize {
  width: number;
  height: number;
}

export type Orientation = 'landscape' | 'portrait';

export interface ISafeAreaDefs {
  landscape: ISize;
  portrait: ISize;
}

export interface IViewport {
  orientation: Orientation;
  safeArea: ISize;
  scale: number;
  offset: { x: number; y: number };
  canvas: ISize;
  dpr: number;
}

/** Pure fit/center/orientation math. `host` and the active safe rect must be positive;
 *  callers (the controller) guard zero-size before calling. */
export function computeViewport(host: ISize, safe: ISafeAreaDefs, dpr = 1): IViewport {
  const orientation: Orientation = host.width >= host.height ? 'landscape' : 'portrait';
  const safeArea = orientation === 'landscape' ? safe.landscape : safe.portrait;
  const scale = Math.min(host.width / safeArea.width, host.height / safeArea.height);
  const offset = {
    x: (host.width - safeArea.width * scale) / 2,
    y: (host.height - safeArea.height * scale) / 2,
  };
  return { orientation, safeArea, scale, offset, canvas: { width: host.width, height: host.height }, dpr };
}

/** Resolve the two safe rects from Root props, with the back-compat fallback chain:
 *  safeArea.{landscape,portrait} -> a single defined orientation for both ->
 *  width/height for both -> 800x600. */
export function resolveSafeAreas(props: Record<string, JsonValue>): ISafeAreaDefs {
  const sa = props.safeArea;
  const land = readSize(isRecord(sa) ? sa.landscape : undefined);
  const port = readSize(isRecord(sa) ? sa.portrait : undefined);
  if (land && port) return { landscape: land, portrait: port };
  if (land) return { landscape: land, portrait: land };
  if (port) return { landscape: port, portrait: port };
  const w = typeof props.width === 'number' && props.width > 0 ? props.width : 0;
  const h = typeof props.height === 'number' && props.height > 0 ? props.height : 0;
  const fallback: ISize = w > 0 && h > 0 ? { width: w, height: h } : { width: 800, height: 600 };
  return { landscape: fallback, portrait: fallback };
}

function readSize(v: JsonValue | undefined): ISize | null {
  if (!isRecord(v)) return null;
  const w = v.width;
  const h = v.height;
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { width: w, height: h } : null;
}

function isRecord(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: JsonValue | undefined, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}
