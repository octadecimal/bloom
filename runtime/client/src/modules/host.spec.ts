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

  it('emit is best-effort for unknown_node: a missing-parent connect does not throw and leaves model unchanged', () => {
    const { model, host } = setup();
    // 'ghost' does not exist → connect throws unknown_node, which is the only swallowed transient
    expect(() =>
      host.emit([
        {
          kind: 'connect',
          edgeId: 'e',
          type: 'child',
          from: { node: 'ghost', port: 'children' },
          to: { node: 'realChild', port: 'parent' },
        },
      ]),
    ).not.toThrow();
    // model is unchanged — no edge was added
    expect(model.toDocument().edges).toHaveLength(0);
  });

  it('emit rethrows on genuine op bugs (duplicate_id is not swallowed)', () => {
    const { host } = setup();
    host.emit([{ kind: 'addNode', id: 'root', type: 'Root', props: {} }]);
    // duplicate_id is a real bug, not a transient; emit must rethrow
    expect(() =>
      host.emit([
        { kind: 'addNode', id: 'dup', type: 'Sprite', props: {} },
        { kind: 'addNode', id: 'dup', type: 'Sprite', props: {} },
      ]),
    ).toThrow();
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
