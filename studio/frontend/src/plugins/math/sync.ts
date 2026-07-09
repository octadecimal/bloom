import { mathSlice, type ITargetFields } from './state';
import { getSlotModel, getTarget, getTuner } from './restClient';

export function fieldsFromGddData(data: Record<string, unknown>): ITargetFields {
  return {
    rtp: data.rtp == null ? '' : String(data.rtp),
    volatility: data.volatility == null ? '' : String(data.volatility),
    bonusHitRate: data.bonus_hit_rate == null ? '' : String(data.bonus_hit_rate),
  };
}

function isActive(gameId: string): boolean {
  return mathSlice().activeGameId.get() === gameId;
}

export async function refreshTarget(gameId: string): Promise<void> {
  try {
    const t = await getTarget(gameId);
    if (!isActive(gameId)) return;
    const s = mathSlice();
    s.derivedTarget.set(t.target ?? null);
    s.targetGap.set(t.gap ?? null);
  } catch {
    // keep whatever bands we have; transient failures must not blank the strip
  }
}

/** Re-pull doc-derived state (locks, curation params, stored-model result). */
export async function refreshDoc(gameId: string): Promise<void> {
  try {
    const doc = await getSlotModel(gameId);
    if (!isActive(gameId)) return;
    const s = mathSlice();
    s.locks.set(doc.locks);
    s.curationParams.set(doc.params);
    s.verifyResult.set(doc.result);
    s.verdictStale.set(!!doc.verdictStale);
  } catch {
    // keep current state
  }
}

/** Port of the Tuner pane's issue-#82/PR-#99 re-hydration: refresh the pending
 * tuned model so Apply works for tunes that completed out-of-pane (chat).
 * A streaming run is left untouched. */
export async function refreshTuneResult(gameId: string): Promise<void> {
  const s = mathSlice();
  const gen = s.genStatus.get();
  if (gen === 'tuning' || gen === 'verifying') return;
  try {
    const doc = await getTuner(gameId);
    if (!isActive(gameId)) return;
    s.tuneResult.set(doc.result);
  } catch {
    // keep current state
  }
}
