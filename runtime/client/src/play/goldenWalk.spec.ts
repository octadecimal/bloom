// @vitest-environment node
// Kernel golden-vector parity (spec §7): the client must parse and walk every
// checked-in (definition, seed) -> trace fixture to completion, and module
// end-states must match the trace's claims. Fixtures live in trusted/math and
// are shared with the kernel + server suites — never edited here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TraceWalker, type ITriggerTarget } from '../orchestration/traceWalker';
import { validateDefinition, type ITraceEntry, type ITriggerData } from './composedTypes';
import { createBus } from '../orchestration/bus';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(testDir, '../../../../trusted/math/fixtures/composed', name);

const TRACES = ['trace_seed_0.json', 'trace_seed_292.json', 'trace_seed_3395.json', 'trace_seed_8.json'];

class RecordingTarget implements ITriggerTarget {
  calls: Array<{ trigger: string; data: ITriggerData }> = [];
  invoke(trigger: string, data: ITriggerData): Promise<void> {
    this.calls.push({ trigger, data });
    return Promise.resolve();
  }
}

describe('golden-vector walk (kernel parity)', () => {
  it('the proof-game definition passes the client boundary validator', () => {
    const def = validateDefinition(JSON.parse(readFileSync(fixture('proof_game.def.json'), 'utf8')));
    expect(def.mechanics.map((m) => m.type)).toEqual(['reels@1', 'meter@1']);
    expect(def.mechanics.map((m) => m.id)).toEqual(['main_reels', 'bonus_meter']);
  });

  for (const name of TRACES) {
    it(`walks ${name} to completion; dispatches and end-states match the trace`, async () => {
      const fx = JSON.parse(readFileSync(fixture(name), 'utf8')) as {
        entries: ITraceEntry[];
        total_payout: number;
      };
      const targets = new Map<string, RecordingTarget>([
        ['main_reels', new RecordingTarget()],
        ['bonus_meter', new RecordingTarget()],
      ]);
      const bus = createBus();
      const completes: unknown[] = [];
      bus.on('round:complete', (p) => completes.push(p));

      const walker = new TraceWalker({ bus, resolve: (id) => targets.get(id) ?? null });
      await walker.walk(fx.entries); // resolves without throwing = every entry is walkable

      // Every trigger reached the right module, in served order, with served data.
      const triggers = fx.entries.filter((e): e is Extract<ITraceEntry, { t: 'trigger' }> => e.t === 'trigger');
      expect(triggers.length).toBeGreaterThan(0);
      for (const [id, target] of targets) {
        const expected = triggers.filter((e) => e.mechanic === id);
        expect(target.calls).toEqual(expected.map((e) => ({ trigger: e.name, data: e.data })));
      }

      // Round completion carries the audited total.
      expect(completes).toEqual([{ total_payout: fx.total_payout }]);
      const end = fx.entries.at(-1);
      expect(end).toEqual({ t: 'round_end', total_payout: fx.total_payout });
    });
  }
});
