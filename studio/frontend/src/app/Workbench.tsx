import { useState, type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { useApp } from './AppContext';
import { useApplyTheme } from './useApplyTheme';
import { ThemeToggle } from './ThemeToggle';
import { AppMenubar } from './Menubar';
import { CommandPalette } from './CommandPalette';
import { SwitchUser } from './SwitchUser';
import { ModeBadge } from './ModeBadge';

export function Workbench({ leading }: { leading?: ReactNode }) {
  const app = useApp();
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  useApplyTheme(dockEl);

  return (
    <div data-testid="workbench" className="flex h-screen flex-col">
      <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          {leading}
          <h1 className="m-0 text-base font-semibold">Bloom Studio</h1>
          <AppMenubar />
        </div>
        <div className="flex items-center gap-2">
          <ModeBadge />
          <SwitchUser />
          <ThemeToggle />
        </div>
      </div>
      <CommandPalette />
      <div ref={setDockEl} className="flex-1 overflow-hidden">
        <DockviewReact components={app.components as never} onReady={(e: DockviewReadyEvent) => app.attachDockview(e.api)} />
      </div>
    </div>
  );
}
