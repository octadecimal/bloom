import { BACKEND_URL } from './config';
import type { IMathRun } from './state';

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
