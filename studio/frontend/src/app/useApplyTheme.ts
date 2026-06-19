import { useEffect } from 'react';
import { useHookstate } from '@hookstate/core';
import { rootStore } from '../state/rootStore';

export function useApplyTheme(dockEl: HTMLElement | null): void {
  const theme = useHookstate(rootStore.workspace.theme);
  useEffect(() => {
    const dark = theme.get() === 'dark';
    document.documentElement.classList.toggle('dark', dark); // shadcn / Tailwind
    if (dockEl) {
      dockEl.classList.toggle('dockview-theme-dark', dark);
      dockEl.classList.toggle('dockview-theme-light', !dark);
    }
  }, [theme.get(), dockEl]);
}
