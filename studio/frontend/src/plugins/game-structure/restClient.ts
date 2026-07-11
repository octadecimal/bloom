import { BACKEND_URL } from './config';
import type { IGameDefinition } from './model';

export interface IGameDefinitionWireDoc {
  id: string;
  gameId: string;
  definition: unknown;
  presentation?: unknown;
  updatedAt: string;
}

export interface IPutGameDefinitionPatch {
  definition?: IGameDefinition;
  presentation?: Record<string, unknown>;
  source: string;
}

export interface IComposeMetrics {
  rtp: number;
  hitRate: number;
  maxWinX: number;
  stateVisits: Record<string, number>;
}

export interface IBuildResponse {
  ok: boolean;
  errors: string[];
  metrics: IComposeMetrics | null;
  packageId: string;
}

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getGameDefinition(gameId: string): Promise<IGameDefinitionWireDoc> {
  return okJson<IGameDefinitionWireDoc>(await fetch(`${BACKEND_URL}/games/${gameId}/game-definition`));
}

export async function putGameDefinition(gameId: string, patch: IPutGameDefinitionPatch): Promise<IGameDefinitionWireDoc> {
  return okJson<IGameDefinitionWireDoc>(
    await fetch(`${BACKEND_URL}/games/${gameId}/game-definition`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function validateGameDefinition(gameId: string, definition: IGameDefinition): Promise<{ ok: boolean; errors: string[] }> {
  return okJson(
    await fetch(`${BACKEND_URL}/games/${gameId}/game-definition/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition }),
    }),
  );
}

export async function buildGameDefinition(gameId: string): Promise<IBuildResponse> {
  return okJson(
    await fetch(`${BACKEND_URL}/games/${gameId}/game-definition/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
}
