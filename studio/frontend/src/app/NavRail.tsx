import { useEffect, useRef, useState, type ComponentType } from 'react';
import {
  MessageSquare,
  FileText,
  Gamepad2,
  SlidersHorizontal,
  Images,
  ListTree,
  LayoutTemplate,
  Settings2,
  Network,
  Sigma,
  Settings,
  SquarePen,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { getHost } from '../state/hostRef';
import { getDockviewApi, onDockviewApiChange } from '../state/dockviewApiRef';
import type { IPaneDef } from '../host/types';

// Central curation (spec approach A): icons + journey grouping live here, not on
// IPaneDef. Panes missing from the map still render (letter fallback, trailing
// group) — the rail never hides a registered pane.
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  'llm-chat/room': MessageSquare,
  'gdd/viewer': FileText,
  'game/preview': Gamepad2,
  'property-inspector/panel': SlidersHorizontal,
  'assets/board': Images,
  'scene-graph/tree': ListTree,
  'region-overrides/preview': LayoutTemplate,
  'game-config/editor': Settings2,
  'game-structure/editor': Network,
  'math/viewer': Sigma,
  'llm-chat/settings': Settings,
  'llm-chat/skill-editor': SquarePen,
};

const GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: 'Design', ids: ['llm-chat/room', 'gdd/viewer'] },
  {
    label: 'Art',
    ids: ['game/preview', 'property-inspector/panel', 'assets/board', 'scene-graph/tree', 'region-overrides/preview'],
  },
  { label: 'Math', ids: ['game-config/editor', 'game-structure/editor', 'math/viewer'] },
];
const UTILITY_IDS = ['llm-chat/settings', 'llm-chat/skill-editor'];
const EXPAND_KEY = 'bloom.navRailExpanded';
const HOVER_DELAY_MS = 150; // hover intent: skating across the rail must not flash the flyout

// Re-render on Dockview layout/active-panel changes so open/active state stays
// honest. Before the api attaches, everything renders in the closed tier.
function useDockviewVersion(): void {
  const [, setVersion] = useState(0);
  useEffect(() => {
    let disposers: Array<{ dispose(): void }> = [];
    const bump = () => setVersion((v) => v + 1);
    const attach = () => {
      disposers.forEach((d) => d.dispose());
      disposers = [];
      const api = getDockviewApi();
      if (!api) return;
      disposers = [api.onDidLayoutChange(bump), api.onDidActivePanelChange(bump)];
      bump();
    };
    attach();
    const off = onDockviewApiChange(attach);
    return () => {
      off();
      disposers.forEach((d) => d.dispose());
    };
  }, []);
}

function RailButton({ pane, expanded }: { pane: IPaneDef; expanded: boolean }) {
  const host = getHost();
  const api = getDockviewApi();
  const open = !!api?.getPanel(pane.id);
  const active = api?.activePanel?.id === pane.id;
  const Icon = ICONS[pane.id];
  const tier = active ? 'bg-selection text-foreground' : open ? 'text-foreground' : 'text-muted-foreground';
  return (
    <button
      type="button"
      data-testid={`rail-open-${pane.id}`}
      title={expanded ? undefined : pane.title}
      aria-label={pane.title}
      onClick={() => host.openPane(pane.id)}
      className={`flex h-8 items-center rounded-md transition-colors hover:bg-raised-hover hover:text-foreground ${expanded ? 'w-full' : 'w-8 justify-center'} ${tier}`}
    >
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center">
        {Icon ? <Icon aria-hidden className="h-4 w-4" /> : <span className="text-xs">{pane.title.charAt(0).toUpperCase()}</span>}
      </span>
      {expanded && <span className="whitespace-nowrap text-xs">{pane.title}</span>}
    </button>
  );
}

