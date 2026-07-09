import type { ITraceEntry, ITriggerData } from '../play/composedTypes';

/** The awaited trigger seam a mechanic module exposes to the walker.
 *  ReelsModule and MeterModule implement it structurally. */
export interface ITriggerTarget {
  invoke(trigger: string, data: ITriggerData): Promise<void>;
}

export interface ITraceWalkerDeps {
  bus: { emit(event: string, payload: unknown): void };
  /** Module lookup by mechanic INSTANCE id (e.g. 'main_reels'), not type. */
  resolve: (mechanicId: string) => ITriggerTarget | null;
}

/** Steps the client through a served composed@1 lifecycle trace (spec §4):
 *  trigger entries dispatch to modules and are awaited before advancing;
 *  every other entry becomes a bus event — v1's presentation hook. The
 *  composed twin of Orchestrator (which keeps owning slots@1). */
export class TraceWalker {
  constructor(private readonly deps: ITraceWalkerDeps) {}

  async walk(entries: ITraceEntry[]): Promise<void> {
    for (const e of entries) {
      switch (e.t) {
        case 'trigger': {
          const target = this.deps.resolve(e.mechanic);
          if (!target) throw new Error(`no module for mechanic: ${e.mechanic}`);
          await target.invoke(e.name, e.data);
          break;
        }
        case 'round_start':
          this.deps.bus.emit('round:start', { seed: e.seed });
          break;
        case 'state_enter':
          this.deps.bus.emit('state:enter', { state: e.state });
          break;
        case 'step':
          this.deps.bus.emit('step', { n: e.n });
          break;
        case 'transition':
          this.deps.bus.emit('transition', { on: e.on, to: e.to, effect: e.effect });
          break;
        case 'state_exit':
          this.deps.bus.emit('state:exit', { state: e.state, payout: e.payout });
          break;
        case 'round_end':
          this.deps.bus.emit('round:complete', { total_payout: e.total_payout });
          break;
        default: {
          // Exhaustiveness guard; at runtime an unknown wire entry lands here.
          const never: never = e;
          throw new Error(`unknown trace entry: ${JSON.stringify(never)}`);
        }
      }
    }
  }
}
