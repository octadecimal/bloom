export type NodeType = 'Root' | 'Container' | 'Sprite' | 'Texture';
export type EdgeType = 'child' | 'data';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface IPortRef {
  node: string;
  port: string;
}

export interface INode {
  id: string;
  type: NodeType;
  props: Record<string, JsonValue>;
}

export interface IEdge {
  id: string;
  type: EdgeType;
  from: IPortRef;
  to: IPortRef;
}

export interface IGameDocument {
  version: number;
  nodes: Record<string, INode>;
  edges: IEdge[];
}

export function emptyDocument(): IGameDocument {
  return { version: 1, nodes: {}, edges: [] };
}

export const NODE_TYPES: readonly NodeType[] = ['Root', 'Container', 'Sprite', 'Texture'];
export const EDGE_TYPES: readonly EdgeType[] = ['child', 'data'];

/** Sprite/Container ids with no `child`-path to a Root. Textures never count
 *  (data-only nodes, no display object). */
export function unreachableNodes(doc: IGameDocument): string[] {
  const reached = new Set<string>();
  const frontier: string[] = [];
  for (const n of Object.values(doc.nodes)) if (n.type === 'Root') { reached.add(n.id); frontier.push(n.id); }
  while (frontier.length) {
    const parent = frontier.pop()!;
    for (const e of doc.edges) {
      if (e.type === 'child' && e.from.node === parent && !reached.has(e.to.node)) {
        reached.add(e.to.node);
        frontier.push(e.to.node);
      }
    }
  }
  return Object.values(doc.nodes)
    .filter((n) => (n.type === 'Sprite' || n.type === 'Container') && !reached.has(n.id))
    .map((n) => n.id)
    .sort();
}
