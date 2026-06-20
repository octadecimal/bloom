import { useState } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { useApp } from './AppContext';
import { useApplyTheme } from './useApplyTheme';
import { ThemeToggle } from './ThemeToggle';
import { AppMenubar } from './Menubar';
import { CommandPalette } from './CommandPalette';
import { SwitchUser } from './SwitchUser';

export function Workbench() {
  const app = useApp();
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  useApplyTheme(dockEl);

  return (
    <div data-testid="workbench" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flexShrink: 0, padding: '0 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h1 style={{ margin: 0, fontSize: '1rem' }}>Bloom Studio</h1>
          <AppMenubar />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SwitchUser />
          <ThemeToggle />
        </div>
      </div>
      <CommandPalette />
      <div ref={setDockEl} style={{ flex: 1, overflow: 'hidden' }}>
        <DockviewReact components={app.components as never} onReady={(e: DockviewReadyEvent) => app.attachDockview(e.api)} />
      </div>
    </div>
  );
}
