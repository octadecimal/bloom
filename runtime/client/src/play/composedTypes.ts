import { PlayModeError } from './presentationConfig';

/** Mirrors of the Rust composed@1 wire shapes
 *  (trusted/math/src/mechanics/composed/{definition,trace}.rs). Hand-written;
 *  the kernel golden vectors in goldenWalk.spec.ts are the drift alarm.
 *  Numeric policy (SP2 §5): seed is a string (u64 can exceed 2^53); payouts
 *  are bet-multiple u64s far below 2^53 and stay JSON numbers. */

export type ITriggerData = { kind: 'reels'; grid: number[][]; payout: number } | { kind: 'meter'; fill: number; target: number };

export type ITraceEntry =
  | { t: 'round_start'; seed: string }
  | { t: 'state_enter'; state: string }
  | { t: 'step'; n: number }
  | { t: 'trigger'; mechanic: string; name: string; events: string[]; data: ITriggerData }
  | { t: 'transition'; on: string; to?: string; effect?: string }
  | { t: 'state_exit'; state: string; payout: number }
  | { t: 'round_end'; total_payout: number };

export interface IMechanicDecl {
  id: string;
  type: string;
  config: unknown;
}

export interface IBinding {
  mechanic: string;
  override?: unknown;
}

export interface IStepsSpec {
  budget: number | string;
  initial?: number;
}

export interface IStateDef {
  id: string;
  bindings: IBinding[];
  steps: IStepsSpec;
  script: Array<{ invoke: string }>;
}

export interface ITransitionRow {
  from: string;
  on: string;
  to?: string;
  effect?: string;
}

export interface IGameDefinition {
  family: string;
  mechanics: IMechanicDecl[];
  states: IStateDef[];
  start: string;
  transitions: ITransitionRow[];
  caps: { max_steps: number };
}

/** Narrow an opaque handshake `definition` to a playable composed@1 Game
 *  Definition, or throw a PlayModeError the caller renders visibly. Checks
 *  only what the client consumes (family + mechanics list); the server
 *  already compiled the definition. */
export function validateDefinition(raw: unknown): IGameDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new PlayModeError('handshake definition is empty');
  }
  const d = raw as Record<string, unknown>;
  if (d.family !== 'composed@1') {
    throw new PlayModeError(`unsupported definition family: ${String(d.family)}`);
  }
  if (!Array.isArray(d.mechanics) || d.mechanics.length === 0) {
    throw new PlayModeError('definition has no mechanics');
  }
  for (const m of d.mechanics as Array<Record<string, unknown> | null>) {
    if (!m || typeof m.id !== 'string' || typeof m.type !== 'string' || m.config === undefined) {
      throw new PlayModeError('definition mechanic missing id/type/config');
    }
  }
  return raw as IGameDefinition;
}
