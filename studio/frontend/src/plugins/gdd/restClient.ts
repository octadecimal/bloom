import { BACKEND_URL } from './config';
import type { IGddDoc } from './state';

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getGddDocs(gameId: string): Promise<IGddDoc[]> {
  return okJson<IGddDoc[]>(await fetch(`${BACKEND_URL}/games/${gameId}/gdd/docs`));
}

export interface ISetGddFieldsResult {
  doc: IGddDoc;
  warnings: string[];
  rebuilt: boolean;
}

export async function setGddFields(gameId: string, aspect: string, fields: Record<string, unknown>): Promise<ISetGddFieldsResult> {
  return okJson<ISetGddFieldsResult>(
    await fetch(`${BACKEND_URL}/games/${gameId}/gdd/${aspect}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields }),
    }),
  );
}
