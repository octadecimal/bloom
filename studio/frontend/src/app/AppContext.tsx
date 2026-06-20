import { createContext, useContext, type ReactNode } from 'react';
import { setupApp, type IAppSetup } from './setupApp';

const Ctx = createContext<IAppSetup | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={setupApp()}>{children}</Ctx.Provider>;
}

export function useApp(): IAppSetup {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within <AppProvider>');
  return v;
}
