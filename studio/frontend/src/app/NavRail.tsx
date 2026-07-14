import { useEffect, useState, type ComponentType } from 'react';
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

const GROUP_ORDER: string[][] = [
  ['llm-chat/room', 'gdd/viewer'], // design
  ['game/preview', 'property-inspector/panel', 'assets/board', 'scene-graph/tree', 'region-overrides/preview'], // art
  ['game-config/editor', 'game-structure/editor', 'math/viewer'], // math
];
const UTILITY_IDS = ['llm-chat/settings', 'llm-chat/skill-editor'];
const EXPAND_KEY = 'bloom.navRailExpanded';

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

function RailButton({ pane }: { pane: IPaneDef }) {
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
      title={pane.title}
      aria-label={pane.title}
      onClick={() => host.openPane(pane.id)}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-raised-hover hover:text-foreground ${tier}`}
    >
      {Icon ? <Icon aria-hidden className="h-4 w-4" /> : <span className="text-xs">{pane.title.charAt(0).toUpperCase()}</span>}
    </button>
  );
}

export function NavRail() {
  const host = getHost();
  useDockviewVersion();
  const panes = new Map(host.listPanes().map((p) => [p.id, p]));
  const curated = new Set([...GROUP_ORDER.flat(), ...UTILITY_IDS]);
  const groups = GROUP_ORDER.map((ids) => ids.filter((id) => panes.has(id)).map((id) => panes.get(id)!)).filter((g) => g.length > 0);
  const rest = [...panes.values()].filter((p) => !curated.has(p.id));
  if (rest.length > 0) groups.push(rest);
  const utility = UTILITY_IDS.filter((id) => panes.has(id)).map((id) => panes.get(id)!);
  const [expanded, setExpanded] = useState(() => localStorage.getItem(EXPAND_KEY) === '1');
  const toggle = () => {
    const next = !expanded;
    if (next) localStorage.setItem(EXPAND_KEY, '1');
    else localStorage.removeItem(EXPAND_KEY);
    setExpanded(next);
  };
  return (
    <nav
      data-testid="nav-rail"
      className={`flex flex-shrink-0 flex-col items-center gap-1 overflow-hidden border-r border-border bg-canvas py-2 transition-[width] duration-150 ${expanded ? 'w-44' : 'w-10'}`}
    >
      {groups.map((group, gi) => (
        <div key={gi} className={`flex w-8 flex-col items-center gap-1 ${gi > 0 ? 'mt-1 border-t border-border pt-2' : ''}`}>
          {group.map((p) => (
            <RailButton key={p.id} pane={p} />
          ))}
        </div>
      ))}
      <div className="flex-1" />
      <div className="flex w-8 flex-col items-center gap-1">
        {utility.map((p) => (
          <RailButton key={p.id} pane={p} />
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
            {expanded ? <PanelLeftClose aria-hidden className="h-4 w-4" /> : <PanelLeftOpen aria-hidden className="h-4 w-4" />}
          </span>
          {expanded && <span className="whitespace-nowrap text-xs">Collapse</span>}
        </button>
      </div>
    </nav>
  );
}
