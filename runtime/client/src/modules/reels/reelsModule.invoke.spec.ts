import { describe, it, expect } from 'vitest';
import { ReelsModule } from './reelsModule';
import { createBus } from '../../orchestration/bus';
import type { IModuleHost } from '../module';

function harness() {
  const bus = createBus();
  let tick: ((dt: number) => void) | null = null;
  const host: IModuleHost = {
    snapshot: () => ({ version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] }),
    emit: () => {},
    resolve: () => null,
    onTick: (cb) => {
      tick = cb;
      return () => (tick = null);
    },
    bus,
  };
  const mod = new ReelsModule({ id: 'main_reels', host, config: { cols: 3, rows: 1, symbols: ['0', '1', '9'] } });
  mod.mount();
  const pump = (ms: number) => {
    for (let t = 0; t < ms; t += 50) tick?.(50);
  };
  return { mod, bus, pump };
}

describe('ReelsModule.invoke (composed trigger seam)', () => {
  it('runs a served spin and resolves when the reels settle on the served grid', async () => {
    const h = harness();
    let done = false;
    const p = h.mod.invoke('spin', { kind: 'reels', grid: [[9], [9], [9]], payout: 8 }).then(() => (done = true));
    expect(done).toBe(false); // pending until the settle animation lands
    h.pump(3000); // > SETTLE_MS + stagger for 3 reels
    await p;
    expect(done).toBe(true);
    expect(h.mod.debugState()).toEqual({ phase: 'idle', grid: [['9'], ['9'], ['9']] });
  });

  it('rejects an unknown trigger or wrong data kind', async () => {
    const h = harness();
    await expect(h.mod.invoke('accumulate', { kind: 'meter', fill: 1, target: 6 })).rejects.toThrow(/unsupported/);
    await expect(h.mod.invoke('spin', { kind: 'meter', fill: 1, target: 6 })).rejects.toThrow(/unsupported/);
  });
});
