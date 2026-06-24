import { describe, it, expect } from 'vitest';
import { applyPixiProp } from './pixiRenderer';

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
});
