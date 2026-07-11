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

export function applyCaptureRequest(payload: { gameId: string; captureId: string }): void {
  if (!isActive(payload.gameId)) return;
  getBridge()?.capture(payload.captureId);
}

export function applySpinOutcome(payload: { gameId: string; outcome: { grid: string[][] } }): void {
  if (!isActive(payload.gameId)) return;
  if (!import.meta.env.PROD) {
    (window as unknown as { __gameLastSpinOutcome?: unknown }).__gameLastSpinOutcome = payload.outcome;
  }
  getBridge()?.spin(payload.outcome);
}

export function applySpinTrace(payload: { gameId: string; trace: unknown[] }): void {
  if (!isActive(payload.gameId)) return;
  gameSlice().spinError.set(null);
  if (!import.meta.env.PROD) {
    (window as unknown as { __gameLastSpinTrace?: unknown }).__gameLastSpinTrace = payload;
  }
  getBridge()?.trace(payload.trace);
}

export function applySpinError(payload: { gameId: string; message: string }): void {
  if (!isActive(payload.gameId)) return;
  gameSlice().spinError.set(payload.message);
}

export function applyInbound(event: 'scene_snapshot' | 'scene_op', payload: unknown): void {
  if (event === 'scene_snapshot') {
    const p = payload as { gameId: string; document: ISceneDocument };
    if (!isActive(p.gameId)) return;
    const doc = loadDocument(p.document);
    sceneStore().document.set(doc as never);
    if (!import.meta.env.PROD) {
      (window as unknown as { __gameSceneDocument?: unknown }).__gameSceneDocument = sceneStore().document.get({ noproxy: true });
    }
    const bridge = getBridge();
    bridge?.init(doc);
  } else {
    const p = payload as { gameId: string; op: ISceneOp };
    if (!isActive(p.gameId)) return;
    const current = sceneStore().document.get({ noproxy: true }) as ISceneDocument;
    sceneStore().document.set(applyOpToDocument(current, p.op) as never);
    if (!import.meta.env.PROD) {
      (window as unknown as { __gameSceneDocument?: unknown }).__gameSceneDocument = sceneStore().document.get({ noproxy: true });
    }
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
    sock.on('scene_capture_request', (p) => applyCaptureRequest(p as { gameId: string; captureId: string }));
    sock.on('scene_spin_outcome', (p) => applySpinOutcome(p as { gameId: string; outcome: { grid: string[][] } }));
    sock.on('scene_spin_trace', (p) => applySpinTrace(p as { gameId: string; trace: unknown[] }));
    sock.on('scene_spin_error', (p) => applySpinError(p as { gameId: string; message: string }));
    if (!import.meta.env.PROD) {
      (window as unknown as { __gameApplyInbound?: typeof applyInbound }).__gameApplyInbound = applyInbound;
      (window as unknown as { __gameJoinScene?: (gameId: string) => void }).__gameJoinScene = (gameId: string) => sock?.emit('join_scene', { gameId });
      (window as unknown as { __gameRequestCapture?: (captureId: string) => void }).__gameRequestCapture = (captureId: string) =>
        getBridge()?.capture(captureId);
      (window as unknown as { __gameEmitApplyOp?: (gameId: string, op: ISceneOp) => void }).__gameEmitApplyOp = (gameId, op) => emitSceneApplyOp(gameId, op);
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

export function emitSceneCaptureResult(gameId: string, captureId: string, png: string): void {
  sock?.emit('scene_capture_result', { gameId, captureId, png });
}

export function emitSceneSpin(gameId: string, seed?: number): void {
  sock?.emit('scene_spin', seed === undefined ? { gameId } : { gameId, seed });
}
