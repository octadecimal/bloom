import type { IRoom, IMessage, ISkill } from './state';
import { BACKEND_URL } from './config';

export interface IModelOption {
  id: string;
  label: string;
  free: boolean;
}

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getModels(): Promise<IModelOption[]> {
  return okJson<IModelOption[]>(await fetch(`${BACKEND_URL}/models`));
}

export async function getRooms(): Promise<IRoom[]> {
  return okJson<IRoom[]>(await fetch(`${BACKEND_URL}/rooms`));
}

export async function getSkills(): Promise<ISkill[]> {
  return okJson<ISkill[]>(await fetch(`${BACKEND_URL}/skills`));
}

export async function createRoom(name: string, model?: string): Promise<IRoom> {
  const res = await fetch(`${BACKEND_URL}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, model }),
  });
  return okJson<IRoom>(res);
}

export async function getMessages(roomId: string): Promise<IMessage[]> {
  return okJson<IMessage[]>(await fetch(`${BACKEND_URL}/rooms/${roomId}/messages`));
}
