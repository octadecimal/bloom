import { describe, it, expect } from 'vitest';
import { MeterModule, buildMeterDesired, segId, barId } from './meterModule';
import { createBus } from '../../orchestration/bus';
import type { IModuleHost } from '../module';
import type { JsonValue } from '../../model/document';
import type { Op } from '../../model/ops';

function harness(config: Record<string, JsonValue> = { target: 6 }) {
  const bus = createBus();
  let tick: ((dt: number) => void) | null = null;
  const batches: Op[][] = [];
  const host: IModuleHost = {
    snapshot: () => ({ version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] }),
    emit: (ops) => void batches.push(ops),
    resolve: () => null,
    onTick: (cb) => {
      tick = cb;
      return () => (tick = null);
    },
    bus,
  };
  const mod = new MeterModule({ id: 'bonus_meter', host, config });
  mod.mount();
  const pump = (ms: number) => {
    for (let t = 0; t < ms; t += 50) tick?.(50);
  };
  return { mod, bus, batches, pump };
}

describe('buildMeterDesired', () => {
  it('emits a bar container plus target segments, lit up to fill', () => {
    const scene = buildMeterDesired('bonus_meter', { target: 4, parentId: 'root' }, 2, { width: 1280, height: 720 });
    expect(scene.nodes).toHaveLength(5); // 1 bar + 4 segments
    expect(scene.nodes[0]).toMatchObject({ id: barId('bonus_meter'), type: 'Container', parent: 'root' });
    const fills = scene.nodes.slice(1).map((n) => n.props.fill);
    expect(new Set(fills.slice(0, 2)).size).toBe(1); // first two lit (same color)
    expect(fills[0]).not.toBe(fills[2]); // lit differs from unlit
    expect(scene.nodes[4].id).toBe(segId('bonus_meter', 3));
  });
});

describe('MeterModule.invoke (composed trigger seam)', () => {
  it('animates to the served fill, emits meter:changed, then resolves', async () => {
    const h = harness();
    const changed: unknown[] = [];
    h.bus.on('meter:changed', (p) => changed.push(p));
    let done = false;
    const p = h.mod.invoke('accumulate', { kind: 'meter', fill: 3, target: 6 }).then(() => (done = true));
    expect(done).toBe(false); // pending until segments light
    h.pump(1000); // 3 segments × 150ms
    await p;
    expect(h.mod.debugState()).toEqual({ fill: 3, target: 6 });
    expect(changed).toEqual([{ fill: 3, target: 6 }]);
  });

  it('snaps down immediately when the served fill is lower (new round)', async () => {
    const h = harness();
    const p1 = h.mod.invoke('accumulate', { kind: 'meter', fill: 3, target: 6 });
    h.pump(1000);
    await p1;
    await h.mod.invoke('accumulate', { kind: 'meter', fill: 1, target: 6 }); // no pumping needed
    expect(h.mod.debugState().fill).toBe(1);
  });

  it('lights segments via setProp ops on its own node ids', async () => {
    const h = harness();
    const p = h.mod.invoke('accumulate', { kind: 'meter', fill: 1, target: 6 });
    h.pump(500);
    await p;
    expect(h.batches.flat().some((op) => op.kind === 'setProp' && op.id === segId('bonus_meter', 0) && op.path === 'fill')).toBe(true);
  });

  it('rejects an unknown trigger or wrong data kind', async () => {
    const h = harness();
    await expect(h.mod.invoke('spin', { kind: 'reels', grid: [[0]], payout: 0 })).rejects.toThrow(/unsupported/);
  });
});
