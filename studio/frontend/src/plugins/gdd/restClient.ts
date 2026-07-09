import { BACKEND_URL } from './config';
import type { IGddDoc } from './state';
import type { IMirrorModel } from './MirrorSection';

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

// The wire subset the GDD mirror reads from the unified slot-model doc
// (studio/backend/app/math/models.py:sim_wire). Only the fields the mirror
// actually consumes are typed here — the real response carries more.
export interface ISlotModelMirrorDoc {
  model: IMirrorModel;
  shapeStale: boolean;
}

export async function getSlotModel(gameId: string): Promise<ISlotModelMirrorDoc> {
  return okJson<ISlotModelMirrorDoc>(await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`));
}

export async function realizeSlotModel(gameId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/slot-model/realize`, { method: 'POST' });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
}
