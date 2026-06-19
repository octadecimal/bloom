import { useMemo, useState } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { setupWorkbench } from './workbenchSetup';
import { useApplyTheme } from './useApplyTheme';
import { ThemeToggle } from './ThemeToggle';

// TODO(Task 11): Build out this header into the full menubar/toolbar.

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
      <div style={{ flexShrink: 0, padding: '0 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: '1rem' }}>Bloom Studio</h1>
        <ThemeToggle />
      </div>

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
