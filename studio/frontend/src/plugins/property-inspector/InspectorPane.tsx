import type { IDockviewPanelProps } from 'dockview-react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { gameHooks, type IGameDocument } from '../game/state';
import { sceneGraphHooks } from '../scene-graph/state';
import { propertyInspectorHooks } from './state';
import { inspectSelection, type IPropRow } from './inspect';
import { bumpRenderCount } from '../../app/renderCount';

export function InspectorPane(_props: IDockviewPanelProps) {
  const game = gameHooks.usePluginState();
  const sg = sceneGraphHooks.usePluginState();
  const pi = propertyInspectorHooks.usePluginState();
  bumpRenderCount('InspectorPane');

  const doc = game.document.get({ noproxy: true }) as IGameDocument;
  const selectedId = sg.selectedId.get();
  const collapsed = pi.collapsed.get({ noproxy: true }) as Record<string, boolean>;
  const view = inspectSelection(doc, selectedId, collapsed);

  if (!view) {
    return (
      <div data-testid="inspector-empty" className="flex h-full items-center justify-center bg-surface text-muted-foreground">
        No node selected.
      </div>
    );
  }

  const toggle = (path: string) => pi.collapsed.set((c) => ({ ...c, [path]: !c[path] }));

  return (
    <div data-testid="inspector-pane" className="h-full overflow-auto bg-surface text-sm">
      <div className="flex items-center gap-4 border-b border-hairline px-3 py-2">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Type</span>
          <span data-testid="inspector-type" className="text-foreground">
            {view.type}
          </span>
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Id</span>
          <span data-testid="inspector-id" className="truncate text-foreground">
            {view.id}
          </span>
        </div>
      </div>
      <div className="py-1">
        {view.rows.map((row) => (
          <PropRow key={row.path} row={row} collapsed={collapsed[row.path] === true} onToggle={toggle} />
        ))}
      </div>
    </div>
  );
}

function PropRow(props: { row: IPropRow; collapsed: boolean; onToggle: (path: string) => void }) {
  const { row, collapsed, onToggle } = props;
  const summary = row.kind === 'array' ? `[${row.count ?? 0}]` : `{${row.count ?? 0}}`;
  return (
    <div
      data-testid={`inspector-prop-${row.path}`}
      className="flex items-center gap-1 py-0.5 pr-2 text-foreground"
      style={{ paddingLeft: `${8 + row.depth * 14}px` }}
    >
      {row.hasChildren && row.count ? (
        <button
          data-testid={`inspector-toggle-${row.path}`}
          onClick={() => onToggle(row.path)}
          className="flex h-4 w-4 items-center justify-center"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      ) : (
        <span className="inline-block h-4 w-4" />
      )}
      <span className="text-muted-foreground">{row.key}</span>
      {row.hasChildren && row.count ? <span className="text-faint">{summary}</span> : <span className="truncate">{row.display}</span>}
    </div>
  );
}
