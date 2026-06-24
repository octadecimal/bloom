import type { EdgeType, IEdge, IGameDocument, INode, IPortRef, JsonValue, NodeType } from './state';

export type ISceneOp =
  | { kind: 'addNode'; id: string; type: NodeType; props?: Record<string, JsonValue> }
  | { kind: 'removeNode'; id: string }
  | { kind: 'setProp'; id: string; path: string; value: JsonValue }
  | { kind: 'connect'; edgeId: string; type: EdgeType; from: IPortRef; to: IPortRef }
  | { kind: 'disconnect'; edgeId: string };

// Trusting structural applier: the backend has already validated. We only mirror
// the durable document so the iframe can be (re-)initialised from cache.
export function applyOpToDocument(doc: IGameDocument, op: ISceneOp): IGameDocument {
  switch (op.kind) {
    case 'addNode': {
      const node: INode = { id: op.id, type: op.type, props: { ...(op.props ?? {}) } };
      return { ...doc, nodes: { ...doc.nodes, [op.id]: node } };
    }
    case 'removeNode': {
      const nodes = { ...doc.nodes };
      delete nodes[op.id];
      const edges = doc.edges.filter((e) => e.from.node !== op.id && e.to.node !== op.id);
      return { ...doc, nodes, edges };
    }
    case 'setProp': {
      const existing = doc.nodes[op.id];
      if (!existing) return doc; // trusting: ignore unknown (backend wouldn't have sent it)
      const props = setNested(existing.props, op.path, op.value);
      return { ...doc, nodes: { ...doc.nodes, [op.id]: { ...existing, props } } };
    }
    case 'connect': {
      const edge: IEdge = { id: op.edgeId, type: op.type, from: { ...op.from }, to: { ...op.to } };
      return { ...doc, edges: [...doc.edges, edge] };
    }
    case 'disconnect': {
      return { ...doc, edges: doc.edges.filter((e) => e.id !== op.edgeId) };
    }
    default:
      return doc;
  }
}

export function loadDocument(doc: IGameDocument): IGameDocument {
  return {
    version: doc.version,
    nodes: Object.fromEntries(Object.entries(doc.nodes).map(([id, n]) => [id, { ...n, props: { ...n.props } }])),
    edges: doc.edges.map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } })),
  };
}

function setNested(props: Record<string, JsonValue>, path: string, value: JsonValue): Record<string, JsonValue> {
  const keys = path.split('.');
  const root: Record<string, JsonValue> = { ...props };
  let cursor = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cursor[k];
    const copy: Record<string, JsonValue> = typeof next === 'object' && next !== null && !Array.isArray(next) ? { ...(next as Record<string, JsonValue>) } : {};
    cursor[k] = copy;
    cursor = copy;
  }
  cursor[keys[keys.length - 1]] = value;
  return root;
}
