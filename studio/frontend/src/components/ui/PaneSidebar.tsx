import { useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;
const KEY_STEP = 16;

const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

interface ISidebarPrefs {
  open: boolean;
  width: number;
}

function loadPrefs(storageKey: string, defaultWidth: number): ISidebarPrefs {
  const raw = localStorage.getItem(storageKey);
  // Legacy format from the pre-resize sidebar hook: bare '1' / '0'.
  if (raw === '1' || raw === '0') return { open: raw === '1', width: defaultWidth };
  try {
    const p = JSON.parse(raw ?? '') as Partial<ISidebarPrefs> | null;
    if (p && typeof p.open === 'boolean' && typeof p.width === 'number') {
      return { open: p.open, width: clampWidth(p.width) };
    }
  } catch {
    /* malformed → defaults */
  }
  return { open: false, width: defaultWidth };
}

export interface IPaneSidebarState {
  open: boolean;
  width: number;
  toggle: () => void;
  setWidth: (w: number) => void;
}

/** Per-pane sidebar preference (UI preference, not game data): visibility +
 * width, persisted as {open, width} JSON under the caller's storage key. */
export function usePaneSidebar(storageKey: string, opts?: { defaultWidth?: number }): IPaneSidebarState {
  const defaultWidth = clampWidth(opts?.defaultWidth ?? DEFAULT_WIDTH);
  const [prefs, setPrefs] = useState(() => loadPrefs(storageKey, defaultWidth));
  const update = (fn: (p: ISidebarPrefs) => ISidebarPrefs) =>
    setPrefs((p) => {
      const next = fn(p);
      localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  return {
    open: prefs.open,
    width: prefs.width,
    toggle: () => update((p) => ({ ...p, open: !p.open })),
    setWidth: (w: number) => update((p) => ({ ...p, width: clampWidth(w) })),
  };
}

export interface IPaneSidebarProps {
  width: number;
  onWidthChange: (w: number) => void;
  children: ReactNode;
}

/** Resizable right-hand sidebar column: hairline left border with a drag
 * handle (pointer + arrow keys) straddling it. Clamping lives in the hook's
 * setWidth so there is exactly one clamp. */
export function PaneSidebar({ width, onWidthChange, children }: IPaneSidebarProps) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  return (
    <div data-testid="pane-sidebar" className="relative flex-none border-l border-hairline" style={{ width }}>
      <div
        data-testid="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        onPointerDown={(e) => {
          drag.current = { startX: e.clientX, startW: width };
          // Optional-chained: jsdom has no pointer-capture implementation.
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) onWidthChange(drag.current.startW + drag.current.startX - e.clientX);
        }}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') (e.preventDefault(), onWidthChange(width + KEY_STEP));
          if (e.key === 'ArrowRight') (e.preventDefault(), onWidthChange(width - KEY_STEP));
        }}
        className="absolute -left-1 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-hairline-strong focus-visible:bg-hairline-strong focus-visible:outline-none"
      />
      <div className="h-full overflow-y-auto">{children}</div>
    </div>
  );
}

export interface IPaneSidebarToggleProps {
  open: boolean;
  onToggle: () => void;
  icon: ComponentType<{ className?: string }>;
  title: string;
  testId: string;
}

/** Ghost icon button that opens/closes a pane sidebar (accent text when open). */
export function PaneSidebarToggle({ open, onToggle, icon: Icon, title, testId }: IPaneSidebarToggleProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={open}
      title={title}
      onClick={onToggle}
      className={`rounded p-1 hover:bg-raised-hover ${open ? 'text-accent-text' : 'text-text-2'}`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
