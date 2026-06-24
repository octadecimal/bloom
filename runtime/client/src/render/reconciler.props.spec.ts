import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from './mockRenderer';
import { Reconciler } from './reconciler';

describe('Reconciler props', () => {
  it('applies initial props on create', async () => {
    const model = new GraphModel();
    const r = new MockRenderer();
    const rec = new Reconciler(r, model);
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 's', type: 'Sprite', props: { alpha: 0.5, zIndex: 2 } }));
    expect(r.calls).toContainEqual(['setProp', 's', 'alpha', 0.5]);
    expect(r.calls).toContainEqual(['setProp', 's', 'zIndex', 2]);
  });

  it('forwards a later propSet', async () => {
    const model = new GraphModel();
    const r = new MockRenderer();
    const rec = new Reconciler(r, model);
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 's', type: 'Sprite' }));
    await rec.applyChanges(model.apply({ kind: 'setProp', id: 's', path: 'position.x', value: 240 }));
    expect(r.calls).toContainEqual(['setProp', 's', 'position.x', 240]);
  });
});
