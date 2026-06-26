import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { Reconciler } from '../render/reconciler';
import { MockRenderer } from '../render/mockRenderer';
import { createBus } from '../orchestration/bus';
import { createModuleHost } from './host';

function setup() {
  const model = new GraphModel();
  const renderer = new MockRenderer();
  const reconciler = new Reconciler(renderer, model);
  const bus = createBus();
  const host = createModuleHost({ model, reconciler, renderer, bus });
  return { model, renderer, host, bus };
}

describe('createModuleHost', () => {
  it('emit applies ops to the model atomically', () => {
    const { model, host } = setup();
    host.emit([{ kind: 'addNode', id: 'root', type: 'Root', props: {} }]);
    expect(model.getNode('root')).toBeTruthy();
  });

  it('emit rolls back the whole batch if any op fails (atomic)', () => {
    const { model, host } = setup();
    host.emit([{ kind: 'addNode', id: 'root', type: 'Root', props: {} }]);
    // second op is invalid (duplicate id) => batch should roll back, leaving only root
    expect(() =>
      host.emit([
        { kind: 'addNode', id: 'a', type: 'Container', props: {} },
        { kind: 'addNode', id: 'a', type: 'Container', props: {} },
      ]),
    ).toThrow();
    expect(model.getNode('a')).toBeUndefined();
  });

  it('snapshot reflects the current model document', () => {
    const { host } = setup();
    host.emit([{ kind: 'addNode', id: 'root', type: 'Root', props: {} }]);
    expect(host.snapshot().nodes.root).toBeTruthy();
  });

  it('resolve delegates to the renderer getHandle', () => {
    const { host } = setup();
    expect(host.resolve('anything')).not.toBeNull(); // MockRenderer lazily makes handles
  });

  it('onTick delegates to the renderer and returns an unsubscribe', () => {
    const { host, renderer } = setup();
    const off = host.onTick(() => {});
    expect(renderer.tickCbs).toHaveLength(1);
    off();
    expect(renderer.tickCbs).toHaveLength(0);
  });

  it('exposes the same bus instance', () => {
    const { host, bus } = setup();
    expect(host.bus).toBe(bus);
  });
});
