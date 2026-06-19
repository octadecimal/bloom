import { useMemo } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { Button } from '@/components/ui/button';
import { setupWorkbench } from './workbenchSetup';

// TODO(Task 10): Replace probe-button with the real ThemeToggle.
// TODO(Task 11): Build out this header into the full menubar/toolbar.

export function Workbench() {
  const wb = useMemo(() => setupWorkbench(), []);
  const components = useMemo(() => wb.paneRegistry.asComponentMap(), [wb]);

  return (
    <div
      data-testid="workbench"
      style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      {/* Top header bar — keeps smoke.spec + styling.spec green */}
      <div style={{ flexShrink: 0, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: '1rem' }}>Bloom Studio</h1>
        <Button data-testid="probe-button">Click</Button>
      </div>

      {/* Dockview surface — fills remaining height */}
      <div className="dockview-theme-dark" style={{ flex: 1, overflow: 'hidden' }}>
        <DockviewReact
          components={components}
          onReady={(e: DockviewReadyEvent) => wb.onReady(e.api)}
        />
      </div>
    </div>
  );
}
