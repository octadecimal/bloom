// runtime/client/src/modules/reels/reelsModule.behavior.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../../orchestration/bus';
import type { IDisplayHandle } from '../../render/renderer';
import type { IModuleHost } from '../module';
import type { Op } from '../../model/ops';
import { ReelsModule, cellId } from './reelsModule';
import { colorForSymbol } from './symbolColor';

function fakeHandle(): IDisplayHandle {
  return { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, alpha: 1, visible: true, setBlur: vi.fn() };
}

function fakeHost(): { host: IModuleHost; handles: Map<string, IDisplayHandle> } {
  const handles = new Map<string, IDisplayHandle>();
  const bus = createBus();
  const host: IModuleHost = {
    snapshot: () => ({ version: 1, nodes: {}, edges: [] }),
    emit: () => {},
    resolve: (id) => {
      if (!handles.has(id)) handles.set(id, fakeHandle());
      return handles.get(id)!;
    },
    onTick: () => () => {},
    bus,
  };
  return { host, handles };
}

function recordingFakeHost(): { host: IModuleHost; handles: Map<string, IDisplayHandle>; emitted: Op[][] } {
  const handles = new Map<string, IDisplayHandle>();
  const bus = createBus();
  const emitted: Op[][] = [];
  const host: IModuleHost = {
    snapshot: () => ({ version: 1, nodes: {}, edges: [] }),
    emit: (ops) => {
      emitted.push(ops);
    },
    resolve: (id) => {
      if (!handles.has(id)) handles.set(id, fakeHandle());
      return handles.get(id)!;
    },
    onTick: () => () => {},
    bus,
  };
  return { host, handles, emitted };
}

const cfg = { rows: 1, cols: 2, symbols: ['A', 'B', 'C'], cellSize: 100, spacing: 0, originX: 0, originY: 0, parentId: 'root', buffer: 1 };

