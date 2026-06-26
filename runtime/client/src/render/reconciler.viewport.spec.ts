import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from './mockRenderer';
import { Reconciler } from './reconciler';
import type { ISafeAreaDefs } from './viewport';

function fakeSink() {
  const defs: ISafeAreaDefs[] = [];
  return { defs, setSafeAreas: (d: ISafeAreaDefs) => defs.push(d) };
}

describe('Reconciler viewport wiring', () => {
  it('pushes resolved safe areas to the sink on Root creation', async () => {
    const model = new GraphModel();
    const sink = fakeSink();
    const r = new Reconciler(new MockRenderer(), model, sink);
    const changes = model.apply({
      kind: 'addNode',
      id: 'root',
      type: 'Root',
      props: { safeArea: { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } } },
    });
    await r.applyChanges(changes);
    expect(sink.defs[0]).toEqual({ landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } });
  });

  it('falls back to width/height when safeArea is absent', async () => {
    const model = new GraphModel();
    const sink = fakeSink();
    const r = new Reconciler(new MockRenderer(), model, sink);
    const changes = model.apply({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } });
    await r.applyChanges(changes);
    expect(sink.defs[0]).toEqual({ landscape: { width: 640, height: 480 }, portrait: { width: 640, height: 480 } });
  });

  it('re-resolves when a safeArea prop changes', async () => {
    const model = new GraphModel();
    const sink = fakeSink();
    const r = new Reconciler(new MockRenderer(), model, sink);
    await r.applyChanges(model.apply({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } }));
    const changes = model.apply({
      kind: 'setProp',
      id: 'root',
      path: 'safeArea',
      value: { landscape: { width: 1000, height: 500 }, portrait: { width: 500, height: 1000 } },
    });
    await r.applyChanges(changes);
    expect(sink.defs.at(-1)).toEqual({ landscape: { width: 1000, height: 500 }, portrait: { width: 500, height: 1000 } });
  });

  it('does not re-resolve on an unrelated Root prop change', async () => {
    const model = new GraphModel();
    const sink = fakeSink();
    const r = new Reconciler(new MockRenderer(), model, sink);
    await r.applyChanges(model.apply({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } }));
    const countAfterCreate = sink.defs.length;
    await r.applyChanges(model.apply({ kind: 'setProp', id: 'root', path: 'alpha', value: 0.5 }));
    expect(sink.defs.length).toBe(countAfterCreate);
  });
});
