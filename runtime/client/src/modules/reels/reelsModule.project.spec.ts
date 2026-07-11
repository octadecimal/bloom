// runtime/client/src/modules/reels/reelsModule.project.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { GraphModel } from '../../model/graphModel';
import type { IModuleHost } from '../module';
import { ReelsModule, buildDesired, centeredOrigin, containerId, cellId } from './reelsModule';
import { colorForSymbol } from './symbolColor';

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
  it('each cell carries fill, size and label for rectangle rendering', () => {
    const scene = buildDesired('reels', { cols: 1, rows: 1, symbols: ['7'], cellSize: 100, spacing: 0, buffer: 0, parentId: 'root' });
    const cell = scene.nodes.find((n) => n.id === 'reels:cell:0:0')!;
    expect(cell.props.fill).toBe(colorForSymbol('7'));
    expect(cell.props.size).toEqual({ width: 100, height: 100 });
    expect(cell.props.label).toBe('7');
  });

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

  it('rests the last buffer cell above the grid, matching the scroll window (no settle frame shift)', () => {
    const desired = buildDesired('m', cfg); // rows 3, buffer 1, span 100
    const y = (r: number) => (desired.nodes.find((n) => n.id === cellId('m', 0, r))!.props.position as { y: number }).y;
    expect(y(0)).toBe(0);
    expect(y(2)).toBe(200);
    expect(y(3)).toBe(-100); // spare cell parks above the top row
  });

  it('defaults to buffer 2: one hidden row above and one below the visible grid', () => {
    const desired = buildDesired('m', { rows: 3, cols: 1, symbols: ['A'], cellSize: 100, spacing: 0, originX: 0, originY: 0, parentId: 'root' });
    const cells = desired.nodes.filter((n) => n.type === 'Sprite');
    expect(cells).toHaveLength(5); // rows 3 + buffer 2
    const ys = cells.map((c) => (c.props.position as { y: number }).y).sort((a, b) => a - b);
    expect(ys).toEqual([-100, 0, 100, 200, 300]);
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

function modelWithSafeArea(): GraphModel {
  const m = new GraphModel();
  m.apply({
    kind: 'addNode',
    id: 'root',
    type: 'Root',
    props: { safeArea: { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } } },
  });
  return m;
}

describe('centeredOrigin', () => {
  it('centers the visible grid block in the safe area', () => {
    // 5 cols x 3 rows, cellSize 100, spacing 8 -> span = 108
    expect(centeredOrigin({ cols: 5, rows: 3, cellSize: 100, spacing: 8 }, { width: 1280, height: 720 })).toEqual({
      originX: 1280 / 2 - (4 * 108) / 2, // 424
      originY: 720 / 2 - (2 * 108) / 2, // 252
    });
  });
});

describe('ReelsModule.project centering', () => {
  it('defaults to a centered origin from the Root safe area when origin is unset', () => {
    const model = modelWithSafeArea();
    const m = new ReelsModule({
      id: 'r',
      host: modelHost(model),
      config: { rows: 3, cols: 5, cellSize: 100, spacing: 8, symbols: ['A', 'B', 'C'], parentId: 'root' },
    });
    m.project();
    const doc = model.toDocument();
    const reel0 = doc.nodes[containerId('r', 0)].props.position as { x: number; y: number };
    expect(reel0).toEqual({ x: 424, y: 252 }); // centered, not pinned to the corner
    expect((doc.nodes[containerId('r', 4)].props.position as { x: number }).x).toBe(424 + 4 * 108);
  });

  it('honors an explicit origin (no centering)', () => {
    const model = modelWithSafeArea();
    const m = new ReelsModule({ id: 'r', host: modelHost(model), config: { ...cfg, parentId: 'root' } });
    m.project();
    expect((model.toDocument().nodes[containerId('r', 0)].props.position as { x: number }).x).toBe(0); // cfg sets originX: 0
  });
});
