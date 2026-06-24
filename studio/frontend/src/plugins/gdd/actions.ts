import { gddSlice } from './state';
import { getGddDocs } from './restClient';
import { gddSock } from './socketClient';

export function initGdd(): void {
  gddSock().connect();
}

export function closeGameDocs(): void {
  const s = gddSlice();
  const prev = s.activeGameId.get();
  if (prev) gddSock().leaveGdd(prev);
  s.activeGameId.set(null);
  s.docs.set([]);
  s.docsStatus.set('idle');
  s.selectedAspect.set(null);
}

export async function openGameDocs(gameId: string): Promise<void> {
  gddSlice().activeGameId.set(gameId);
  gddSlice().docsStatus.set('loading');
  gddSock().joinGdd(gameId);
  try {
    const docs = await getGddDocs(gameId);
    gddSlice().docs.set(docs.slice().sort((a, b) => a.order - b.order));
    gddSlice().docsStatus.set('idle');
  } catch {
    gddSlice().docsStatus.set('error');
  }
}
