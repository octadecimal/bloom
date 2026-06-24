import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from './mockRenderer';
import { Reconciler } from './reconciler';

describe('Reconciler node lifecycle + hierarchy', () => {
  it('mounts Root, creates display objects, skips Texture, parents children', async () => {
    const model = new GraphModel();
    const r = new MockRenderer();
    const rec = new Reconciler(r, model);

    await rec.applyChanges(model.apply({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 1280, height: 720 } }));
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 's', type: 'Sprite' }));
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: 'asset:1' } }));
    await rec.applyChanges(
      model.apply({ kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } }),
    );

    expect(r.calls).toContainEqual(['mount', 'root', { width: 1280, height: 720 }]);
    expect(r.calls).toContainEqual(['createObject', 's', 'Sprite']);
    expect(r.calls.find((c) => c[0] === 'createObject' && c[1] === 'tex')).toBeUndefined();
    expect(r.calls).toContainEqual(['setParent', 's', 'root']);
  });

  it('destroys on nodeRemoved', async () => {
    const model = new GraphModel();
    const r = new MockRenderer();
    const rec = new Reconciler(r, model);
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 's', type: 'Sprite' }));
    await rec.applyChanges(model.apply({ kind: 'removeNode', id: 's' }));
    expect(r.calls).toContainEqual(['destroyObject', 's']);
  });
});
