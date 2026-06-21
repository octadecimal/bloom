// studio/frontend/src/plugins/assets/actions.ts
import { assetsSlice, type IAsset, type IGame } from './state';
import { upsertAsset } from './reducers';
import * as realRest from './restClient';
import type { ICreateAssetInput } from './restClient';
import { getSocketClient, initSocketClient, type SocketClient } from './socketClient';
import { notify } from '../../lib/notify';

interface IRestDeps {
  getGames: typeof realRest.getGames;
  getAssets: typeof realRest.getAssets;
  createGame: typeof realRest.createGame;
  createAsset: typeof realRest.createAsset;
  updateAsset: typeof realRest.updateAsset;
  deleteAsset: typeof realRest.deleteAsset;
  selectGeneration: typeof realRest.selectGeneration;
}

type SocketDeps = Pick<SocketClient, 'connect' | 'disconnect' | 'joinGame' | 'leaveGame' | 'generateAsset'>;

let rest: IRestDeps = realRest;
let socket: SocketDeps | null = null;
let started = false;

export function __setDeps(deps: { rest?: IRestDeps; socket?: SocketDeps | null }): void {
  if (deps.rest) rest = deps.rest;
  if (deps.socket !== undefined) {
    socket = deps.socket;
    started = false;
  }
}

function sock(): SocketDeps {
  return socket ?? getSocketClient();
}

function ensureConnected(): void {
  if (started) return;
  if (socket === null) initSocketClient();
  started = true;
  sock().connect();
}

const read = () => assetsSlice().assets.get({ noproxy: true }) as IAsset[];

export async function loadGames(): Promise<void> {
  assetsSlice().gamesStatus.set('loading');
  try {
    assetsSlice().games.set(await rest.getGames());
    assetsSlice().gamesStatus.set('idle');
  } catch {
    assetsSlice().gamesStatus.set('error');
  }
}

export async function openGame(gameId: string): Promise<void> {
  const s = assetsSlice();
  if (s.activeGameId.get() === gameId) return;

  const prev = s.activeGameId.get();
  if (prev) sock().leaveGame(prev);

  s.activeGameId.set(gameId);
  s.assets.set([]);
  s.assetsStatus.set('loading');

  try {
    const assets = await rest.getAssets(gameId);
    if (assetsSlice().activeGameId.get() !== gameId) return; // a newer openGame won
    // Ensure the client-only `progress` field is always initialised so hookstate
    // creates a node for it. Assets from the API never include `progress`.
    s.assets.set(assets.map((a) => ({ ...a, progress: null })));
    s.assetsStatus.set('idle');
  } catch {
    if (assetsSlice().activeGameId.get() !== gameId) return;
    s.assetsStatus.set('error');
  }
  sock().joinGame(gameId);
}

export async function createGame(name: string): Promise<void> {
  const created = await rest.createGame(name);
  const s = assetsSlice();
  s.games.set([...(s.games.get({ noproxy: true }) as IGame[]), created]);
  await openGame(created.id);
}

export async function createAsset(input: ICreateAssetInput): Promise<void> {
  const gameId = assetsSlice().activeGameId.get();
  if (!gameId) return;
  const created = await rest.createAsset(gameId, input);
  // Ensure the client-only `progress` field is always initialised so hookstate
  // creates a node for it. Assets from the API never include `progress`.
  assetsSlice().assets.set(upsertAsset(read(), { ...created, progress: null }));
}

export async function updateAsset(assetId: string, patch: Partial<ICreateAssetInput>): Promise<void> {
  const updated = await rest.updateAsset(assetId, patch);
  assetsSlice().assets.set(upsertAsset(read(), { ...updated, progress: null }));
}

export async function deleteAsset(assetId: string): Promise<void> {
  await rest.deleteAsset(assetId);
  assetsSlice().assets.set(read().filter((a) => a.id !== assetId));
  notify.info('Asset deleted');
}

export function generateAsset(assetId: string): void {
  const gameId = assetsSlice().activeGameId.get();
  if (gameId) sock().generateAsset(gameId, assetId);
}

export async function selectGeneration(assetId: string, generationId: string): Promise<void> {
  const updated = await rest.selectGeneration(assetId, generationId);
  assetsSlice().assets.set(upsertAsset(read(), { ...updated, progress: null }));
}

export function initAssets(): void {
  ensureConnected();
  void loadGames();
}
