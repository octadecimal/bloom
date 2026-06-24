import { BACKEND_URL } from './config';
import type { IGddDoc } from './state';

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getGddDocs(gameId: string): Promise<IGddDoc[]> {
  return okJson<IGddDoc[]>(await fetch(`${BACKEND_URL}/games/${gameId}/gdd/docs`));
}
