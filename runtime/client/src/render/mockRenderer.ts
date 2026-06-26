import type { JsonValue, NodeType } from '../model/document';
import type { IDisplayHandle, IRenderer, ITextureHandle } from './renderer';

export class MockRenderer implements IRenderer {
  calls: Array<[string, ...unknown[]]> = [];
  private handles = new Map<string, IDisplayHandle>();
  tickCbs: Array<(dtMs: number) => void> = [];

  mount(rootId: string, opts: { width: number; height: number }): void {
    this.calls.push(['mount', rootId, opts]);
  }
  createObject(id: string, type: NodeType): void {
    this.calls.push(['createObject', id, type]);
  }
  destroyObject(id: string): void {
    this.calls.push(['destroyObject', id]);
  }
  setParent(childId: string, parentId: string | null): void {
    this.calls.push(['setParent', childId, parentId]);
  }
  setProp(id: string, path: string, value: JsonValue): void {
    this.calls.push(['setProp', id, path, value]);
  }
  async loadTexture(src: string): Promise<ITextureHandle> {
    this.calls.push(['loadTexture', src]);
    return { src };
  }
  assignTexture(spriteId: string, texture: ITextureHandle | null): void {
    this.calls.push(['assignTexture', spriteId, texture]);
  }

  getHandle(id: string): IDisplayHandle | null {
    if (!this.handles.has(id)) {
      this.handles.set(id, { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, alpha: 1, visible: true, setBlur: () => {} });
    }
    return this.handles.get(id) ?? null;
  }

  onTick(cb: (dtMs: number) => void): () => void {
    this.tickCbs.push(cb);
    return () => {
      this.tickCbs = this.tickCbs.filter((f) => f !== cb);
    };
  }
}