describe('ReelsModule behavior', () => {
  it('starts idle', () => {
    const { host } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    expect(m.debugState().phase).toBe('idle');
  });

  it('startSpinning moves to spinning and applies blur during update', () => {
    const { host, handles } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    m.startSpinning();
    expect(m.debugState().phase).toBe('spinning');
    m.update(16);
    const handle = handles.get(cellId('m', 0, 0))!;
    expect(handle.setBlur).toHaveBeenCalled();
    const lastBlur = (handle.setBlur as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as number;
    expect(lastBlur).toBeGreaterThan(0);
  });

  it('stopSpinning eventually settles to the outcome grid and emits reels:settled once', () => {
    const { host } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    const settled = vi.fn();
    host.bus.on('reels:settled', settled);

    const outcome = { grid: [['B'], ['C']] }; // col0 row0 = B, col1 row0 = C
    m.startSpinning();
    m.stopSpinning(outcome);
    // Drive enough frames to exceed stagger + settle duration for all reels.
    for (let i = 0; i < 240; i++) m.update(16);

    expect(m.debugState().phase).toBe('idle');
    expect(m.debugState().grid).toEqual([['B'], ['C']]);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith({ grid: [['B'], ['C']] });
  });

  it('clears blur (setBlur 0) on every cell once settled', () => {
    const { host, handles } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    m.startSpinning();
    m.stopSpinning({ grid: [['A'], ['A']] });
    for (let i = 0; i < 240; i++) m.update(16);
    const handle = handles.get(cellId('m', 0, 0))!;
    const lastBlur = (handle.setBlur as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as number;
    expect(lastBlur).toBe(0);
  });

  it('does not emit reels:settled while still settling', () => {
    const { host } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    const settled = vi.fn();
    host.bus.on('reels:settled', settled);
    m.startSpinning();
    m.stopSpinning({ grid: [['A'], ['A']] });
    m.update(16); // one frame only
    expect(settled).not.toHaveBeenCalled();
  });

  it('dispose unsubscribes the tick (mount-registered) and is safe to call when not mounted', () => {
    const { host } = fakeHost();
    const off = vi.fn();
    const tickHost: IModuleHost = { ...host, onTick: () => off };
    const m = new ReelsModule({ id: 'm', host: tickHost, config: cfg });
    m.mount();
    m.dispose();
    expect(off).toHaveBeenCalled();
  });

  it('keeps a staggered column scrolling at full speed during its delay', () => {
    const { host, handles } = fakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    m.startSpinning();
    for (let i = 0; i < 3; i++) m.update(7); // land on a non-aligned offset
    m.stopSpinning({ grid: [['B'], ['C']] });
    const handle = handles.get(cellId('m', 1, 0))!; // col 1 delay = 150ms
    m.update(16);
    const y1 = handle.position.y;
    m.update(16);
    const y2 = handle.position.y;
    expect(y2 - y1).toBeCloseTo(1.2 * 16, 9); // still moving at SPIN_SPEED, not frozen
  });

  it('stopSpinning immediately stamps landing symbols on every cell (fill+label ops)', () => {
    const { host, emitted } = recordingFakeHost();
    const m = new ReelsModule({ id: 'm', host, config: cfg });
    m.startSpinning();
    m.stopSpinning({ grid: [['B'], ['C']] });
    const ops = emitted.flat();
    for (let c = 0; c < 2; c++) {
      for (let r = 0; r < 2; r++) {
        const labels = ops.filter((o) => o.kind === 'setProp' && o.id === cellId('m', c, r) && (o as { path: string }).path === 'label');
        expect(labels).toHaveLength(1);
        const sym = (labels[0] as { value: string }).value;
        expect(sym).toBe(c === 0 ? 'B' : 'C'); // single-symbol stop strip
        expect(ops).toContainEqual({ kind: 'setProp', id: cellId('m', c, r), path: 'fill', value: colorForSymbol(sym) });
      }
    }
  });

  it('columns land exactly on cell boundaries, showing the outcome, before the finishSettle safety write', () => {
    // rows=2 so the visible window has real structure; span=100, total=3 cells per column.
    const config = { rows: 2, cols: 1, symbols: ['A', 'B', 'C'], cellSize: 100, spacing: 0, originX: 0, originY: 0, parentId: 'root', buffer: 1 };
    const yWrites = new Map<string, number[]>();
    const handles = new Map<string, IDisplayHandle>();
    const emitted: Op[][] = [];
    const host: IModuleHost = {
      snapshot: () => ({ version: 1, nodes: {}, edges: [] }),
      emit: (ops) => {
        emitted.push(ops);
      },
      resolve: (id) => {
        if (!handles.has(id)) {
          const writes: number[] = [];
          yWrites.set(id, writes);
          let y = 0;
          const handle: IDisplayHandle = {
            position: {
              x: 0,
              get y() {
                return y;
              },
              set y(v: number) {
                y = v;
                writes.push(v);
              },
            },
            scale: { x: 1, y: 1 },
            alpha: 1,
            visible: true,
            setBlur: vi.fn(),
          };
          handles.set(id, handle);
        }
        return handles.get(id)!;
      },
      onTick: () => () => {},
      bus: createBus(),
    };

    const m = new ReelsModule({ id: 'm', host, config });
    m.startSpinning();
    for (let i = 0; i < 3; i++) m.update(7); // offset 25.2 — deliberately off-grid
    m.stopSpinning({ grid: [['X', 'Y']] });
    for (let i = 0; i < 240 && m.debugState().phase !== 'idle'; i++) m.update(16);
    expect(m.debugState().phase).toBe('idle');

    const span = 100;
    // Labels stamped at stop time (the first emit batch).
    const stampedLabel = new Map<string, string>();
    for (const op of emitted[0]) {
      if (op.kind === 'setProp' && op.path === 'label') stampedLabel.set(op.id, op.value as string);
    }
    const rowBefore = new Map<number, string>();
    for (let r = 0; r < 3; r++) {
      const writes = yWrites.get(cellId('m', 0, r))!;
      const landed = writes.at(-2)!; // last render write; at(-1) is finishSettle's safety write
      expect(((landed % span) + span) % span).toBe(0); // exact cell boundary — no sub-cell snap
      rowBefore.set(landed / span, stampedLabel.get(cellId('m', 0, r))!);
    }
    // The visible rows already show the outcome before finishSettle rewrites anything.
    expect(rowBefore.get(0)).toBe('X');
    expect(rowBefore.get(1)).toBe('Y');
  });

  it('lands the outcome symbols colors+labels via setProp on settle', () => {
    const { host, emitted } = recordingFakeHost();
    const m = new ReelsModule({
      id: 'm',
      host,
      config: { rows: 1, cols: 1, symbols: ['A'], cellSize: 100, spacing: 0, originX: 0, originY: 0, parentId: 'root', buffer: 1 },
    });
    m.startSpinning();
    m.stopSpinning({ grid: [['9']] });
    for (let i = 0; i < 240; i++) m.update(16);
    const allOps = emitted.flat();
    const fillOps = allOps.filter((o) => o.kind === 'setProp' && (o as { path: string }).path === 'fill');
    const labelOps = allOps.filter((o) => o.kind === 'setProp' && (o as { path: string }).path === 'label');
    expect(fillOps).toContainEqual({ kind: 'setProp', id: 'm:cell:0:0', path: 'fill', value: colorForSymbol('9') });
    expect(labelOps).toContainEqual({ kind: 'setProp', id: 'm:cell:0:0', path: 'label', value: '9' });
  });
});
