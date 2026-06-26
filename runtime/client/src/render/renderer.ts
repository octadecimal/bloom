import type { JsonValue, NodeType } from '../model/document';
import type { IViewport } from './viewport';

export type ITextureHandle = unknown;

/** Narrow live-object seam for the module behavior plane (spec §2.3).
 *  Modules mutate these per frame; they never import Pixi. */
export interface IDisplayHandle {
  position: { x: number; y: number };
  scale: { x: number; y: number };
  alpha: number;
  visible: boolean;
  /** strength <= 0 clears blur. */
  setBlur(strength: number): void;
}

export interface IRenderer {
  mount(rootId: string): void | Promise<void>;
  /** Resize the canvas to the viewport and apply scale/offset to the root container. */
  applyViewport(vp: IViewport): void;
  createObject(id: string, type: NodeType): void;
  destroyObject(id: string): void;
  setParent(childId: string, parentId: string | null): void;
  setProp(id: string, path: string, value: JsonValue): void;
  loadTexture(src: string): Promise<ITextureHandle>;
  assignTexture(spriteId: string, texture: ITextureHandle | null): void;
  /** Live display handle for a node id, or null if absent. */
  getHandle(id: string): IDisplayHandle | null;
  /** Per-frame tick; returns an unsubscribe thunk. dtMs since last frame. */
  onTick(cb: (dtMs: number) => void): () => void;
}
