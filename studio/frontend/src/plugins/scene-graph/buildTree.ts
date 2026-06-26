import type { ISceneDocument, NodeType } from '../../scene/types';

export interface ITreeRow {
  id: string;
  type: NodeType;
  depth: number;
  name?: string;
  hasChildren: boolean;
}

// Walks `child` edges out from the single Root node, producing a pre-order,
// depth-tagged row list. Pure: no React/hookstate. `collapsed[id] === true`
// hides a node's descendants (the row still reports hasChildren). Absent =>
// expanded. Data-only nodes (reachable only via `data` edges) are excluded.
export function buildTree(doc: ISceneDocument, collapsed: Record<string, boolean> = {}): ITreeRow[] {
  const root = Object.values(doc.nodes).find((n) => n.type === 'Root');
  if (!root) return [];

  // parent id -> ordered child ids, from `child` edges (from = parent, to = child).
  const childrenOf = new Map<string, string[]>();
  for (const e of doc.edges) {
    if (e.type !== 'child') continue;
    if (!doc.nodes[e.to.node]) continue; // skip dangling edges
    const list = childrenOf.get(e.from.node) ?? [];
    list.push(e.to.node);
    childrenOf.set(e.from.node, list);
  }

  const rows: ITreeRow[] = [];
  const visited = new Set<string>();
  const walk = (id: string, depth: number): void => {
    if (visited.has(id)) return; // cycle / diamond guard
    visited.add(id);
    const node = doc.nodes[id];
    if (!node) return;
    const kids = childrenOf.get(id) ?? [];
    const nameProp = node.props.name;
    rows.push({
      id,
      type: node.type,
      depth,
      name: typeof nameProp === 'string' ? nameProp : undefined,
      hasChildren: kids.length > 0,
    });
    if (collapsed[id] === true) return;
    for (const kid of kids) walk(kid, depth + 1);
  };
  walk(root.id, 0);
  return rows;
}
