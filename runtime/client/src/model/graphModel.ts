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
}
