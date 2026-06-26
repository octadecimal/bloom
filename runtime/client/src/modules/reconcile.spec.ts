import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { reconcileOps, type IDesiredScene } from './reconcile';

const owns = (id: string) => id.startsWith('m:');

function modelWith(ops: Parameters<GraphModel['apply']>[0][]): GraphModel {
  const m = new GraphModel();
  m.apply({ kind: 'addNode', id: 'root', type: 'Root', props: {} });
  m.applyBatch(ops);
  return m;
}

describe('reconcileOps', () => {
  it('emits addNode + child connect for a desired node not present', () => {
    const m = modelWith([]);
    const desired: IDesiredScene = {
      nodes: [{ id: 'm:reel:0', type: 'Container', props: { zIndex: 0 }, parent: 'root' }],
    };
    const ops = reconcileOps(m.toDocument(), desired, owns);
    expect(ops).toEqual([
      { kind: 'addNode', id: 'm:reel:0', type: 'Container', props: { zIndex: 0 } },
      { kind: 'connect', edgeId: 'child:m:reel:0', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'm:reel:0', port: 'parent' } },
    ]);
    expect(() => m.applyBatch(ops)).not.toThrow();
  });

  it('is idempotent: reprojecting the same desired set yields no ops', () => {
    const m = modelWith([]);
    const desired: IDesiredScene = {
      nodes: [{ id: 'm:reel:0', type: 'Container', props: { zIndex: 0 }, parent: 'root' }],
    };
    m.applyBatch(reconcileOps(m.toDocument(), desired, owns));
    const second = reconcileOps(m.toDocument(), desired, owns);
    expect(second).toEqual([]);
  });

  it('emits setProp only for props whose value changed', () => {
    const m = modelWith([{ kind: 'addNode', id: 'm:reel:0', type: 'Container', props: { zIndex: 0, alpha: 1 } }]);
    const desired: IDesiredScene = {
      nodes: [{ id: 'm:reel:0', type: 'Container', props: { zIndex: 5, alpha: 1 }, parent: null }],
    };
    const ops = reconcileOps(m.toDocument(), desired, owns);
    expect(ops).toEqual([{ kind: 'setProp', id: 'm:reel:0', path: 'zIndex', value: 5 }]);
  });

  it('removes an owned node that is no longer desired', () => {
    const m = modelWith([{ kind: 'addNode', id: 'm:reel:0', type: 'Container', props: {} }]);
    const desired: IDesiredScene = { nodes: [] };
    const ops = reconcileOps(m.toDocument(), desired, owns);
    expect(ops).toEqual([{ kind: 'removeNode', id: 'm:reel:0' }]);
  });

  it('never removes a node it does not own', () => {
    const m = modelWith([{ kind: 'addNode', id: 'hand:authored', type: 'Sprite', props: {} }]);
    const desired: IDesiredScene = { nodes: [] };
    const ops = reconcileOps(m.toDocument(), desired, owns);
    expect(ops).toEqual([]);
  });

  it('a config change (cols 1 -> 2) adds the new reel without duplicating the existing one', () => {
    const m = modelWith([]);
    const one: IDesiredScene = { nodes: [{ id: 'm:reel:0', type: 'Container', props: {}, parent: 'root' }] };
    m.applyBatch(reconcileOps(m.toDocument(), one, owns));
    const two: IDesiredScene = {
      nodes: [
        { id: 'm:reel:0', type: 'Container', props: {}, parent: 'root' },
        { id: 'm:reel:1', type: 'Container', props: {}, parent: 'root' },
      ],
    };
    const ops = reconcileOps(m.toDocument(), two, owns);
    expect(ops).toEqual([
      { kind: 'addNode', id: 'm:reel:1', type: 'Container', props: {} },
      { kind: 'connect', edgeId: 'child:m:reel:1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'm:reel:1', port: 'parent' } },
    ]);
    expect(() => m.applyBatch(ops)).not.toThrow();
  });
});
