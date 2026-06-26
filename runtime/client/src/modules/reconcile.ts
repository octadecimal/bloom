import type { IGameDocument, JsonValue, NodeType } from '../model/document';
import type { Op } from '../model/ops';

export interface IDesiredNode {
  id: string;
  type: NodeType;
  props: Record<string, JsonValue>;
  /** Parent node id for the child edge, or null for no parenting. */
  parent: string | null;
}

export interface IDesiredScene {
  nodes: IDesiredNode[];
}

/** Minimal op set so applying it makes `current` match `desired` for ids `owns()` accepts.
 *  Adds (+ child connect) first, then prop updates, then removes — so a within-batch
 *  transient (e.g. an orphan) is harmless and the batch stays atomic. */
export function reconcileOps(current: IGameDocument, desired: IDesiredScene, owns: (id: string) => boolean): Op[] {
  const adds: Op[] = [];
  const updates: Op[] = [];
  const removes: Op[] = [];
  const desiredIds = new Set(desired.nodes.map((n) => n.id));

  for (const node of desired.nodes) {
    const existing = current.nodes[node.id];
    if (!existing) {
      adds.push({ kind: 'addNode', id: node.id, type: node.type, props: { ...node.props } });
      if (node.parent !== null) {
        adds.push({
          kind: 'connect',
          edgeId: `child:${node.id}`,
          type: 'child',
          from: { node: node.parent, port: 'children' },
          to: { node: node.id, port: 'parent' },
        });
      }
    } else {
      for (const [key, value] of Object.entries(node.props)) {
        if (!deepEqual(existing.props[key], value)) updates.push({ kind: 'setProp', id: node.id, path: key, value });
      }
    }
  }

  for (const node of Object.values(current.nodes)) {
    if (owns(node.id) && !desiredIds.has(node.id)) removes.push({ kind: 'removeNode', id: node.id });
  }

  return [...adds, ...updates, ...removes];
}

function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
