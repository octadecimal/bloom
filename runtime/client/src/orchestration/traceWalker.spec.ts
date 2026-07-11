import { describe, it, expect } from 'vitest';
import { TraceWalker, type ITriggerTarget } from './traceWalker';
import { createBus } from './bus';
import type { ITraceEntry, ITriggerData } from '../play/composedTypes';

const REELS_DATA: ITriggerData = { kind: 'reels', grid: [[9], [9], [9]], payout: 8 };

const TRACE: ITraceEntry[] = [
  { t: 'round_start', seed: '8' },
  { t: 'state_enter', state: 'base' },
  { t: 'step', n: 1 },
  { t: 'trigger', mechanic: 'main_reels', name: 'spin', events: ['scatters:3'], data: REELS_DATA },
  { t: 'trigger', mechanic: 'bonus_meter', name: 'accumulate', events: [], data: { kind: 'meter', fill: 3, target: 6 } },
  { t: 'transition', on: 'scatters:3', to: 'fs1' },
  { t: 'state_exit', state: 'base', payout: 8 },
  { t: 'round_end', total_payout: 8 },
];

function harness(opts: { manual?: boolean } = {}) {
  const bus = createBus();
  const log: Array<{ event: string; payload: unknown }> = [];
  for (const ev of ['round:start', 'state:enter', 'step', 'transition', 'state:exit', 'round:complete']) {
    bus.on(ev, (payload) => log.push({ event: ev, payload }));
  }
  const invoked: Array<{ id: string; trigger: string; data: ITriggerData }> = [];
  const pendings: Array<() => void> = [];
  const target = (id: string): ITriggerTarget => ({
    invoke: (trigger, data) => {
      invoked.push({ id, trigger, data });
      if (!opts.manual) return Promise.resolve();
      return new Promise((resolve) => pendings.push(resolve));
    },
  });
  const targets = new Map([
    ['main_reels', target('main_reels')],
    ['bonus_meter', target('bonus_meter')],
  ]);
  const walker = new TraceWalker({ bus, resolve: (id) => targets.get(id) ?? null });
  return { walker, log, invoked, pendings };
}

describe('TraceWalker', () => {
  it('walks a trace: bus events in order, triggers dispatched by mechanic id', async () => {
    const h = harness();
    await h.walker.walk(TRACE);
    expect(h.log.map((l) => l.event)).toEqual(['round:start', 'state:enter', 'step', 'transition', 'state:exit', 'round:complete']);
    expect(h.log.at(-1)?.payload).toEqual({ total_payout: 8 });
    expect(h.invoked.map((i) => `${i.id}.${i.trigger}`)).toEqual(['main_reels.spin', 'bonus_meter.accumulate']);
  });

  it('awaits each trigger before advancing', async () => {
    const h = harness({ manual: true });
    void h.walker.walk(TRACE);
    // walk() runs synchronously up to the first await: 3 bus events, then the
    // first invoke parks. The second trigger must NOT have been dispatched.
    expect(h.invoked).toHaveLength(1);
    expect(h.log.map((l) => l.event)).toEqual(['round:start', 'state:enter', 'step']); // no transition yet
    h.pendings[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.invoked).toHaveLength(2);
    expect(h.log.map((l) => l.event)).toEqual(['round:start', 'state:enter', 'step']); // still parked on trigger 2
    h.pendings[1]!();
  });

  it('rejects on a trigger whose mechanic has no module', async () => {
    const bus = createBus();
    const walker = new TraceWalker({ bus, resolve: () => null });
    await expect(walker.walk(TRACE)).rejects.toThrow(/no module for mechanic: main_reels/);
  });
});
