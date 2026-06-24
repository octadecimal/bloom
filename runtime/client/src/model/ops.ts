import type { EdgeType, IPortRef, JsonValue, NodeType } from './document';

export type Op =
  | { kind: 'addNode'; id: string; type: NodeType; props?: Record<string, JsonValue> }
  | { kind: 'removeNode'; id: string }
  | { kind: 'setProp'; id: string; path: string; value: JsonValue }
  | { kind: 'connect'; edgeId: string; type: EdgeType; from: IPortRef; to: IPortRef }
  | { kind: 'disconnect'; edgeId: string };

export class OpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpError';
  }
}
