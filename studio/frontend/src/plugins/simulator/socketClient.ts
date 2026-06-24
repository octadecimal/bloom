import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { simulatorSlice, type ISlotModelDoc } from './state';
import { statusFromResult } from './reducers';

let sock: Socket | null = null;
function isActive(gameId: string): boolean {
  return simulatorSlice().activeGameId.get() === gameId;
}

export function createSimSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'simulator' } });
    sock.on('curation_progress', (p: { gameId: string; phase: string; done: number | null; total: number | null }) => {
      if (!isActive(p.gameId)) return;
      simulatorSlice().progress.set({ phase: p.phase, done: p.done, total: p.total });
      simulatorSlice().status.set('running');
    });
    const onDoc = (p: { gameId: string; doc: ISlotModelDoc }) => {
      if (!isActive(p.gameId)) return;
      const result = p.doc.result;
      simulatorSlice().result.set(result);
      simulatorSlice().progress.set(null);
      simulatorSlice().status.set(result ? statusFromResult(result) : 'idle');
    };
    sock.on('curation_complete', onDoc);
    sock.on('curation_failed', (p: { gameId: string; failure?: string }) => {
      if (!isActive(p.gameId)) return;
      simulatorSlice().status.set('error');
      simulatorSlice().progress.set(null);
    });
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    joinSim: (gameId: string) => sock?.emit('join_sim', { gameId }),
    leaveSim: (gameId: string) => sock?.emit('leave_sim', { gameId }),
  };
}

let client: ReturnType<typeof createSimSocket> | null = null;
export function simSock() {
  if (!client) client = createSimSocket();
  return client;
}
