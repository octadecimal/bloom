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
