// Joins the game's socket room via the EXISTING join_sim/leave_sim handlers (the room
// is the gameId) and listens for game_definition_changed. The handler is injected by
// actions.initGameStructure() — a seam that avoids an import cycle and eases testing.
import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import type { IComposeVerdict } from './restClient';

export interface IDefinitionChangedEvent {
  gameId: string;
  updatedAt: string;
  source: string;
}

let handler: ((p: IDefinitionChangedEvent) => void) | null = null;

export function setDefinitionChangedHandler(h: (p: IDefinitionChangedEvent) => void): void {
  handler = h;
}

// Emitted by the backend's debounced auto-build (Task 3) on every definition save.
export interface IBuildStatusEvent {
  gameId: string;
  status: 'building' | 'done' | 'error';
  errors?: string[];
  metrics?: unknown;
  verdict?: IComposeVerdict | null;
  packageId?: string;
}

let buildHandler: ((p: IBuildStatusEvent) => void) | null = null;

export function setBuildStatusHandler(h: (p: IBuildStatusEvent) => void): void {
  buildHandler = h;
}

let sock: Socket | null = null;

export function createGameStructureSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'game-structure' } });
    sock.on('game_definition_changed', (p: IDefinitionChangedEvent) => handler?.(p));
    sock.on('game_build_status', (p: IBuildStatusEvent) => buildHandler?.(p));
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    // Reuses the existing join_sim room (room == gameId); compose has no handlers of its own.
    join: (gameId: string) => sock?.emit('join_sim', { gameId }),
    leave: (gameId: string) => sock?.emit('leave_sim', { gameId }),
  };
}

let client: ReturnType<typeof createGameStructureSocket> | null = null;
export function gameStructureSock() {
  if (!client) client = createGameStructureSocket();
  return client;
}
