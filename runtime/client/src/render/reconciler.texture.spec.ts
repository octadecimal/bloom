import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from './mockRenderer';
import { Reconciler } from './reconciler';

async function sceneWithBoundTexture() {
  const model = new GraphModel();
  const r = new MockRenderer();
  const rec = new Reconciler(r, model);
  await rec.applyChanges(model.apply({ kind: 'addNode', id: 's', type: 'Sprite' }));
  await rec.applyChanges(model.apply({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: 'asset:1' } }));
  await rec.applyChanges(model.apply({ kind: 'connect', edgeId: 'e1', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 's', port: 'texture' } }));
  return { model, r, rec };
}

describe('Reconciler texture data edges', () => {
  it('loads and assigns texture on dataBound', async () => {
    const { r } = await sceneWithBoundTexture();
    expect(r.calls).toContainEqual(['loadTexture', 'asset:1']);
    expect(r.calls).toContainEqual(['assignTexture', 's', { src: 'asset:1' }]);
  });

  it('clears texture on dataUnbound', async () => {
    const { model, r, rec } = await sceneWithBoundTexture();
    await rec.applyChanges(model.apply({ kind: 'disconnect', edgeId: 'e1' }));
    expect(r.calls).toContainEqual(['assignTexture', 's', null]);
  });

  it('re-pushes to bound sprites when Texture.src changes', async () => {
    const { model, r, rec } = await sceneWithBoundTexture();
    r.calls.length = 0;
    await rec.applyChanges(model.apply({ kind: 'setProp', id: 'tex', path: 'src', value: 'asset:2' }));
    expect(r.calls).toContainEqual(['loadTexture', 'asset:2']);
    expect(r.calls).toContainEqual(['assignTexture', 's', { src: 'asset:2' }]);
  });
});
