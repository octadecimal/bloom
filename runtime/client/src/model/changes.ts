import type { IEdge, INode, JsonValue } from './document';

export type IChange =
  | { kind: 'nodeCreated'; node: INode }
  | { kind: 'nodeRemoved'; id: string }
  | { kind: 'propSet'; id: string; path: string; value: JsonValue }
  | { kind: 'parentSet'; childId: string; parentId: string | null }
  | { kind: 'dataBound'; edge: IEdge }
  | { kind: 'dataUnbound'; edge: IEdge };
