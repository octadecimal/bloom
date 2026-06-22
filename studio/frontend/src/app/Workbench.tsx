import { type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { useApp } from './AppContext';
import { useApplyTheme } from './useApplyTheme';
import { bloomTheme } from './bloomTheme';
import { AppMenubar } from './Menubar';
import { CommandPalette } from './CommandPalette';
import { SwitchUser } from './SwitchUser';
import { ModeBadge } from './ModeBadge';
import { BrandMark } from './BrandMark';
import { ToolbarDivider } from './ToolbarDivider';

export function Workbench({ roomContext }: { roomContext?: ReactNode }) {
  const app = useApp();
  useApplyTheme();

  return (
    <div data-testid="workbench" className="flex h-screen flex-col bg-canvas font-sans text-foreground">
      <div className="flex h-10 flex-shrink-0 items-center gap-2 bg-canvas px-3">
        <BrandMark />
        <ToolbarDivider />
        <AppMenubar />
        <div className="flex-1" />
        {roomContext && (
          <>
            {roomContext}
            <ToolbarDivider />
          </>
        )}
        <ModeBadge />
        <SwitchUser />
      </div>
      <CommandPalette />
      <div className="flex-1 overflow-hidden">
        <DockviewReact theme={bloomTheme} components={app.components as never} onReady={(e: DockviewReadyEvent) => app.attachDockview(e.api)} />
      </div>
    </div>
  );
}
