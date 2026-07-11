import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { mathSlice, type IMathState, type IGenFrame, type IMathRun, type IPopulationStats } from './state';
import { progressFrame, runLoaded } from './reducers';
import type { ISlotModelWire } from './restClient';
import { fieldsFromGddData, refreshDoc, refreshTarget, refreshTuneResult } from './sync';

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

/** A single lazily-connected socket, `join_analytics`/`leave_analytics` room lifecycle,
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
      mathSlice().genProgress.set({ generation: p.generation, maxGenerations: p.maxGenerations });
      const next = progressFrame(mathSlice().get({ noproxy: true }) as IMathState, frame);
      mathSlice().set(next as never);
    });
    sock.on('run_complete', (p: { gameId: string; run: IMathRun }) => {
      if (!isActive(p.gameId)) return;
      const next = runLoaded(mathSlice().get({ noproxy: true }) as IMathState, p.run);
      mathSlice().set(next as never);
    });
    sock.on(
      'generate_status',
      (p: { gameId: string; phase: 'tuning' | 'verifying' | 'done' | 'failed' | 'cancelled'; attempt?: number; maxAttempts?: number }) => {
        if (!isActive(p.gameId)) return;
        const s = mathSlice();
        s.genStatus.set(p.phase);
        if (p.phase === 'tuning' || p.phase === 'verifying') {
          s.genAttempt.set(p.attempt != null && p.maxAttempts != null ? { attempt: p.attempt, maxAttempts: p.maxAttempts } : null);
        } else {
          s.genAttempt.set(null);
        }
        if (p.phase === 'tuning') {
          // A fresh attempt: clear the previous artifacts so Evolution streams live.
          // (This also resets frames per RESTART — each attempt is its own evolution.)
          s.genFailure.set(null);
          s.genProgress.set(null);
          s.applied.set(false);
          s.frames.set([]);
          s.selectedGeneration.set('live');
        }
        if (p.phase === 'cancelled') s.genProgress.set(null);
        if (p.phase === 'done') {
          void refreshTuneResult(p.gameId);
          // save_tune_result clears verdict_stale in Mongo without emitting
          // slot_model_changed (it's called repeatedly inside the tune loop),
          // so re-pull the doc here or the STALE chip outlives a fresh PASS.
          void refreshDoc(p.gameId);
        }
      },
    );
    sock.on('tuning_failed', (p: { gameId: string; failure?: string }) => {
      if (!isActive(p.gameId)) return;
      mathSlice().genFailure.set(p.failure ?? 'tune failed');
    });
    sock.on('curation_progress', (p: { gameId: string; phase: string; done: number | null; total: number | null }) => {
      if (!isActive(p.gameId)) return;
      const s = mathSlice();
      s.verifyStatus.set('running');
      s.verifyProgress.set({ phase: p.phase, done: p.done, total: p.total });
      s.verifyFailure.set(null);
    });
    sock.on('curation_complete', (p: { gameId: string; doc: ISlotModelWire }) => {
      if (!isActive(p.gameId)) return;
      const s = mathSlice();
      s.verifyResult.set(p.doc.result);
      s.verifyStatus.set(p.doc.result ? p.doc.result.status : 'idle');
      s.verifyProgress.set(null);
      s.locks.set(p.doc.locks);
      s.curationParams.set(p.doc.params);
      s.verdictStale.set(!!p.doc.verdictStale);
    });
    sock.on('curation_failed', (p: { gameId: string; failure?: string }) => {
      if (!isActive(p.gameId)) return;
      const s = mathSlice();
      s.verifyStatus.set('error');
      s.verifyProgress.set(null);
      s.verifyFailure.set(p.failure ?? null);
    });
    sock.on('slot_model_changed', (p: { gameId: string; updatedAt: string; source: string }) => {
      if (!isActive(p.gameId)) return;
      void refreshDoc(p.gameId); // locks toggled in Game Config, template/agent writes, Apply echo
    });
    sock.on('gdd_doc_updated', (p: { gameId: string; doc: { aspect: string; data: Record<string, unknown>; updatedAt: string } }) => {
      if (!isActive(p.gameId) || p.doc.aspect !== 'math-model') return;
      const s = mathSlice();
      if (p.doc.updatedAt <= s.gddWatermark.get()) return; // our own echo / stale
      s.gddWatermark.set(p.doc.updatedAt);
      s.targetFields.set(fieldsFromGddData(p.doc.data));
      void refreshTarget(p.gameId);
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
