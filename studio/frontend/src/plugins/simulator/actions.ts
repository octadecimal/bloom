import { simSock } from './socketClient';
import { simulatorSlice } from './state';
import { getSlotModel } from './restClient';

export function initSim(): void {
  simSock().connect();
}

export async function openGameSim(gameId: string): Promise<void> {
  const s = simulatorSlice();
  s.activeGameId.set(gameId);
  s.loadStatus.set('loading');
  simSock().joinSim(gameId);
  try {
    const doc = await getSlotModel(gameId);
    s.modelText.set(JSON.stringify(doc.model ?? {}, null, 2));
    s.params.set(doc.params);
    s.result.set(doc.result);
    s.status.set(doc.result ? doc.result.status : 'idle');
    s.loadStatus.set('idle');
  } catch {
    s.loadStatus.set('error');
  }
}

export function closeGameSim(): void {
  const s = simulatorSlice();
  const prev = s.activeGameId.get();
  if (prev) simSock().leaveSim(prev);
  s.activeGameId.set(null);
  s.modelText.set('');
  s.params.set(null);
  s.result.set(null);
  s.progress.set(null);
  s.status.set('idle');
  s.loadStatus.set('idle');
}
