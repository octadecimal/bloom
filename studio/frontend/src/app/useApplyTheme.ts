import { useEffect } from 'react';

// Dark-only app. The Dockview group classes are applied by the <DockviewReact theme={…}>
// prop (see bloomTheme); this hook only guarantees the document stays in dark mode.
export function useApplyTheme(): void {
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);
}
