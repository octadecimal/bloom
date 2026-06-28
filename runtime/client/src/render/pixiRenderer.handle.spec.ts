import { describe, it, expect, vi } from 'vitest';
import { BlurFilter, Container, Sprite, Text } from 'pixi.js';
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

describe('PixiRenderer.getHandle label tracking', () => {
  function rendererWithStage() {
    const r = new PixiRenderer(document.createElement('div'));
    const stage = new Container();
    stage.sortableChildren = true;
    const internals = r as unknown as {
      app: { stage: Container };
      rootId: string;
      objects: Map<string, Container>;
      labels: Map<string, Text>;
    };
    internals.app = { stage };
    internals.rootId = 'root';
    internals.objects.set('root', stage);
    return { r, internals };
  }

  it('mirrors handle.position.y and .x writes to the sibling label', () => {
    const { r, internals } = rendererWithStage();
    r.createObject('reel', 'Container');
    r.setParent('reel', 'root');
    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'reel');
    r.setProp('cell', 'label', 'A');

    const handle = r.getHandle('cell')!;
    handle.position.y = 250;
    handle.position.x = 30;

    const cell = internals.objects.get('cell')! as unknown as Sprite;
    const label = internals.labels.get('cell')!;

    expect(cell.position.y).toBe(250);
    expect(cell.position.x).toBe(30);
    expect(label.position.y).toBe(250);
    expect(label.position.x).toBe(30);
  });

  it('a position write through the handle is reflected by a fresh getHandle', () => {
    const { r } = rendererWithStage();
    r.createObject('reel', 'Container');
    r.setParent('reel', 'root');
    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'reel');
    r.setProp('cell', 'label', 'A');

    const handle = r.getHandle('cell')!;
    handle.position.y = 99;
    expect(r.getHandle('cell')!.position.y).toBe(99);
  });

  it('does not throw when writing handle.position without a label', () => {
    const { r } = rendererWithStage();
    r.createObject('reel', 'Container');
    r.setParent('reel', 'root');
    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'reel');
    // No label set

    const handle = r.getHandle('cell')!;
    expect(() => {
      handle.position.y = 150;
      handle.position.x = 20;
    }).not.toThrow();
    const cell = (r as unknown as { objects: Map<string, { position: { x: number; y: number } }> }).objects.get('cell')!;
    expect(cell.position.y).toBe(150);
    expect(cell.position.x).toBe(20);
  });
});

// Reads the private object map to assert filters; mirrors the injection pattern in pixiRenderer.spec.ts.
function filtersOf(r: PixiRenderer, id: string): unknown[] {
  const objs = (r as unknown as { objects: Map<string, { filters: unknown }> }).objects;
  const f = objs.get(id)!.filters;
  return f == null ? [] : Array.isArray(f) ? f : [f];
}
