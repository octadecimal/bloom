import type { IDockviewPanelProps } from 'dockview-react';
import { ChevronDown, ChevronRight, Box, Image, Layers, type LucideIcon } from 'lucide-react';
import { gameHooks, type IGameDocument, type NodeType } from '../game/state';
import { sceneGraphHooks } from './state';
import { buildTree, type ITreeRow } from './buildTree';
import { bumpRenderCount } from '../../app/renderCount';

const ICON: Record<NodeType, LucideIcon> = {
  Root: Layers,
  Container: Layers,
  Sprite: Box,
  Texture: Image,
};

export function SceneGraphPane(_props: IDockviewPanelProps) {
  const game = gameHooks.usePluginState();
  const sg = sceneGraphHooks.usePluginState();
  bumpRenderCount('SceneGraphPane');

  const doc = game.document.get({ noproxy: true }) as IGameDocument;
  const collapsed = sg.collapsed.get({ noproxy: true }) as Record<string, boolean>;
  const selectedId = sg.selectedId.get();
  const rows = buildTree(doc, collapsed);

  if (rows.length === 0) {
    return (
      <div data-testid="scene-graph-empty" className="flex h-full items-center justify-center bg-surface text-muted-foreground">
        No scene loaded.
      </div>
    );
  }

  const select = (id: string) => sg.selectedId.set(id);
  const toggle = (id: string) => sg.collapsed.set((c) => ({ ...c, [id]: !c[id] }));

  return (
    <div data-testid="scene-graph-pane" className="h-full overflow-auto bg-surface py-1 text-sm">
      {rows.map((row) => (
        <Row key={row.id} row={row} selected={row.id === selectedId} collapsed={collapsed[row.id] === true} onSelect={select} onToggle={toggle} />
      ))}
    </div>
  );
}

function Row(props: { row: ITreeRow; selected: boolean; collapsed: boolean; onSelect: (id: string) => void; onToggle: (id: string) => void }) {
  const { row, selected, collapsed, onSelect, onToggle } = props;
  // Fallback guards against a node arriving (mid-stream) with a type outside the
  // closed NodeType union; the icon map is exhaustive for known types.
  const Icon = ICON[row.type] ?? Box;
  return (
    <div
      data-testid={`scene-row-${row.id}`}
      data-selected={selected ? 'true' : undefined}
      role="treeitem"
      aria-selected={selected}
      onClick={() => onSelect(row.id)}
      className={`flex cursor-pointer items-center gap-1 py-0.5 pr-2 ${
        selected ? 'bg-selection text-selection-text' : 'text-foreground hover:bg-raised-hover'
      }`}
      style={{ paddingLeft: `${8 + row.depth * 14}px` }}
    >
      {row.hasChildren ? (
        <button
          data-testid={`scene-toggle-${row.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row.id);
          }}
          className="flex h-4 w-4 items-center justify-center"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      ) : (
        <span className="inline-block h-4 w-4" />
      )}
      <Icon size={13} className="shrink-0 text-muted-foreground" />
      <span className="truncate">{row.name ?? row.id}</span>
    </div>
  );
}
