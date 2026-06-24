import { NODE_TYPES, type IEdge, type IGameDocument, type INode, type IPortRef } from './document';
import { OpError, type Op } from './ops';
import type { IChange } from './changes';

export class GraphModel {
  private nodes = new Map<string, INode>();
  private edges = new Map<string, IEdge>();

  apply(op: Op): IChange[] {
    switch (op.kind) {
      case 'addNode':
        return this.addNode(op.id, op.type, op.props);
      case 'removeNode':
        return this.removeNode(op.id);
      case 'setProp':
        return this.setProp(op.id, op.path, op.value);
      case 'connect':
        return this.connect(op.edgeId, op.type, op.from, op.to);
      case 'disconnect':
        return this.disconnect(op.edgeId);
      default:
        throw new OpError('unknown_op', `unknown op kind: ${(op as { kind: string }).kind}`);
    }
  }

  getNode(id: string): INode | undefined {
    return this.nodes.get(id);
  }

  getEdge(id: string): IEdge | undefined {
    const e = this.edges.get(id);
    return e ? { ...e, from: { ...e.from }, to: { ...e.to } } : undefined;
  }

  edgesBySource(nodeId: string, port?: string): IEdge[] {
    return [...this.edges.values()].filter((e) => e.from.node === nodeId && (port === undefined || e.from.port === port));
  }

  edgesByTarget(nodeId: string, port?: string): IEdge[] {
    return [...this.edges.values()].filter((e) => e.to.node === nodeId && (port === undefined || e.to.port === port));
  }

  toDocument(): IGameDocument {
    const nodes: Record<string, INode> = {};
    for (const [id, n] of this.nodes) nodes[id] = { id: n.id, type: n.type, props: { ...n.props } };
    return { version: 1, nodes, edges: [...this.edges.values()].map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } })) };
  }

  private addNode(id: string, type: INode['type'], props?: INode['props']): IChange[] {
    if (this.nodes.has(id)) throw new OpError('duplicate_id', `node already exists: ${id}`);
    if (!NODE_TYPES.includes(type)) throw new OpError('bad_type', `unknown node type: ${type}`);
    const node: INode = { id, type, props: { ...(props ?? {}) } };
    this.nodes.set(id, node);
    return [{ kind: 'nodeCreated', node: { id, type, props: { ...node.props } } }];
  }

  private removeNode(id: string): IChange[] {
    if (!this.nodes.has(id)) throw new OpError('unknown_node', `no such node: ${id}`);
    const incident = [...this.edges.values()].filter((e) => e.from.node === id || e.to.node === id);
    const changes: IChange[] = [];
    for (const e of incident) {
      this.edges.delete(e.id);
      changes.push(this.edgeChange(e, false));
    }
    this.nodes.delete(id);
    changes.push({ kind: 'nodeRemoved', id });
    return changes;
  }

  private connect(edgeId: string, type: IEdge['type'], from: IPortRef, to: IPortRef): IChange[] {
    if (this.edges.has(edgeId)) throw new OpError('duplicate_edge', `edge already exists: ${edgeId}`);
    if (!this.nodes.has(from.node)) throw new OpError('unknown_node', `no such node: ${from.node}`);
    if (!this.nodes.has(to.node)) throw new OpError('unknown_node', `no such node: ${to.node}`);
    if (type === 'child') {
      const childId = to.node;
      const parentId = from.node;
      if (this.parentOf(childId) !== null) throw new OpError('already_parented', `node already has a parent: ${childId}`);
      if (childId === parentId || this.isAncestor(childId, parentId)) throw new OpError('cycle', `child edge would create a cycle`);
    }
    const edge: IEdge = { id: edgeId, type, from: { ...from }, to: { ...to } };
    this.edges.set(edgeId, edge);
    return [this.edgeChange(edge, true)];
  }

  private disconnect(edgeId: string): IChange[] {
    const edge = this.edges.get(edgeId);
    if (!edge) throw new OpError('unknown_edge', `no such edge: ${edgeId}`);
    this.edges.delete(edgeId);
    return [this.edgeChange(edge, false)];
  }

  private edgeChange(edge: IEdge, bound: boolean): IChange {
    if (edge.type === 'child') return { kind: 'parentSet', childId: edge.to.node, parentId: bound ? edge.from.node : null };
    return bound ? { kind: 'dataBound', edge: { ...edge } } : { kind: 'dataUnbound', edge: { ...edge } };
  }

  private parentOf(childId: string): string | null {
    const e = [...this.edges.values()].find((x) => x.type === 'child' && x.to.node === childId);
    return e ? e.from.node : null;
  }

  private isAncestor(maybeAncestor: string, node: string): boolean {
    let cur: string | null = node;
    while (cur !== null) {
      if (cur === maybeAncestor) return true;
      cur = this.parentOf(cur);
    }
    return false;
  }

  private setProp(id: string, path: string, value: import('./document').JsonValue): IChange[] {
    const node = this.nodes.get(id);
    if (!node) throw new OpError('unknown_node', `no such node: ${id}`);
    const keys = path.split('.');
    let cursor = node.props as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new OpError('invalid_path', `disallowed path segment: ${k}`);
      if (typeof cursor[k] !== 'object' || cursor[k] === null) cursor[k] = {};
      cursor = cursor[k] as Record<string, unknown>;
    }
    const finalKey = keys[keys.length - 1];
    if (finalKey === '__proto__' || finalKey === 'constructor' || finalKey === 'prototype')
      throw new OpError('invalid_path', `disallowed path segment: ${finalKey}`);
    cursor[finalKey] = value;
    return [{ kind: 'propSet', id, path, value }];
  }
}
