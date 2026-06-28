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

  constructor(private readonly deps: { bus: IEventBus; reels: () => IReelsControl | null }) {
    this.off = deps.bus.on<{ grid: string[][] }>('reels:settled', (payload) => {
      deps.bus.emit('round:complete', payload);
    });
  }

  spin(outcome: IOutcome): void {
    const reels = this.deps.reels();
    if (!reels) return;
    reels.project(); // idempotent — ensures structure exists
    reels.startSpinning();
    reels.stopSpinning(outcome);
  }

  dispose(): void {
    this.off();
  }
}
