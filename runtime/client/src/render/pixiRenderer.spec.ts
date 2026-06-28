import { describe, it, expect } from 'vitest';
import { Container, Sprite, Text } from 'pixi.js';
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

describe('PixiRenderer.applyLabel', () => {
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

  it('places the label as a sibling in the cell parent (never Sprite.addChild), tracking the cell position', () => {
    const { r, internals } = rendererWithStage();
    r.createObject('reel', 'Container');
    r.setParent('reel', 'root');
    r.createObject('cell', 'Sprite');
    r.setProp('cell', 'position', { x: 0, y: 108 });
    r.setProp('cell', 'label', 'A');
    r.setParent('cell', 'reel');

    const reel = internals.objects.get('reel')! as Container;
    const cell = internals.objects.get('cell')! as unknown as Sprite;
    const label = internals.labels.get('cell')!;
    expect(label.text).toBe('A');
    expect(label.parent).toBe(reel); // a real Container child — no deprecation
    expect(cell.children.length).toBe(0); // nothing added to the Sprite itself
    expect(label.position.x).toBe(0);
    expect(label.position.y).toBe(108);
  });

  it('updates an existing label in place without re-adding', () => {
    const { r, internals } = rendererWithStage();
    r.createObject('reel', 'Container');
    r.setParent('reel', 'root');
    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'reel');
    r.setProp('cell', 'label', 'A');
    const first = internals.labels.get('cell')!;
    r.setProp('cell', 'label', 'B');
    expect(internals.labels.get('cell')).toBe(first);
    expect(first.text).toBe('B');
  });

  it('keeps the label glued when the cell position changes via setProp', () => {
    const { r, internals } = rendererWithStage();
    r.createObject('reel', 'Container');
    r.setParent('reel', 'root');
    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'reel');
    r.setProp('cell', 'label', 'A');

    r.setProp('cell', 'position', { x: 5, y: 200 });
    const label = internals.labels.get('cell')!;
    expect(label.position.x).toBe(5);
    expect(label.position.y).toBe(200);

    r.setProp('cell', 'position.y', 264);
    expect(label.position.y).toBe(264);
  });

  it('re-homes the label when the cell is moved to a different reel', () => {
    const { r, internals } = rendererWithStage();
    r.createObject('reel1', 'Container');
    r.setParent('reel1', 'root');
    r.createObject('reel2', 'Container');
    r.setParent('reel2', 'root');
    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'reel1');
    r.setProp('cell', 'label', 'A');

    r.setParent('cell', 'reel2');
    const reel2 = internals.objects.get('reel2')! as Container;
    const label = internals.labels.get('cell')!;
    const cell = internals.objects.get('cell')! as unknown as Sprite;
    expect(label.parent).toBe(reel2);
    expect(label.position.x).toBe(cell.position.x);
    expect(label.position.y).toBe(cell.position.y);
  });

  it('removes the label from its parent when the cell is orphaned via setParent(null)', () => {
    const { r, internals } = rendererWithStage();
    r.createObject('reel', 'Container');
    r.setParent('reel', 'root');
    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'reel');
    r.setProp('cell', 'label', 'A');

    const label = internals.labels.get('cell')!;
    expect(label.parent).not.toBeNull();

    r.setParent('cell', null);
    expect(label.parent).toBeNull();
  });
});

describe('PixiRenderer.onStage', () => {
  it('is true for an object parented to the stage, false for an orphan or unknown id', () => {
    const r = new PixiRenderer(document.createElement('div'));
    // jsdom has no WebGL, so the real mount()/app.init() can't run. Stand in a real
    // Pixi stage Container the way mount() does (objects[root] = app.stage), then
    // exercise the real createObject/setParent/onStage scene-graph walk.
    const stage = new Container();
    const internals = r as unknown as {
      app: { stage: Container };
      rootId: string;
      objects: Map<string, Container>;
    };
    internals.app = { stage };
    internals.rootId = 'root';
    internals.objects.set('root', stage);

    r.createObject('s', 'Sprite');
    r.setParent('s', 'root');
    expect(r.onStage('s')).toBe(true); // parented up to the stage

    r.createObject('orphan', 'Sprite'); // created but never parented
    expect(r.onStage('orphan')).toBe(false);

    expect(r.onStage('ghost')).toBe(false); // unknown id
  });
});

describe('PixiRenderer.mount idempotency', () => {
  it('a second mount reuses the existing Application/canvas and resets the scene to bare root', async () => {
    const r = new PixiRenderer(document.createElement('div'));
    const stage = new Container();
    stage.sortableChildren = true;
    const fakeApp = { stage, canvas: document.createElement('canvas'), ticker: { add() {}, remove() {} } };
    const internals = r as unknown as {
      app: unknown;
      rootId: string;
      objects: Map<string, Container>;
      labels: Map<string, Text>;
    };
    internals.app = fakeApp;
    internals.rootId = 'root';
    internals.objects.set('root', stage);

    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'root');
    expect(stage.children.length).toBe(1);

    await r.mount('root'); // re-init — must NOT build a new Application

    expect(internals.app).toBe(fakeApp); // same app reused — no second canvas
    expect(stage.children.length).toBe(0); // scene torn down
    expect(internals.objects.size).toBe(1); // only root remains
    expect(internals.objects.get('root')).toBe(stage);
  });

  it('resetScene tears down a nested reel tree (root → reel Container → cell Sprite + label) without throwing', async () => {
    const r = new PixiRenderer(document.createElement('div'));
    const stage = new Container();
    stage.sortableChildren = true;
    const fakeApp = { stage, canvas: document.createElement('canvas'), ticker: { add() {}, remove() {} } };
    const internals = r as unknown as {
      app: unknown;
      rootId: string;
      objects: Map<string, Container>;
      labels: Map<string, Text>;
    };
    internals.app = fakeApp;
    internals.rootId = 'root';
    internals.objects.set('root', stage);

    // Build nested tree: root → reel Container → cell Sprite + sibling label Text
    r.createObject('reel', 'Container');
    r.setParent('reel', 'root');
    r.createObject('cell', 'Sprite');
    r.setParent('cell', 'reel');
    r.setProp('cell', 'label', 'A'); // label sits as a sibling in reel, tracked in labels map

    // Pre-state: reel is the only direct child of stage; label is tracked
    expect(stage.children.length).toBe(1); // the reel Container
    expect(internals.labels.size).toBe(1); // the label Text for 'cell'

    // Re-init — must NOT throw even when destroying nested objects
    await r.mount('root');

    expect(internals.app).toBe(fakeApp); // same Application reused — no second canvas
    expect(stage.children.length).toBe(0); // entire hierarchy torn down
    expect(internals.objects.size).toBe(1); // only root remains
    expect(internals.objects.get('root')).toBe(stage);
    expect(internals.labels.size).toBe(0); // labels map cleared
  });
});
