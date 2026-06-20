import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { loadSession, saveSession, clearSession } from './session';

interface ISessionContext {
  username: string | null;
  login(name: string): void;
  logout(): void;
}
const Ctx = createContext<ISessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(() => loadSession()?.username ?? null);
  const value = useMemo<ISessionContext>(
    () => ({
      username,
      login: (name: string) => {
        const t = name.trim();
        if (!t) return;
        saveSession(t);
        setUsername(t);
      },
      logout: () => {
        clearSession();
        setUsername(null);
      },
    }),
    [username],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): ISessionContext {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used within <SessionProvider>');
  return v;
}
