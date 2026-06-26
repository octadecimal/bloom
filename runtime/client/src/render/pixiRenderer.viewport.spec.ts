import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { PixiRenderer } from './pixiRenderer';

describe('PixiRenderer.applyViewport', () => {
  it('resizes the canvas to host size and sets the root scale + offset', () => {
    const r = new PixiRenderer(document.createElement('div'));
    // jsdom has no WebGL, so the real mount()/app.init() cannot run. Inject a fake
    // app (resize spy) plus a real Pixi stage Container the way mount() does.
    const resized: Array<[number, number]> = [];
    const stage = new Container();
    const internals = r as unknown as {
      app: { renderer: { resize(w: number, h: number): void } };
      rootId: string;
      objects: Map<string, Container>;
    };
    internals.app = { renderer: { resize: (w, h) => resized.push([w, h]) } };
    internals.rootId = 'root';
    internals.objects.set('root', stage);

    r.applyViewport({
      orientation: 'landscape',
      safeArea: { width: 1280, height: 720 },
      scale: 0.625,
      offset: { x: 100, y: 0 },
      canvas: { width: 1000, height: 450 },
      dpr: 1,
    });

    expect(resized).toEqual([[1000, 450]]);
    expect(stage.scale.x).toBeCloseTo(0.625, 6);
    expect(stage.scale.y).toBeCloseTo(0.625, 6);
    expect(stage.position.x).toBe(100);
    expect(stage.position.y).toBe(0);
  });

  it('is a no-op before mount (no app)', () => {
    const r = new PixiRenderer(document.createElement('div'));
    expect(() =>
      r.applyViewport({
        orientation: 'landscape',
        safeArea: { width: 800, height: 600 },
        scale: 1,
        offset: { x: 0, y: 0 },
        canvas: { width: 800, height: 600 },
        dpr: 1,
      }),
    ).not.toThrow();
  });
});
