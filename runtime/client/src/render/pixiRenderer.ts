import { Application, Assets, Container, Sprite, Texture } from 'pixi.js';
import type { JsonValue, NodeType } from '../model/document';
import type { IRenderer, ITextureHandle } from './renderer';

type DisplayObject = Container | Sprite;
type Vec2 = { x?: number; y?: number };

export function applyPixiProp(obj: DisplayObject, path: string, value: JsonValue): void {
  switch (path) {
    case 'position':
    case 'scale':
    case 'anchor': {
      const v = (value ?? {}) as Vec2;
      const target = (obj as unknown as Record<string, { set(x: number, y: number): void }>)[path];
      const fallback = path === 'scale' ? 1 : 0;
      target.set(v.x ?? fallback, v.y ?? fallback);
      return;
    }
    case 'position.x':
      (obj as unknown as { position: Vec2 }).position.x = value as number;
      return;
    case 'position.y':
      (obj as unknown as { position: Vec2 }).position.y = value as number;
      return;
    case 'scale.x':
      (obj as unknown as { scale: Vec2 }).scale.x = value as number;
      return;
    case 'scale.y':
      (obj as unknown as { scale: Vec2 }).scale.y = value as number;
      return;
    case 'anchor.x':
      (obj as unknown as { anchor: Vec2 }).anchor.x = value as number;
      return;
    case 'anchor.y':
      (obj as unknown as { anchor: Vec2 }).anchor.y = value as number;
      return;
    case 'rotation':
      (obj as { rotation: number }).rotation = value as number;
      return;
    case 'alpha':
      (obj as { alpha: number }).alpha = value as number;
      return;
    case 'visible':
      (obj as { visible: boolean }).visible = value as boolean;
      return;
    case 'zIndex':
      (obj as { zIndex: number }).zIndex = value as number;
      return;
    default:
      return; // unknown props are ignored (forward-compatible)
  }
}

export type SrcResolver = (src: string) => string;

export class PixiRenderer implements IRenderer {
  private app: Application | null = null;
  private rootId: string | null = null;
  private objects = new Map<string, DisplayObject>();

  constructor(
    private readonly host: HTMLElement,
    private readonly resolveSrc: SrcResolver = (s) => s,
  ) {}

  async mount(rootId: string, opts: { width: number; height: number }): Promise<void> {
    const app = new Application();
    await app.init({ width: opts.width, height: opts.height, background: '#0b0b0c', antialias: true });
    this.host.appendChild(app.canvas);
    app.stage.sortableChildren = true;
    this.app = app;
    this.rootId = rootId;
    this.objects.set(rootId, app.stage as unknown as Container);
  }

  createObject(id: string, type: NodeType): void {
    if (type === 'Sprite') {
      this.objects.set(id, new Sprite());
    } else if (type === 'Container') {
      const c = new Container();
      c.sortableChildren = true;
      this.objects.set(id, c);
    }
  }

  destroyObject(id: string): void {
    const obj = this.objects.get(id);
    if (!obj || id === this.rootId) return;
    obj.removeFromParent();
    obj.destroy();
    this.objects.delete(id);
  }

  setParent(childId: string, parentId: string | null): void {
    const child = this.objects.get(childId);
    if (!child) return;
    child.removeFromParent();
    if (parentId === null) return;
    const parent = this.objects.get(parentId);
    if (parent) (parent as Container).addChild(child);
  }

  setProp(id: string, path: string, value: JsonValue): void {
    const obj = this.objects.get(id);
    if (obj) applyPixiProp(obj, path, value);
  }

  async loadTexture(src: string): Promise<ITextureHandle> {
    return Assets.load(this.resolveSrc(src));
  }

  assignTexture(spriteId: string, texture: ITextureHandle | null): void {
    const obj = this.objects.get(spriteId);
    if (obj instanceof Sprite) obj.texture = (texture as Texture) ?? Texture.EMPTY;
  }

  textureSizeOf(id: string): { width: number; height: number } | null {
    const obj = this.objects.get(id);
    if (!(obj instanceof Sprite)) return null;
    const tex = obj.texture;
    if (!tex) return null;
    return { width: tex.width, height: tex.height };
  }
}
