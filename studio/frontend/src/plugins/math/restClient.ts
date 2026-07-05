import { BACKEND_URL } from './config';
import type { IMathRun, ICurationParams, ICurationResult, ISectionLocks, ITargetSpec, ITuneResult, ITuningParams } from './state';

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

// NOTE: the backend endpoint (studio/backend/app/analytics/rest.py) takes a plain
// `game_id` function parameter, which FastAPI binds to the literal query key
// `game_id` (snake_case) — it is not run through the `to_camel` alias generator
// that governs the *body*/response wire shape. Mirror the actual merged source,
// not any camelCase mention in the plan.
export async function fetchRuns(gameId: string, limit = 50): Promise<IMathRun[]> {
  const url = `${BACKEND_URL}/analytics/runs?game_id=${encodeURIComponent(gameId)}&limit=${limit}`;
  return okJson<IMathRun[]>(await fetch(url));
}

export async function fetchRun(id: string): Promise<IMathRun> {
  return okJson<IMathRun>(await fetch(`${BACKEND_URL}/analytics/runs/${encodeURIComponent(id)}`));
}

export interface ISlotModelWire {
  id: string;
  gameId: string;
  model: unknown;
  params: ICurationParams;
  locks: ISectionLocks;
  result: ICurationResult | null;
  updatedAt: string;
}

export interface ITunerWire {
  id: string;
  gameId: string;
  params: ITuningParams;
  result: ITuneResult | null;
  updatedAt: string;
}

export interface IGddDocWire {
  aspect: string;
  data: Record<string, unknown>;
  updatedAt: string;
}

export async function getSlotModel(gameId: string): Promise<ISlotModelWire> {
  return okJson<ISlotModelWire>(await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`));
}

export async function putCurationParams(gameId: string, params: ICurationParams): Promise<ISlotModelWire> {
  return okJson<ISlotModelWire>(
    await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params }),
    }),
  );
}

export async function curate(gameId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/slot-model/curate`, { method: 'POST' });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
}

export async function generate(gameId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/math/generate`, { method: 'POST' });
  if (!res.ok) throw new Error(res.status === 409 ? 'a run is already in progress' : `request failed: ${res.status}`);
}

export async function cancelGenerate(gameId: string): Promise<'accepted' | 'idle'> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/math/generate/cancel`, { method: 'POST' });
  if (res.status === 409) return 'idle'; // no active run — caller self-heals
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return 'accepted';
}

export async function getTuner(gameId: string): Promise<ITunerWire> {
  return okJson<ITunerWire>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner`));
}

export async function putTunerParams(gameId: string, params: ITuningParams): Promise<ITunerWire> {
  return okJson<ITunerWire>(
    await fetch(`${BACKEND_URL}/games/${gameId}/tuner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params }),
    }),
  );
}

export async function applyTuned(gameId: string): Promise<ISlotModelWire> {
  return okJson<ISlotModelWire>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/apply`, { method: 'POST' }));
}

export async function getTarget(gameId: string): Promise<{ target?: ITargetSpec; gap?: string }> {
  return okJson<{ target?: ITargetSpec; gap?: string }>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/target`));
}

export async function getGddDocs(gameId: string): Promise<IGddDocWire[]> {
  return okJson<IGddDocWire[]>(await fetch(`${BACKEND_URL}/games/${gameId}/gdd/docs`));
}

export async function putMathModelFields(gameId: string, fields: Record<string, unknown>): Promise<IGddDocWire> {
  const res = await okJson<{ doc: IGddDocWire }>(
    await fetch(`${BACKEND_URL}/games/${gameId}/gdd/math-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    }),
  );
  return res.doc;
}
