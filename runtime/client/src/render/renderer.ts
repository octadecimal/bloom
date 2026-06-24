import type { JsonValue, NodeType } from '../model/document';

export type ITextureHandle = unknown;

export interface IRenderer {
  mount(rootId: string, opts: { width: number; height: number }): void | Promise<void>;
  createObject(id: string, type: NodeType): void;
  destroyObject(id: string): void;
  setParent(childId: string, parentId: string | null): void;
  setProp(id: string, path: string, value: JsonValue): void;
  loadTexture(src: string): Promise<ITextureHandle>;
  assignTexture(spriteId: string, texture: ITextureHandle | null): void;
}
