import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { gddSlice, type IGddDoc } from './state';
import { upsertDoc } from './reducers';

let sock: Socket | null = null;

function read(): IGddDoc[] {
  return gddSlice().docs.get({ noproxy: true }) as IGddDoc[];
}
function isActive(gameId: string): boolean {
  return gddSlice().activeGameId.get() === gameId;
}

export interface ISlotModelChangedEvent {
  gameId: string;
  updatedAt: string;
  source: string;
}

// Set by whoever wants to react to a live slot-model change (the GDD mirror);
// `join_gdd` already enters the gameId room, so no second socket connection
// is needed — this just adds a listener to the one the gdd plugin already owns.
let modelChangedHandler: ((p: ISlotModelChangedEvent) => void) | null = null;
export function setModelChangedHandler(h: ((p: ISlotModelChangedEvent) => void) | null): void {
  modelChangedHandler = h;
}

export function createGddSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'gdd-viewer' } });
    sock.on('gdd_snapshot', (p: { gameId: string; docs: IGddDoc[] }) => {
      if (!isActive(p.gameId)) return;
      gddSlice().docs.set(p.docs.slice().sort((a, b) => a.order - b.order));
    });
    sock.on('gdd_doc_updated', (p: { gameId: string; doc: IGddDoc }) => {
      if (!isActive(p.gameId)) return;
      gddSlice().docs.set(upsertDoc(read(), p.doc));
    });
    sock.on('slot_model_changed', (p: ISlotModelChangedEvent) => {
      if (!isActive(p.gameId)) return;
      modelChangedHandler?.(p);
    });
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    joinGdd: (gameId: string) => sock?.emit('join_gdd', { gameId }),
    leaveGdd: (gameId: string) => sock?.emit('leave_gdd', { gameId }),
  };
}

let client: ReturnType<typeof createGddSocket> | null = null;
export function gddSock() {
  if (!client) client = createGddSocket();
  return client;
}
