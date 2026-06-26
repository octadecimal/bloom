import { describe, it, expect } from 'vitest';
import { MockRenderer } from './render/mockRenderer';
import { createEngine } from './engine';
import type { IHostSurface, IViewport } from './render/viewportController';

describe('createEngine viewport wiring', () => {
  it('applies a viewport on Root creation when a surface is supplied', async () => {
    const renderer = new MockRenderer();
    const surface: IHostSurface = { size: () => ({ width: 1000, height: 450 }), onResize: () => () => {} };
    const { host, viewport } = createEngine({ renderer, post: () => {}, surface });
    await host.handle({
      v: 1,
      kind: 'init',
      id: 'i',
      document: {
        version: 1,
        nodes: {
          root: {
            id: 'root',
            type: 'Root',
            props: { safeArea: { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } } },
          },
        },
        edges: [],
      },
    });
    const applied = renderer.calls.find((x) => x[0] === 'applyViewport');
    expect(applied).toBeTruthy();
    expect((applied![1] as IViewport).orientation).toBe('landscape');
    expect(viewport?.current()?.scale).toBeCloseTo(0.625, 6);
  });

  it('works headless (no surface) — no applyViewport, no throw', async () => {
    const renderer = new MockRenderer();
    const { host, viewport } = createEngine({ renderer, post: () => {} });
    await host.handle({
      v: 1,
      kind: 'init',
      id: 'i',
      document: { version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] },
    });
    expect(renderer.calls.some((x) => x[0] === 'applyViewport')).toBe(false);
    expect(viewport).toBeUndefined();
  });
});
