import type { IEventBus } from './bus';
import type { IOutcome } from '../modules/module';

/** The slice of a module the orchestrator drives (modules talk via the bus otherwise). */
export interface IReelsControl {
  project(): void;
  startSpinning(): void;
  stopSpinning(outcome: IOutcome): void;
}

/** Owns round sequencing in one inspectable place (spec §5). Modules never reference
 *  each other — the orchestrator subscribes to module events and drives what's next. */
export class Orchestrator {
  private off: () => void;

  constructor(private readonly deps: { bus: IEventBus; reels: IReelsControl }) {
    this.off = deps.bus.on<{ grid: string[][] }>('reels:settled', (payload) => {
      deps.bus.emit('round:complete', payload);
    });
  }

  spin(outcome: IOutcome): void {
    this.deps.reels.project(); // idempotent — ensures structure exists
    this.deps.reels.startSpinning();
    this.deps.reels.stopSpinning(outcome);
  }

  dispose(): void {
    this.off();
  }
}
