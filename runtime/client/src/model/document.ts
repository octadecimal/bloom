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
