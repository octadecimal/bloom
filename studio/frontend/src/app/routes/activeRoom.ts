import { createContext, useContext, createElement, type ReactNode } from 'react';

const Ctx = createContext<string | null>(null);

export function ActiveRoomProvider({ roomId, children }: { roomId: string; children: ReactNode }) {
  return createElement(Ctx.Provider, { value: roomId }, children);
}

export function useActiveRoomId(): string {
  const v = useContext(Ctx);
  if (v == null) throw new Error('useActiveRoomId must be used within a room route');
  return v;
}
