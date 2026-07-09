import type { ITraceEntry } from './composedTypes';

/** The reels presentation manifest the package carries (server /handshake). */
export interface IPresentation {
  cols: number;
  rows: number;
  symbols: string[];
  parentId?: string;
}

/** GET /handshake response. `presentation`/`definition` are opaque JSON until
 *  validated; `definition` is present for composed@1 packages, absent for slots. */
export interface IHandshakeResponse {
  package_id: string;
  package_version: number;
  mechanic: string;
  presentation: unknown;
  definition?: unknown;
}

/** The `slots@1` arm of the server's mechanic-tagged outcome union. */
export interface ISlotsOutcomeWire {
  mechanic: 'slots@1';
  base_grid: number[][];
  base_payout: number;
  feature_payout: number;
  total_payout: number;
  features: unknown[];
}

/** The `composed@1` summary arm — per-state payouts live in the trace. */
export interface IComposedOutcomeWire {
  mechanic: 'composed@1';
  total_payout: number;
}

/** POST /spin response. `seed` is a string (a u64 that can exceed 2^53);
 *  `trace` is present for composed@1, absent for slots. */
export interface ISpinResponse {
  seed: string;
  bet: number;
  outcome: ISlotsOutcomeWire | IComposedOutcomeWire;
  trace?: ITraceEntry[];
}

/** The thin transport the play subsystem depends on (impl in runtimeClient.ts). */
export interface IRuntimeClient {
  handshake(): Promise<IHandshakeResponse>;
  spin(bet?: number): Promise<ISpinResponse>;
}
