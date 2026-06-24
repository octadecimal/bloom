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
      case 'dataBound': {
        if (change.edge.to.port === 'texture') await this.bindTexture(change.edge.from.node, change.edge.to.node);
        return;
      }
      case 'dataUnbound': {
        if (change.edge.to.port === 'texture') this.renderer.assignTexture(change.edge.to.node, null);
        return;
      }
      case 'propSet': {
        const node = this.model.getNode(change.id);
        if (node && node.type === 'Texture') {
          if (change.path === 'src') {
            for (const e of this.model.edgesBySource(change.id, 'data')) {
              if (e.to.port === 'texture') await this.bindTexture(change.id, e.to.node);
            }
          }
          return;
        }
        this.renderer.setProp(change.id, change.path, change.value);
        return;
      }
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
      for (const [key, value] of Object.entries(node.props)) this.renderer.setProp(node.id, key, value);
    }
  }

  private async bindTexture(textureNodeId: string, spriteId: string): Promise<void> {
    const tex = this.model.getNode(textureNodeId);
    const src = tex && typeof tex.props.src === 'string' ? tex.props.src : null;
    const handle = src ? await this.renderer.loadTexture(src) : null;
    this.renderer.assignTexture(spriteId, handle);
  }
}

function numProp(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}
