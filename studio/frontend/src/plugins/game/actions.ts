import { gameSlice, emptyDocument } from './state';
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
  s.document.set(emptyDocument() as never);
  s.status.set('loading');
  gameSock().joinScene(gameId); // snapshot arrives over the socket
  s.status.set('idle');
}

export function closeGame(): void {
  const s = gameSlice();
  const prev = s.activeGameId.get();
  if (prev) gameSock().leaveScene(prev);
  s.activeGameId.set(null);
  s.document.set(emptyDocument() as never);
  s.status.set('idle');
}
