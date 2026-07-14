import { useState, type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { useApp } from './AppContext';
import { useApplyTheme } from './useApplyTheme';
import { bloomTheme } from './bloomTheme';
import { AppMenubar } from './Menubar';
import { CommandPalette } from './CommandPalette';
import { useFocusChatShortcut } from './focusChat';
import { SwitchUser } from './SwitchUser';
import { ModeBadge } from './ModeBadge';
import { BrandMark } from './BrandMark';
import { ToolbarDivider } from './ToolbarDivider';
import { PhaseSwitcher } from './PhaseSwitcher';

export function Workbench({ roomContext }: { roomContext?: ReactNode }) {
  const app = useApp();
  useApplyTheme();
  useFocusChatShortcut();
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <div data-testid="workbench" className="flex h-screen flex-col bg-canvas font-sans text-foreground">
      <div className="flex h-10 flex-shrink-0 items-center gap-2 bg-canvas px-3">
        <BrandMark />
        <ToolbarDivider />
        <AppMenubar />
        <div className="flex flex-1 items-center justify-center">
          <PhaseSwitcher />
        </div>
        <button
          type="button"
          data-testid="palette-hint"
          title="Open the command palette"
          onClick={() => setPaletteOpen(true)}
          className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-raised-hover hover:text-foreground"
        >
          Commands ⌘K
        </button>
        <ToolbarDivider />
        {roomContext && (
          <>
            {roomContext}
            <ToolbarDivider />
          </>
        )}
        <ModeBadge />
        <SwitchUser />
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <div className="flex-1 overflow-hidden">
        <DockviewReact theme={bloomTheme} components={app.components as never} onReady={(e: DockviewReadyEvent) => app.attachDockview(e.api)} />
      </div>
    </div>
  );
}