export function NavRail() {
  const host = getHost();
  useDockviewVersion();
  const panes = new Map(host.listPanes().map((p) => [p.id, p]));
  const curated = new Set([...GROUPS.flatMap((g) => g.ids), ...UTILITY_IDS]);
  const groups = GROUPS.map((g) => ({
    label: g.label,
    panes: g.ids.filter((id) => panes.has(id)).map((id) => panes.get(id)!),
  })).filter((g) => g.panes.length > 0);
  const rest = [...panes.values()].filter((p) => !curated.has(p.id));
  if (rest.length > 0) groups.push({ label: '', panes: rest });
  const utility = UTILITY_IDS.filter((id) => panes.has(id)).map((id) => panes.get(id)!);
  const [pinned, setPinned] = useState(() => localStorage.getItem(EXPAND_KEY) === '1');
  const [hovered, setHovered] = useState(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const expanded = pinned || hovered;
  const toggle = () => {
    const next = !pinned;
    if (next) localStorage.setItem(EXPAND_KEY, '1');
    else localStorage.removeItem(EXPAND_KEY);
    setPinned(next);
  };
  const hoverEnter = () => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered(true), HOVER_DELAY_MS);
  };
  const hoverLeave = () => {
    window.clearTimeout(hoverTimer.current);
    setHovered(false);
  };
  return (
    // Fixed w-10 layout slot: the rail expands as an overlay above the dock so
    // the Dockview container never resizes (no right-edge reflow).
    <div data-testid="nav-rail-slot" className="relative w-10 flex-shrink-0">
      <nav
        data-testid="nav-rail"
        onMouseEnter={hoverEnter}
        onMouseLeave={hoverLeave}
        onFocus={() => {
          window.clearTimeout(hoverTimer.current);
          setHovered(true);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hoverLeave();
        }}
        className={`absolute inset-y-0 left-0 z-40 flex flex-col items-center gap-1 overflow-hidden border-r border-border bg-canvas py-2 transition-[width] duration-150 ${expanded ? 'w-44 shadow-md' : 'w-10'}`}
      >
        {groups.map((group, gi) => (
          <div
            key={gi}
            className={`flex flex-col gap-1 ${expanded ? 'w-full px-1' : 'w-8 items-center'} ${
              gi > 0 && !group.label ? 'mt-1 border-t border-border pt-2' : ''
            }`}
          >
            {group.label && (
              <div
                aria-hidden={!expanded}
                className={`h-6 whitespace-nowrap px-2 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground ${expanded ? '' : 'opacity-0'}`}
              >
                {group.label}
              </div>
            )}
            {group.panes.map((p) => (
              <RailButton key={p.id} pane={p} expanded={expanded} />
            ))}
          </div>
        ))}
        <div className="flex-1" />
        <div className={`flex flex-col gap-1 ${expanded ? 'w-full px-1' : 'w-8 items-center'}`}>
          {utility.map((p) => (
            <RailButton key={p.id} pane={p} expanded={expanded} />
          ))}
        </div>
        <div className={`mt-1 flex w-full flex-col border-t border-border pt-2 ${expanded ? 'px-1' : 'items-center'}`}>
          <button
            type="button"
            data-testid="rail-toggle"
            aria-expanded={expanded}
            title={expanded ? 'Collapse navigation' : 'Expand navigation'}
            aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
            onClick={toggle}
            className={`flex h-8 items-center rounded-md text-muted-foreground transition-colors hover:bg-raised-hover hover:text-foreground ${expanded ? 'w-full' : 'w-8 justify-center'}`}
          >
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center">
              {/* Both icons stay mounted (CSS-swapped): unmounting the mousedown target
                  mid-click (focus-expand fires between down and up) makes Chromium
                  suppress the click event entirely — the toggle would never register. */}
              <PanelLeftClose aria-hidden className={`h-4 w-4 ${expanded ? '' : 'hidden'}`} />
              <PanelLeftOpen aria-hidden className={`h-4 w-4 ${expanded ? 'hidden' : ''}`} />
            </span>
            {expanded && <span className="whitespace-nowrap text-xs">Collapse</span>}
          </button>
        </div>
      </nav>
    </div>
  );
}
