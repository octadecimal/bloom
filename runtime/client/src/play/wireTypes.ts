/** The reels presentation manifest the package carries (server /handshake). */
export interface IPresentation {
  cols: number;
  rows: number;
  symbols: string[];
  parentId?: string;
}

/** GET /handshake response. `presentation` is opaque JSON until validated. */
export interface IHandshakeResponse {
  package_id: string;
  package_version: number;
  mechanic: string;
  presentation: unknown;
}

/** The `slots@1` arm of the server's mechanic-tagged outcome union. */
export interface ISlotsOutcomeWire {
  mechanic: string;
  base_grid: number[][];
  base_payout: number;
  feature_payout: number;
  total_payout: number;
  features: unknown[];
}

/** POST /spin response. `seed` is a string (a u64 that can exceed 2^53). */
export interface ISpinResponse {
  seed: string;
  bet: number;
  outcome: ISlotsOutcomeWire;
}

/** The thin transport the play subsystem depends on (impl in runtimeClient.ts). */
export interface IRuntimeClient {
  handshake(): Promise<IHandshakeResponse>;
  spin(bet?: number): Promise<ISpinResponse>;
}
