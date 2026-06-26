// runtime/client/src/modules/reels/reelsModule.project.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { GraphModel } from '../../model/graphModel';
import type { IModuleHost } from '../module';
import { ReelsModule, buildDesired, containerId, cellId } from './reelsModule';

/** Host backed by a real GraphModel so project()'s idempotency is exercised end to end. */
function modelHost(model: GraphModel): IModuleHost {
  return {
    snapshot: () => model.toDocument(),
    emit: (ops) => void model.applyBatch(ops),
    resolve: () => null,
    onTick: () => () => {},
    bus: { on: () => () => {}, off: () => {}, emit: () => {} },
  };
}

const cfg = { rows: 3, cols: 2, symbols: ['A', 'B', 'C'], cellSize: 100, spacing: 0, originX: 0, originY: 0, parentId: 'root', buffer: 1 };

function seededModel(): GraphModel {
  const m = new GraphModel();
  m.apply({ kind: 'addNode', id: 'root', type: 'Root', props: {} });
  return m;
}

describe('buildDesired', () => {
  it('produces one Container per column and (rows+buffer) Sprites per column with stable ids', () => {
    const desired = buildDesired('m', cfg);
    const ids = desired.nodes.map((n) => n.id);
    expect(ids).toContain(containerId('m', 0));
    expect(ids).toContain(containerId('m', 1));
    // rows(3) + buffer(1) = 4 cells per reel, 2 reels => 8 sprites + 2 containers = 10 nodes
    expect(desired.nodes.filter((n) => n.type === 'Sprite')).toHaveLength(8);
    expect(desired.nodes.filter((n) => n.type === 'Container')).toHaveLength(2);
    expect(ids).toContain(cellId('m', 1, 3)); // buffer row index = rows
  });

  it('parents reels under config.parentId and cells under their reel container', () => {
    const desired = buildDesired('m', cfg);
    const reel0 = desired.nodes.find((n) => n.id === containerId('m', 0))!;
    expect(reel0.parent).toBe('root');
    const cell = desired.nodes.find((n) => n.id === cellId('m', 0, 0))!;
    expect(cell.parent).toBe(containerId('m', 0));
  });
});

describe('ReelsModule.project', () => {
  it('creates the reel structure in the model', () => {
    const model = seededModel();
    const m = new ReelsModule({ id: 'm', host: modelHost(model), config: cfg });
    m.project();
    const doc = model.toDocument();
    expect(doc.nodes[containerId('m', 0)]).toBeTruthy();
    expect(doc.nodes[cellId('m', 0, 0)]).toBeTruthy();
  });

  it('is idempotent: projecting twice does not duplicate or throw', () => {
    const model = seededModel();
    const m = new ReelsModule({ id: 'm', host: modelHost(model), config: cfg });
    m.project();
    const countAfterFirst = Object.keys(model.toDocument().nodes).length;
    expect(() => m.project()).not.toThrow();
    expect(Object.keys(model.toDocument().nodes).length).toBe(countAfterFirst);
  });

  it('a config change (cols 2 -> 3) reconciles in the new reel without duplicating', () => {
    const model = seededModel();
    const m = new ReelsModule({ id: 'm', host: modelHost(model), config: cfg });
    m.project();
    m.setConfig({ cols: 3 });
    m.project();
    const doc = model.toDocument();
    expect(doc.nodes[containerId('m', 2)]).toBeTruthy();
    expect(doc.nodes[containerId('m', 0)]).toBeTruthy(); // original kept
  });

  it('invalid config falls back to defaults (validateConfig) rather than projecting garbage', () => {
    const model = seededModel();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = new ReelsModule({ id: 'm', host: modelHost(model), config: { ...cfg, rows: -5 } });
    m.project();
    // rows fell back to default 3 => 3+buffer = 4 cells in reel 0
    const doc = model.toDocument();
    expect(doc.nodes[cellId('m', 0, 3)]).toBeTruthy();
    spy.mockRestore();
  });
});
