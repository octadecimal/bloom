import { gameSlice } from './state';
import { sceneStore } from '../../scene/sceneStore';
import { emptyDocument } from '../../scene/reducers';
import { gameSock } from './socketClient';

export function initGame(): void {
  gameSock().connect();
}

export function openGame(gameId: string): void {
  const s = gameSlice();
  if (s.activeGameId.get() === gameId) return;
  const prev = s.activeGameId.get();
  if (prev) gameSock().leaveScene(prev);
  s.activeGameId.set(gameId);
  if (!import.meta.env.PROD) (window as unknown as { __gameActiveId?: string | null }).__gameActiveId = gameId;
  sceneStore().document.set(emptyDocument() as never);
  s.status.set('loading');
  gameSock().joinScene(gameId); // snapshot arrives over the socket
  s.status.set('idle');
}

export function closeGame(): void {
  const s = gameSlice();
  const prev = s.activeGameId.get();
  if (prev) gameSock().leaveScene(prev);
  s.activeGameId.set(null);
  if (!import.meta.env.PROD) (window as unknown as { __gameActiveId?: string | null }).__gameActiveId = null;
  sceneStore().document.set(emptyDocument() as never);
  s.status.set('idle');
}
