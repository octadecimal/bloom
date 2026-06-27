import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { gameSlice } from './state';
import { sceneStore } from '../../scene/sceneStore';
import type { ISceneDocument } from '../../scene/types';
import { applyOpToDocument, loadDocument, type ISceneOp } from '../../scene/reducers';
import { getBridge } from './protocolBridge';

let sock: Socket | null = null;

function isActive(gameId: string): boolean {
  return gameSlice().activeGameId.get() === gameId;
}

export function applyInbound(event: 'scene_snapshot' | 'scene_op', payload: unknown): void {
  if (event === 'scene_snapshot') {
    const p = payload as { gameId: string; document: ISceneDocument };
    if (!isActive(p.gameId)) return;
    const doc = loadDocument(p.document);
    sceneStore().document.set(doc as never);
    const bridge = getBridge();
    bridge?.init(doc);
  } else {
    const p = payload as { gameId: string; op: ISceneOp };
    if (!isActive(p.gameId)) return;
    const current = sceneStore().document.get({ noproxy: true }) as ISceneDocument;
    sceneStore().document.set(applyOpToDocument(current, p.op) as never);
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
    sock.on('scene_snapshot', (p) => {
      applyInbound('scene_snapshot', p);
      if (!import.meta.env.PROD) {
        // Expose the raw scene document for e2e inspection (dev only).
        (window as unknown as { __gameSceneSnapshot?: unknown }).__gameSceneSnapshot = p;
      }
    });
    sock.on('scene_op', (p) => applyInbound('scene_op', p));
    if (!import.meta.env.PROD) {
      (window as unknown as { __gameApplyInbound?: typeof applyInbound }).__gameApplyInbound = applyInbound;
      (window as unknown as { __gameJoinScene?: (gameId: string) => void }).__gameJoinScene = (gameId: string) => sock?.emit('join_scene', { gameId });
    }
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

export function emitSceneApplyOp(gameId: string, op: ISceneOp): void {
  sock?.emit('scene_apply_op', { gameId, op });
  if (!import.meta.env.PROD) {
    (window as unknown as { __gameLastApplyOp?: unknown }).__gameLastApplyOp = { gameId, op };
  }
}
