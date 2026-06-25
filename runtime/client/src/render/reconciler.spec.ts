import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { Reconciler } from './reconciler';
import type { IRenderer, ITextureHandle } from './renderer';

class FakeRenderer implements IRenderer {
  loaded: string[] = [];
  assigned: Array<[string, ITextureHandle | null]> = [];
  async mount() {}
  createObject() {}
  destroyObject() {}
  setParent() {}
  setProp() {}
  async loadTexture(src: string): Promise<ITextureHandle> {
    this.loaded.push(src);
    return { src } as unknown as ITextureHandle;
  }
  assignTexture(id: string, t: ITextureHandle | null) {
    this.assigned.push([id, t]);
  }
}

describe('reconciler texture rebind', () => {
  it('reloads and reassigns a sprite when its Texture src changes', async () => {
    const model = new GraphModel();
    const r = new FakeRenderer();
    const rec = new Reconciler(r, model);
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 'spr', type: 'Sprite', props: {} }));
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: '/old.png' } }));
    await rec.applyChanges(
      model.apply({ kind: 'connect', edgeId: 'd', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 'spr', port: 'texture' } }),
    );
    r.loaded.length = 0;
    r.assigned.length = 0;
    await rec.applyChanges(model.apply({ kind: 'setProp', id: 'tex', path: 'src', value: '/new.png' }));
    expect(r.loaded).toContain('/new.png');
    expect(r.assigned.map(([id]) => id)).toContain('spr');
  });
});
