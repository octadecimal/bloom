import { BACKEND_URL } from './config';
import type { ISlotModel } from './model';
import type { IPresentation } from './presentation';
import type { ISectionLocks } from './state';

export interface ISlotModelWireDoc {
  id: string;
  gameId: string;
  model: unknown;
  presentation?: unknown; // absent until the backend task lands; normalized on hydrate
  locks?: ISectionLocks;
  updatedAt: string;
}

export interface IPutSlotModelPatch {
  model?: ISlotModel;
  presentation?: IPresentation;
  locks?: ISectionLocks;
  source: string;
}

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getSlotModel(gameId: string): Promise<ISlotModelWireDoc> {
  return okJson<ISlotModelWireDoc>(await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`));
}

export async function putSlotModel(gameId: string, patch: IPutSlotModelPatch): Promise<ISlotModelWireDoc> {
  return okJson<ISlotModelWireDoc>(
    await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function applyTemplate(gameId: string, name: string): Promise<ISlotModelWireDoc> {
  return okJson<ISlotModelWireDoc>(
    await fetch(`${BACKEND_URL}/games/${gameId}/slot-model/apply-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
}
