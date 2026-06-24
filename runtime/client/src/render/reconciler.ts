import type { GraphModel } from '../model/graphModel';
import type { IChange } from '../model/changes';
import type { INode, JsonValue } from '../model/document';
import type { IRenderer } from './renderer';

export class Reconciler {
  constructor(
    private readonly renderer: IRenderer,
    private readonly model: GraphModel,
  ) {}

  async applyChanges(changes: IChange[]): Promise<void> {
    for (const change of changes) await this.applyOne(change);
  }

  private async applyOne(change: IChange): Promise<void> {
    switch (change.kind) {
      case 'nodeCreated':
        return this.created(change.node);
      case 'nodeRemoved':
        this.renderer.destroyObject(change.id);
        return;
      case 'parentSet':
        this.renderer.setParent(change.childId, change.parentId);
        return;
      // 'propSet' / 'dataBound' / 'dataUnbound' handled in Tasks 9–10
      default:
        return;
    }
  }

  private async created(node: INode): Promise<void> {
    if (node.type === 'Texture') return; // data-only node, no display object
    if (node.type === 'Root') {
      const width = numProp(node.props.width, 800);
      const height = numProp(node.props.height, 600);
      await this.renderer.mount(node.id, { width, height });
    } else {
      this.renderer.createObject(node.id, node.type);
    }
  }
}

function numProp(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}
