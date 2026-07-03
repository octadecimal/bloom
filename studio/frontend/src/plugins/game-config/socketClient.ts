// Joins the game's socket room via the EXISTING join_sim/leave_sim handlers (the room
// is the gameId) and listens for slot_model_changed. The handler is injected by
// actions.initGameConfig() — a seam that avoids an import cycle and eases testing.
import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';

export interface IModelChangedEvent {
  gameId: string;
  updatedAt: string;
  source: string;
}

let handler: ((p: IModelChangedEvent) => void) | null = null;

export function setModelChangedHandler(h: (p: IModelChangedEvent) => void): void {
  handler = h;
}

let sock: Socket | null = null;

export function createGameConfigSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'game-config' } });
    sock.on('slot_model_changed', (p: IModelChangedEvent) => handler?.(p));
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    join: (gameId: string) => sock?.emit('join_sim', { gameId }),
    leave: (gameId: string) => sock?.emit('leave_sim', { gameId }),
  };
}

let client: ReturnType<typeof createGameConfigSocket> | null = null;
export function gameConfigSock() {
  if (!client) client = createGameConfigSocket();
  return client;
}
