import type { IEventBus } from './bus';
import type { IOutcome } from '../modules/module';

/** The slice of a module the orchestrator drives (modules talk via the bus otherwise). */
export interface IReelsControl {
  project(): void;
  startSpinning(): void;
  stopSpinning(outcome: IOutcome): void;
}

/** Owns round sequencing in one inspectable place (spec §5). The reels control
 *  is resolved lazily because modules are instantiated on `init`, after the
 *  engine (and orchestrator) are built. */
export class Orchestrator {
  private off: () => void;
  /** Set only by our own spin(); guards against reels:settled fired by other
   *  callers of ReelsModule.invoke('spin') (e.g. composed@1's TraceWalker),
   *  which must not masquerade as a slots@1 round:complete (spec §4/§9.1). */
  private inFlight = false;

  constructor(private readonly deps: { bus: IEventBus; reels: () => IReelsControl | null }) {
    this.off = deps.bus.on<{ grid: string[][] }>('reels:settled', (payload) => {
      if (!this.inFlight) return;
      this.inFlight = false;
      deps.bus.emit('round:complete', payload);
    });
  }

  spin(outcome: IOutcome): void {
    const reels = this.deps.reels();
    if (!reels) return;
    this.inFlight = true;
    reels.project(); // idempotent — ensures structure exists
    reels.startSpinning();
    reels.stopSpinning(outcome);
  }

  dispose(): void {
    this.off();
  }
}
