import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { tunerSlice, type ITunerJobDoc, type ITunerProgress } from './state';
import { statusFromResult } from './reducers';

let sock: Socket | null = null;
function isActive(gameId: string): boolean {
  return tunerSlice().activeGameId.get() === gameId;
}

export function createTunerSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'tuner' } });
    sock.on('tuning_progress', (p: ITunerProgress & { gameId: string }) => {
      if (!isActive(p.gameId)) return;
      tunerSlice().progress.set({
        generation: p.generation,
        maxGenerations: p.maxGenerations,
        bestFitness: p.bestFitness,
        bestRtp: p.bestRtp,
        bestVolatility: p.bestVolatility,
      });
      tunerSlice().status.set('running');
      tunerSlice().failure.set(null);
    });
    const onDoc = (p: { gameId: string; doc: ITunerJobDoc }) => {
      if (!isActive(p.gameId)) return;
      const result = p.doc.result;
      tunerSlice().result.set(result);
      tunerSlice().progress.set(null);
      tunerSlice().failure.set(null);
      tunerSlice().status.set(result ? statusFromResult(result) : 'idle');
    };
    sock.on('tuning_complete', onDoc);
    sock.on('tuning_failed', (p: { gameId: string; failure?: string }) => {
      if (!isActive(p.gameId)) return;
      tunerSlice().status.set('error');
      tunerSlice().progress.set(null);
      tunerSlice().result.set(null);
      tunerSlice().failure.set(p.failure ?? null);
    });
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    joinTuner: (gameId: string) => sock?.emit('join_tuner', { gameId }),
    leaveTuner: (gameId: string) => sock?.emit('leave_tuner', { gameId }),
  };
}

let client: ReturnType<typeof createTunerSocket> | null = null;
export function tunerSock() {
  if (!client) client = createTunerSocket();
  return client;
}
