import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { analyticsSlice, type IAnalyticsState, type IGenFrame, type IMathRun, type IPopulationStats } from './state';
import { progressFrame, runLoaded } from './reducers';

let sock: Socket | null = null;
function isActive(gameId: string): boolean {
  return analyticsSlice().activeGameId.get() === gameId;
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
export function createAnalyticsSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'math-analytics' } });
    sock.on('analytics_progress', (p: IAnalyticsProgressWire) => {
      if (!isActive(p.gameId)) return;
      const frame: IGenFrame = {
        generation: p.generation,
        best: p.best,
        population: p.population,
        geneAgreement: p.geneAgreement,
      };
      const next = progressFrame(analyticsSlice().get() as IAnalyticsState, frame);
      analyticsSlice().set(next as never);
    });
    sock.on('run_complete', (p: { gameId: string; run: IMathRun }) => {
      if (!isActive(p.gameId)) return;
      const next = runLoaded(analyticsSlice().get() as IAnalyticsState, p.run);
      analyticsSlice().set(next as never);
    });
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    joinAnalytics: (gameId: string) => sock?.emit('join_analytics', { gameId }),
    leaveAnalytics: (gameId: string) => sock?.emit('leave_analytics', { gameId }),
  };
}

let client: ReturnType<typeof createAnalyticsSocket> | null = null;
export function analyticsSock() {
  if (!client) client = createAnalyticsSocket();
  return client;
}
