import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { gameSlice, type IGameDocument } from './state';
import { applyOpToDocument, loadDocument, type ISceneOp } from './reducers';
import { getBridge } from './protocolBridge';

let sock: Socket | null = null;

function isActive(gameId: string): boolean {
  return gameSlice().activeGameId.get() === gameId;
}

export function applyInbound(event: 'scene_snapshot' | 'scene_op', payload: unknown): void {
  if (event === 'scene_snapshot') {
    const p = payload as { gameId: string; document: IGameDocument };
    if (!isActive(p.gameId)) return;
    const doc = loadDocument(p.document);
    gameSlice().document.set(doc as never);
    const bridge = getBridge();
    bridge?.init(doc);
  } else {
    const p = payload as { gameId: string; op: ISceneOp };
    if (!isActive(p.gameId)) return;
    const current = gameSlice().document.get({ noproxy: true }) as IGameDocument;
    gameSlice().document.set(applyOpToDocument(current, p.op) as never);
    getBridge()?.op(p.op);
  }
}

export function createGameSocket() {
  function connect(): void {
    if (sock) return;
    gameSlice().connection.set('connecting');
    sock = io(BACKEND_URL, { auth: { displayName: 'game-preview' } });
    sock.on('connect', () => {
      gameSlice().connection.set('connected');
      const active = gameSlice().activeGameId.get();
      if (active) sock?.emit('join_scene', { gameId: active });
    });
    sock.on('disconnect', () => gameSlice().connection.set('reconnecting'));
    sock.on('scene_snapshot', (p) => applyInbound('scene_snapshot', p));
    sock.on('scene_op', (p) => applyInbound('scene_op', p));
    if (!import.meta.env.PROD) (window as unknown as { __gameApplyInbound?: typeof applyInbound }).__gameApplyInbound = applyInbound;
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
    gameSlice().connection.set('disconnected');
  }
  return {
    connect,
    disconnect,
    joinScene: (gameId: string) => sock?.emit('join_scene', { gameId }),
    leaveScene: (gameId: string) => sock?.emit('leave_scene', { gameId }),
  };
}

let client: ReturnType<typeof createGameSocket> | null = null;
export function gameSock() {
  if (!client) client = createGameSocket();
  return client;
}
