import { NODE_TYPES, type IEdge, type IGameDocument, type INode } from './document';
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
      default:
        throw new OpError('unknown_op', `unknown op kind: ${(op as { kind: string }).kind}`);
    }
  }

  getNode(id: string): INode | undefined {
    return this.nodes.get(id);
  }

  toDocument(): IGameDocument {
    const nodes: Record<string, INode> = {};
    for (const [id, n] of this.nodes) nodes[id] = { id: n.id, type: n.type, props: { ...n.props } };
    return { version: 1, nodes, edges: [...this.edges.values()].map((e) => ({ ...e })) };
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
    this.nodes.delete(id);
    return [{ kind: 'nodeRemoved', id }];
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
