// studio/frontend/src/plugins/assets/socketClient.ts
import { io } from 'socket.io-client';
import { BACKEND_URL } from './config';
import type { IAsset } from './state';
import { assetsSlice } from './state';
import { upsertAsset, setAssetStatus, setAssetProgress } from './reducers';
import { notify } from '../../lib/notify';

export interface ISocketLike {
  auth: Record<string, unknown>;
  readonly connected: boolean;
  on(event: string, cb: (payload: unknown) => void): void;
  emit(event: string, payload?: unknown): void;
  connect(): void;
  disconnect(): void;
}

type MakeSocket = (url: string) => ISocketLike;

function registerInboundHandlers(s: ISocketLike): void {
  const slice = assetsSlice;
  const isActive = (gameId: string) => slice().activeGameId.get() === gameId;
  const read = () => slice().assets.get({ noproxy: true }) as IAsset[];

  s.on('asset_status', (p) => {
    const { gameId, assetId, status } = p as { gameId: string; assetId: string; status: IAsset['status'] };
    if (!isActive(gameId)) return;
    slice().assets.set(setAssetStatus(read(), assetId, status));
  });
  s.on('asset_progress', (p) => {
    const { gameId, assetId, value, max } = p as { gameId: string; assetId: string; value: number; max: number };
    if (!isActive(gameId)) return;
    slice().assets.set(setAssetProgress(read(), assetId, value, max));
  });
  s.on('asset_completed', (p) => {
    const { gameId, asset } = p as { gameId: string; asset: IAsset };
    if (!isActive(gameId)) return;
    slice().assets.set(upsertAsset(read(), { ...asset, progress: null }));
  });
  s.on('error', (p) => {
    const { message } = p as { message: string };
    notify.error(message ?? 'asset error');
  });
}

export function createSocketClient(makeSocket: MakeSocket) {
  let sock: ISocketLike | null = null;

  function wire(s: ISocketLike): void {
    s.on('connect', () => {
      assetsSlice().connection.set('connected');
      const active = assetsSlice().activeGameId.get();
      if (active) s.emit('join_game', { gameId: active });
    });
    s.on('disconnect', () => {
      assetsSlice().connection.set('reconnecting');
    });
    registerInboundHandlers(s);
  }

  function connect(): void {
    assetsSlice().connection.set('connecting');
    sock = makeSocket(BACKEND_URL);
    wire(sock);
  }

  function disconnect(): void {
    sock?.disconnect();
    assetsSlice().connection.set('disconnected');
  }

  const emit = (event: string, payload: unknown) => sock?.emit(event, payload);

  return {
    connect,
    disconnect,
    getSocket: () => sock,
    joinGame: (gameId: string) => emit('join_game', { gameId }),
    leaveGame: (gameId: string) => emit('leave_game', { gameId }),
    generateAsset: (gameId: string, assetId: string) => emit('generate_asset', { gameId, assetId }),
  };
}

export type SocketClient = ReturnType<typeof createSocketClient>;

// Module singleton over the real socket.io-client.
let singleton: SocketClient | null = null;

export function initSocketClient(): SocketClient {
  singleton = createSocketClient((url) => io(url, { autoConnect: true }) as unknown as ISocketLike);
  return singleton;
}

export function getSocketClient(): SocketClient {
  if (!singleton) throw new Error('assets socket client not initialised');
  return singleton;
}
