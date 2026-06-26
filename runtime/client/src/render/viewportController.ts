import type { IEventBus } from '../orchestration/bus';
import { computeViewport, type ISafeAreaDefs, type ISize, type IViewport } from './viewport';
export type { IViewport } from './viewport';

export interface IViewportRenderer {
  applyViewport(vp: IViewport): void;
}

export interface IHostSurface {
  size(): ISize;
  /** Subscribe to size changes; returns an unsubscribe thunk. */
  onResize(cb: () => void): () => void;
}

/** What the reconciler needs from the controller. */
export interface IViewportSink {
  setSafeAreas(defs: ISafeAreaDefs): void;
}

const DEFAULT_SAFE: ISafeAreaDefs = {
  landscape: { width: 800, height: 600 },
  portrait: { width: 800, height: 600 },
};

export class ViewportController implements IViewportSink {
  private readonly surface: IHostSurface;
  private readonly renderer: IViewportRenderer;
  private readonly bus: IEventBus;
  private safeAreas: ISafeAreaDefs = DEFAULT_SAFE;
  private last: IViewport | null = null;
  private scheduled = false;
  private cancel: (() => void) | null = null;
  private readonly unsub: () => void;
  private readonly schedule: (cb: () => void) => () => void;
  private readonly readDpr: () => number;

  constructor(opts: { surface: IHostSurface; renderer: IViewportRenderer; bus: IEventBus; schedule?: (cb: () => void) => () => void; readDpr?: () => number }) {
    this.surface = opts.surface;
    this.renderer = opts.renderer;
    this.bus = opts.bus;
    this.schedule = opts.schedule ?? rafSchedule;
    this.readDpr = opts.readDpr ?? (() => globalThis.devicePixelRatio ?? 1);
    this.unsub = this.surface.onResize(() => this.requestRecompute());
  }

  setSafeAreas(defs: ISafeAreaDefs): void {
    this.safeAreas = defs;
    this.recompute();
  }

  current(): IViewport | null {
    return this.last;
  }

  recompute(): void {
    const size = this.surface.size();
    if (size.width <= 0 || size.height <= 0) return;
    const dpr = Math.min(this.readDpr(), 2);
    const vp = computeViewport(size, this.safeAreas, dpr);
    this.renderer.applyViewport(vp);
    if (shapeChanged(this.last, vp)) this.bus.emit('viewport:changed', vp);
    this.last = vp;
  }

  dispose(): void {
    this.unsub();
    this.cancel?.();
    this.cancel = null;
    this.scheduled = false;
  }

  private requestRecompute(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.cancel = this.schedule(() => {
      this.scheduled = false;
      this.cancel = null;
      this.recompute();
    });
  }
}

function shapeChanged(prev: IViewport | null, next: IViewport): boolean {
  return !prev || prev.orientation !== next.orientation || prev.safeArea.width !== next.safeArea.width || prev.safeArea.height !== next.safeArea.height;
}

function rafSchedule(cb: () => void): () => void {
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
}

/** Real DOM surface: measures the element and observes it with ResizeObserver,
 *  falling back to a window resize listener where ResizeObserver is unavailable. */
export function domHostSurface(el: HTMLElement): IHostSurface {
  return {
    size: () => ({ width: el.clientWidth, height: el.clientHeight }),
    onResize: (cb) => {
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => cb());
        ro.observe(el);
        return () => ro.disconnect();
      }
      const handler = () => cb();
      window.addEventListener('resize', handler);
      return () => window.removeEventListener('resize', handler);
    },
  };
}
