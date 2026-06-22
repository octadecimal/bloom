import { type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { useApp } from './AppContext';
import { useApplyTheme } from './useApplyTheme';
import { bloomTheme } from './bloomTheme';
import { AppMenubar } from './Menubar';
import { CommandPalette } from './CommandPalette';
import { SwitchUser } from './SwitchUser';
import { ModeBadge } from './ModeBadge';

export function Workbench({ leading }: { leading?: ReactNode }) {
  const app = useApp();
  useApplyTheme();

  return (
    <div data-testid="workbench" className="flex h-screen flex-col bg-canvas font-sans text-foreground">
      <div className="flex h-9 flex-shrink-0 items-center justify-between bg-canvas px-2.5">
        <div className="flex items-center gap-2">
          {leading}
          <h1 className="m-0 text-[13px] font-semibold tracking-tight">Bloom Studio</h1>
          <AppMenubar />
        </div>
        <div className="flex items-center gap-2">
          <ModeBadge />
          <SwitchUser />
        </div>
      </div>
      <CommandPalette />
      <div className="flex-1 overflow-hidden">
        <DockviewReact theme={bloomTheme} components={app.components as never} onReady={(e: DockviewReadyEvent) => app.attachDockview(e.api)} />
      </div>
    </div>
  );
}
