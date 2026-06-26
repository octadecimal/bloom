import type { JsonValue, IGameDocument } from '../model/document';
import type { Op } from '../model/ops';
import type { IEventBus } from '../orchestration/bus';
import type { IDisplayHandle } from '../render/renderer';
import type { IConfigSchema } from './schema';

/** Landed symbol grid: grid[col][row] = symbol id. */
export interface IOutcome {
  grid: string[][];
}

/** The single bridge between a module and the engine (spec §2.3, §6.1).
 *  Narrow on purpose: modules depend on this, never on Pixi or the reconciler. */
export interface IModuleHost {
  /** Current document — read-only source of truth for idempotent reprojection. */
  snapshot(): IGameDocument;
  /** Structure plane: apply ops atomically to the model + reconcile to the renderer. */
  emit(ops: Op[]): void;
  /** Behavior plane: live display handle for a projected node id (or null). */
  resolve(id: string): IDisplayHandle | null;
  /** Per-frame tick; returns an unsubscribe thunk. dtMs is elapsed ms since last frame. */
  onTick(cb: (dtMs: number) => void): () => void;
  readonly bus: IEventBus;
}

export interface IGameModule {
  readonly id: string;
  readonly type: string;
  readonly configSchema: IConfigSchema;
  /** Structure plane: emit ops to create/reconcile this module's nodes from its config. Idempotent. */
  project(): void;
  /** Lifecycle: subscribe to the tick / set up runtime state. */
  mount(): void;
  /** Behavior plane: advance transient motion by dtMs. */
  update(dtMs: number): void;
  /** Lifecycle: tear down subscriptions/state. */
  dispose(): void;
}

export type IModuleFactory = (args: { id: string; host: IModuleHost; config?: Record<string, JsonValue> }) => IGameModule;
