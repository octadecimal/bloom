import { useMemo, useState } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { setupWorkbench } from './workbenchSetup';
import { useApplyTheme } from './useApplyTheme';
import { ThemeToggle } from './ThemeToggle';
import { AppMenubar } from './Menubar';
import { CommandPalette } from './CommandPalette';

export function Workbench() {
  const wb = useMemo(() => setupWorkbench(), []);
  const components = useMemo(() => wb.paneRegistry.asComponentMap(), [wb]);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  useApplyTheme(dockEl);

  return (
    <div
      data-testid="workbench"
      style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      {/* Top header bar */}
      <div
        style={{
          flexShrink: 0,
          padding: '0 8px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        {/* Left group: title + menubar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h1 style={{ margin: 0, fontSize: '1rem' }}>Bloom Studio</h1>
          <AppMenubar />
        </div>
        {/* Right: theme toggle */}
        <ThemeToggle />
      </div>

      {/* Command palette — mounted once, renders a closed dialog + installs Ctrl-K listener */}
      <CommandPalette />

      {/* Dockview surface — fills remaining height; theme class managed by useApplyTheme */}
      <div ref={setDockEl} style={{ flex: 1, overflow: 'hidden' }}>
        <DockviewReact
          components={components}
          onReady={(e: DockviewReadyEvent) => wb.onReady(e.api)}
        />
      </div>
    </div>
  );
}
