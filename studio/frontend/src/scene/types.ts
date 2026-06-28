// Structural copy of the engine wire shapes (runtime/client/src/model/document.ts).
// The protocol fixes these; keep them in lockstep with the engine. Plugin-neutral
// home for the scene document domain — consumed by both the game and scene-graph
// plugins so neither depends on the other.
export type NodeType = 'Root' | 'Container' | 'Sprite' | 'Texture';
export type EdgeType = 'child' | 'data';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
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
export interface IModuleDecl {
  id: string;
  type: string;
  config?: Record<string, JsonValue>;
}
export interface ISceneDocument {
  version: number;
  nodes: Record<string, INode>;
  edges: IEdge[];
  modules?: IModuleDecl[];
}
