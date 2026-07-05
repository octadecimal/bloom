import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SlidersHorizontal } from 'lucide-react';
import { PaneSidebar, PaneSidebarToggle, usePaneSidebar } from './PaneSidebar';

const KEY = 'test.pane.sidebar';

function Harness() {
  const sb = usePaneSidebar(KEY);
  return (
    <div>
      <PaneSidebarToggle open={sb.open} onToggle={sb.toggle} icon={SlidersHorizontal} title="Params" testId="toggle" />
      {sb.open && (
        <PaneSidebar width={sb.width} onWidthChange={sb.setWidth}>
          <div data-testid="content" />
        </PaneSidebar>
      )}
    </div>
  );
}

beforeEach(() => localStorage.clear());

describe('usePaneSidebar', () => {
  it('defaults closed at 240 and persists {open, width} JSON on toggle', () => {
    render(<Harness />);
    const toggle = screen.getByTestId('toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('content')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId('content')).toBeTruthy();
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('240px');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ open: true, width: 240 });
  });

  it('migrates legacy "1"/"0" open flags', () => {
    localStorage.setItem(KEY, '1');
    render(<Harness />);
    expect(screen.getByTestId('toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('240px');
  });

  it('restores persisted JSON, clamping width to 200–420', () => {
    localStorage.setItem(KEY, JSON.stringify({ open: true, width: 9999 }));
    render(<Harness />);
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('420px');
  });

  it('falls back to defaults on malformed values', () => {
    localStorage.setItem(KEY, '{nope');
    render(<Harness />);
    expect(screen.getByTestId('toggle').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('PaneSidebar resize handle', () => {
  beforeEach(() => localStorage.setItem(KEY, JSON.stringify({ open: true, width: 240 })));

  it('pointer drag left widens, clamped at 420, and persists', () => {
    render(<Harness />);
    const handle = screen.getByTestId('sidebar-resize');
    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 220, pointerId: 1 }); // 80px left → wider
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('320px');
    fireEvent.pointerMove(handle, { clientX: -9999, pointerId: 1 });
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('420px');
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 }); // drag ended → ignored
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('420px');
    expect(JSON.parse(localStorage.getItem(KEY)!).width).toBe(420);
  });

  it('arrow keys resize by 16px within clamps', () => {
    render(<Harness />);
    const handle = screen.getByTestId('sidebar-resize');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('256px');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(screen.getByTestId('pane-sidebar').style.width).toBe('224px');
  });

  it('is an accessible vertical separator', () => {
    render(<Harness />);
    const handle = screen.getByTestId('sidebar-resize');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('tabindex')).toBe('0');
  });
});
