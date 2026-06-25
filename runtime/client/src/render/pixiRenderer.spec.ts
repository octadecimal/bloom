import { describe, it, expect } from 'vitest';
import { applyPixiProp, PixiRenderer } from './pixiRenderer';

function fakeObj() {
  return {
    position: {
      x: 0,
      y: 0,
      set(x: number, y: number) {
        this.x = x;
        this.y = y;
      },
    },
    scale: {
      x: 1,
      y: 1,
      set(x: number, y: number) {
        this.x = x;
        this.y = y;
      },
    },
    anchor: {
      x: 0,
      y: 0,
      set(x: number, y: number) {
        this.x = x;
        this.y = y;
      },
    },
    rotation: 0,
    alpha: 1,
    visible: true,
    zIndex: 0,
  };
}

describe('applyPixiProp', () => {
  it('maps nested position', () => {
    const o = fakeObj();
    applyPixiProp(o as never, 'position.x', 240);
    expect(o.position.x).toBe(240);
  });
  it('maps whole position object', () => {
    const o = fakeObj();
    applyPixiProp(o as never, 'position', { x: 10, y: 20 });
    expect(o.position).toMatchObject({ x: 10, y: 20 });
  });
  it('maps scalars', () => {
    const o = fakeObj();
    applyPixiProp(o as never, 'alpha', 0.5);
    applyPixiProp(o as never, 'zIndex', 7);
    applyPixiProp(o as never, 'visible', false);
    expect(o.alpha).toBe(0.5);
    expect(o.zIndex).toBe(7);
    expect(o.visible).toBe(false);
  });
  it('defaults a missing scale axis to 1, not 0', () => {
    const o = fakeObj();
    applyPixiProp(o as never, 'scale', { x: 2 });
    expect(o.scale.x).toBe(2);
    expect(o.scale.y).toBe(1);
  });
  it('defaults a missing position axis to 0', () => {
    const o = fakeObj();
    applyPixiProp(o as never, 'position', { x: 10 });
    expect(o.position.x).toBe(10);
    expect(o.position.y).toBe(0);
  });
});

describe('PixiRenderer.createObject', () => {
  it('defaults a new Sprite to a centered anchor (0.5, 0.5)', () => {
    const r = new PixiRenderer(document.createElement('div'));
    r.createObject('s', 'Sprite');
    expect(r.anchorOf('s')).toEqual({ x: 0.5, y: 0.5 });
  });

  it('lets an explicit anchor prop override the default', () => {
    const r = new PixiRenderer(document.createElement('div'));
    r.createObject('s', 'Sprite');
    r.setProp('s', 'anchor', { x: 0, y: 0 });
    expect(r.anchorOf('s')).toEqual({ x: 0, y: 0 });
  });
});
