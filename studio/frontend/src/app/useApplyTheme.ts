import { useEffect } from 'react';

export function useApplyTheme(dockEl: HTMLElement | null): void {
  useEffect(() => {
    document.documentElement.classList.add('dark');
    if (dockEl) {
      dockEl.classList.add('dockview-theme-dark', 'dockview-theme-bloom');
    }
  }, [dockEl]);
}
