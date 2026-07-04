import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { mathSlice, type IMathState, type IGenFrame, type IMathRun, type IPopulationStats } from './state';
import { progressFrame, runLoaded } from './reducers';

let sock: Socket | null = null;
function isActive(gameId: string): boolean {
  return mathSlice().activeGameId.get() === gameId;
}

interface IAnalyticsProgressWire {
  gameId: string;
  generation: number;
  maxGenerations: number;
  best: { fitness: number; rtp: number; volatility: number };
  population: IPopulationStats;
  geneAgreement: number[];
}

/** Mirrors `plugins/tuner/socketClient.ts` (`createTunerSocket`): a single
 * lazily-connected socket, `join_analytics`/`leave_analytics` room lifecycle,
 * and every handler guarded by `isActive(gameId)` so events for a game the
 * user has since navigated away from are dropped. `analytics_progress` is
 * ephemeral (streamed, never persisted); `run_complete` carries the frozen,
 * persisted `IMathRun` and is the post-hoc source of truth. */
export function createMathSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'math' } });
    sock.on('analytics_progress', (p: IAnalyticsProgressWire) => {
      if (!isActive(p.gameId)) return;
      const frame: IGenFrame = {
        generation: p.generation,
        best: p.best,
        population: p.population,
        geneAgreement: p.geneAgreement,
      };
      // `{ noproxy: true }` is required here: this read feeds a pure reducer whose
      // result is `.set()` straight back into the same slice. A bare `.get()` returns
      // a tracking Proxy meant for React's render-time dependency tracking; spreading
      // it (`progressFrame`'s `{ ...state, frames }`) and writing it back creates a
      // self-referencing proxy chain in the store that recurses forever on the next
      // `.get()` (`RangeError: Maximum call stack size exceeded` under real rapid-fire
      // generation frames). Mirrors the noproxy convention every other
      // read-reduce-write call site in the app already follows (gdd/actions.ts,
      // llm-chat/socketClient.ts, assets/socketClient.ts, ...).
      const next = progressFrame(mathSlice().get({ noproxy: true }) as IMathState, frame);
      mathSlice().set(next as never);
    });
    sock.on('run_complete', (p: { gameId: string; run: IMathRun }) => {
      if (!isActive(p.gameId)) return;
      const next = runLoaded(mathSlice().get({ noproxy: true }) as IMathState, p.run);
      mathSlice().set(next as never);
    });
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    joinMath: (gameId: string) => sock?.emit('join_analytics', { gameId }),
    leaveMath: (gameId: string) => sock?.emit('leave_analytics', { gameId }),
  };
}

let client: ReturnType<typeof createMathSocket> | null = null;
export function mathSock() {
  if (!client) client = createMathSocket();
  return client;
}
