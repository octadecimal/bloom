import { describe, it, expect } from 'vitest';
import { createBus } from '../orchestration/bus';
import { MockRenderer } from './mockRenderer';
import { ViewportController, type IHostSurface } from './viewportController';
import type { IViewport } from './viewport';

const SAFE = { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } };

/** A surface whose size is mutable and whose resize callback is captured so tests fire it. */
function fakeSurface(initial: { width: number; height: number }) {
  let size = initial;
  let cb: (() => void) | null = null;
  const surface: IHostSurface = {
    size: () => size,
    onResize: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
  };
  return {
    surface,
    setSize(s: { width: number; height: number }) {
      size = s;
    },
    fire() {
      cb?.();
    },
    get subscribed() {
      return cb !== null;
    },
  };
}

/** A manual scheduler so coalescing is deterministic. */
function manualSchedule() {
  const queue: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
      return () => {
        const i = queue.indexOf(cb);
        if (i >= 0) queue.splice(i, 1);
      };
    },
    flush() {
      const run = [...queue];
      queue.length = 0;
      for (const cb of run) cb();
    },
    get pending() {
      return queue.length;
    },
  };
}

describe('ViewportController', () => {
  it('applies a computed viewport to the renderer on setSafeAreas', () => {
    const f = fakeSurface({ width: 1000, height: 450 });
    const renderer = new MockRenderer();
    const c = new ViewportController({ surface: f.surface, renderer, bus: createBus(), readDpr: () => 1 });
    c.setSafeAreas(SAFE);
    const applied = renderer.calls.find((x) => x[0] === 'applyViewport');
    expect(applied).toBeTruthy();
    const vp = applied![1] as IViewport;
    expect(vp.orientation).toBe('landscape');
    expect(vp.scale).toBeCloseTo(0.625, 6);
    expect(c.current()).toEqual(vp);
  });

  it('emits viewport:changed on first compute and on orientation flip, but not on a same-shape resize', () => {
    const f = fakeSurface({ width: 1000, height: 450 });
    const renderer = new MockRenderer();
    const bus = createBus();
    const events: IViewport[] = [];
    bus.on<IViewport>('viewport:changed', (e) => events.push(e));
    const c = new ViewportController({ surface: f.surface, renderer, bus, schedule: (cb) => (cb(), () => {}), readDpr: () => 1 });

    c.setSafeAreas(SAFE); // first compute -> emit (landscape)
    expect(events).toHaveLength(1);

    f.setSize({ width: 1200, height: 450 }); // wider, still landscape, same safe shape
    f.fire();
    expect(events).toHaveLength(1); // no emit

    f.setSize({ width: 450, height: 1000 }); // portrait now -> emit
    f.fire();
    expect(events).toHaveLength(2);
    expect(events[1].orientation).toBe('portrait');
  });

  it('coalesces multiple resize fires into a single recompute per frame', () => {
    const f = fakeSurface({ width: 1000, height: 450 });
    const renderer = new MockRenderer();
    const sched = manualSchedule();
    const c = new ViewportController({ surface: f.surface, renderer, bus: createBus(), schedule: sched.schedule, readDpr: () => 1 });
    c.setSafeAreas(SAFE);
    const before = renderer.calls.filter((x) => x[0] === 'applyViewport').length;

    f.fire();
    f.fire();
    f.fire();
    expect(sched.pending).toBe(1); // three fires, one scheduled recompute
    sched.flush();
    const after = renderer.calls.filter((x) => x[0] === 'applyViewport').length;
    expect(after).toBe(before + 1);
  });

  it('skips compute when the host has zero size, then recovers', () => {
    const f = fakeSurface({ width: 0, height: 0 });
    const renderer = new MockRenderer();
    const c = new ViewportController({ surface: f.surface, renderer, bus: createBus(), schedule: (cb) => (cb(), () => {}), readDpr: () => 1 });
    c.setSafeAreas(SAFE);
    expect(renderer.calls.some((x) => x[0] === 'applyViewport')).toBe(false);
    expect(c.current()).toBeNull();

    f.setSize({ width: 1000, height: 450 });
    f.fire();
    expect(renderer.calls.some((x) => x[0] === 'applyViewport')).toBe(true);
  });

  it('dispose() unsubscribes from the surface', () => {
    const f = fakeSurface({ width: 1000, height: 450 });
    const c = new ViewportController({ surface: f.surface, renderer: new MockRenderer(), bus: createBus(), readDpr: () => 1 });
    expect(f.subscribed).toBe(true);
    c.dispose();
    expect(f.subscribed).toBe(false);
  });
});
