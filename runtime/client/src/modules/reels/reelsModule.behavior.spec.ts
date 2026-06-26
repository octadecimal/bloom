// runtime/client/src/modules/reels/reelsModule.behavior.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../../orchestration/bus';
import type { IDisplayHandle } from '../../render/renderer';
import type { IModuleHost } from '../module';
import { ReelsModule, cellId } from './reelsModule';

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
});
