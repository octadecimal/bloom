import { describe, it, expect, vi } from 'vitest';
import { BlurFilter } from 'pixi.js';
import { PixiRenderer } from './pixiRenderer';

function rendererWithSprite(id: string): PixiRenderer {
  const r = new PixiRenderer(document.createElement('div'));
  r.createObject(id, 'Sprite');
  return r;
}

describe('PixiRenderer.getHandle', () => {
  it('returns null for an unknown id', () => {
    const r = new PixiRenderer(document.createElement('div'));
    expect(r.getHandle('nope')).toBeNull();
  });

  it('exposes a mutable position bound to the live object', () => {
    const r = rendererWithSprite('s');
    const h = r.getHandle('s')!;
    h.position.y = 42;
    // A fresh handle reflects the same underlying object.
    expect(r.getHandle('s')!.position.y).toBe(42);
  });

  it('setBlur(n) attaches a single BlurFilter at strength n', () => {
    const r = rendererWithSprite('s');
    const h = r.getHandle('s')!;
    h.setBlur(5);
    const filters = filtersOf(r, 's');
    expect(filters).toHaveLength(1);
    expect(filters[0]).toBeInstanceOf(BlurFilter);
    expect((filters[0] as BlurFilter).strength).toBe(5);
  });

  it('setBlur called twice updates strength without stacking filters', () => {
    const r = rendererWithSprite('s');
    const h = r.getHandle('s')!;
    h.setBlur(5);
    h.setBlur(9);
    const filters = filtersOf(r, 's');
    expect(filters).toHaveLength(1);
    expect((filters[0] as BlurFilter).strength).toBe(9);
  });

  it('setBlur(0) clears the filter', () => {
    const r = rendererWithSprite('s');
    const h = r.getHandle('s')!;
    h.setBlur(5);
    h.setBlur(0);
    expect(filtersOf(r, 's')).toHaveLength(0);
  });

  it('onTick returns a no-op unsubscribe before mount (no app/ticker)', () => {
    const r = new PixiRenderer(document.createElement('div'));
    const off = r.onTick(() => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  it('buffers ticks registered before mount and flushes them once the app exists', () => {
    const r = new PixiRenderer(document.createElement('div'));
    const cb = vi.fn();
    r.onTick(cb); // app is null -> buffered, not dropped
    const added: Array<(t: { deltaMS: number }) => void> = [];
    const fakeApp = { ticker: { add: (fn: (t: { deltaMS: number }) => void) => added.push(fn), remove: () => {} } };
    const internals = r as unknown as { app: unknown; flushPendingTicks(): void };
    internals.app = fakeApp;
    internals.flushPendingTicks();
    expect(added).toHaveLength(1);
    added[0]({ deltaMS: 16 }); // simulate a ticker frame
    expect(cb).toHaveBeenCalledWith(16);
  });
});

// Reads the private object map to assert filters; mirrors the injection pattern in pixiRenderer.spec.ts.
function filtersOf(r: PixiRenderer, id: string): unknown[] {
  const objs = (r as unknown as { objects: Map<string, { filters: unknown }> }).objects;
  const f = objs.get(id)!.filters;
  return f == null ? [] : Array.isArray(f) ? f : [f];
}
