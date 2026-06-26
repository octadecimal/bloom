import { tunerSock } from './socketClient';
import { tunerSlice } from './state';
import { getTuner, getTunerSeed, getTunerTarget } from './restClient';

export function initTuner(): void {
  tunerSock().connect();
}

export async function openGameTuner(gameId: string): Promise<void> {
  const s = tunerSlice();
  s.activeGameId.set(gameId);
  s.loadStatus.set('loading');
  s.applied.set(false);
  tunerSock().joinTuner(gameId);
  try {
    const doc = await getTuner(gameId);
    s.params.set(doc.params);
    s.result.set(doc.result);
    s.failure.set(null);
    s.status.set(doc.result ? doc.result.status : 'idle');
    await refreshSeedAndTarget(gameId);
    s.loadStatus.set('idle');
  } catch {
    s.loadStatus.set('error');
  }
}

/**
 * Re-hydrate the persisted tuner result from the backend (`GET /games/:id/tuner`).
 *
 * Called when the Tuner pane opens so the Apply button reflects an already-completed
 * tune — including one started from chat (`tune_slot_model` → `request_tune`) — even
 * when the live `tuning_complete` socket event was missed because the pane was not
 * subscribed at the moment it fired (issue #82). Without this, Apply stays disabled and
 * a click is a silent no-op against a model that was actually tuned and persisted.
 *
 * A live run (`status === 'running'`) is streaming progress over the socket; leave it
 * untouched so a stale persisted result can't overwrite the in-flight run.
 */
export async function refreshTunerResult(gameId: string): Promise<void> {
  const s = tunerSlice();
  if (s.status.get() === 'running') return;
  try {
    const doc = await getTuner(gameId);
    s.result.set(doc.result);
    if (doc.result) s.status.set(doc.result.status);
  } catch {
    // Keep whatever state we have; a transient fetch failure shouldn't blank the pane.
  }
}

export async function refreshSeedAndTarget(gameId: string): Promise<void> {
  const s = tunerSlice();
  const seed = await getTunerSeed(gameId);
  s.seedModelText.set(JSON.stringify(seed.model ?? {}, null, 2));
  const target = await getTunerTarget(gameId);
  s.derivedTarget.set(target.target ?? null);
  s.targetGap.set(target.gap ?? null);
}

export function closeGameTuner(): void {
  const s = tunerSlice();
  const prev = s.activeGameId.get();
  if (prev) tunerSock().leaveTuner(prev);
  s.activeGameId.set(null);
  s.seedModelText.set('');
  s.params.set(null);
  s.derivedTarget.set(null);
  s.targetGap.set(null);
  s.result.set(null);
  s.failure.set(null);
  s.progress.set(null);
  s.applied.set(false);
  s.status.set('idle');
  s.loadStatus.set('idle');
}
