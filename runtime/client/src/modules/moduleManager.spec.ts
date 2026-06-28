import { describe, it, expect } from 'vitest';
import { MockRenderer } from '../render/mockRenderer';
import { GraphModel } from '../model/graphModel';
import { Reconciler } from '../render/reconciler';
import { createBus } from '../orchestration/bus';
import { createModuleHost } from './host';
import { ModuleRegistry } from './registry';
import { ModuleManager } from './moduleManager';
import { ReelsModule } from './reels/reelsModule';

function setup() {
  const model = new GraphModel();
  model.apply({ kind: 'addNode', id: 'root', type: 'Root', props: {} });
  const renderer = new MockRenderer();
  const reconciler = new Reconciler(renderer, model);
  const host = createModuleHost({ model, reconciler, renderer, bus: createBus() });
  const registry = new ModuleRegistry();
  registry.register('reels', (args) => new ReelsModule(args));
  return { model, registry, host };
}

describe('ModuleManager', () => {
  it('instantiates + projects a declared reels module', () => {
    const { model, registry, host } = setup();
    const manager = new ModuleManager({ registry, host });
    manager.sync([{ id: 'reels', type: 'reels', config: { parentId: 'root', cols: 3, rows: 3 } }]);
    expect(manager.byType('reels')).toBeTruthy();
    expect(model.getNode('reels:reel:0')).toBeTruthy();
    expect(model.getNode('reels:cell:0:0')).toBeTruthy();
  });

  it('ignores unknown module types', () => {
    const { registry, host } = setup();
    const manager = new ModuleManager({ registry, host });
    manager.sync([{ id: 'x', type: 'nope' }]);
    expect(manager.byType('nope')).toBeUndefined();
  });

  it('re-syncing disposes the old set before rebuilding', () => {
    const { registry, host } = setup();
    const manager = new ModuleManager({ registry, host });
    manager.sync([{ id: 'reels', type: 'reels', config: { parentId: 'root' } }]);
    const first = manager.byType('reels');
    manager.sync([{ id: 'reels', type: 'reels', config: { parentId: 'root' } }]);
    expect(manager.byType('reels')).not.toBe(first);
  });
});
