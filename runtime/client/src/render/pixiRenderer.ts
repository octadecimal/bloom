import { Application, Assets, BlurFilter, Container, Sprite, Texture, type Filter, type Ticker } from 'pixi.js';
import type { JsonValue, NodeType } from '../model/document';
import type { IDisplayHandle, IRenderer, ITextureHandle } from './renderer';
import type { IViewport } from './viewport';

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
  private pendingTicks: Array<(ticker: Ticker) => void> = [];

  constructor(
    private readonly host: HTMLElement,
    private readonly resolveSrc: SrcResolver = (s) => s,
  ) {}

  async mount(rootId: string): Promise<void> {
    const app = new Application();
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    await app.init({
      width,
      height,
      background: '#0b0b0c',
      antialias: true,
      resolution: Math.min(globalThis.devicePixelRatio ?? 1, 2),
      autoDensity: true,
    });
    this.host.appendChild(app.canvas);
    app.stage.sortableChildren = true;
    this.app = app;
    this.flushPendingTicks();
    this.rootId = rootId;
    this.objects.set(rootId, app.stage as unknown as Container);
  }

  applyViewport(vp: IViewport): void {
    const app = this.app;
    if (!app || this.rootId === null) return;
    app.renderer.resize(vp.canvas.width, vp.canvas.height);
    const root = this.objects.get(this.rootId);
    if (!root) return;
    root.scale.set(vp.scale);
    root.position.set(vp.offset.x, vp.offset.y);
  }

  createObject(id: string, type: NodeType): void {
    if (type === 'Sprite') {
      const s = new Sprite();
      s.anchor.set(0.5); // position denotes the sprite's center by default
      this.objects.set(id, s);
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

  anchorOf(id: string): { x: number; y: number } | null {
    const obj = this.objects.get(id);
    return obj instanceof Sprite ? { x: obj.anchor.x, y: obj.anchor.y } : null;
  }

  onStage(id: string): boolean {
    const stage = this.app?.stage as unknown as Container | undefined;
    let cur = this.objects.get(id) as Container | null | undefined;
    if (!stage || !cur) return false;
    while (cur) {
      if ((cur as unknown) === (stage as unknown)) return true;
      cur = cur.parent as Container | null;
    }
    return false;
  }

  getHandle(id: string): IDisplayHandle | null {
    const obj = this.objects.get(id);
    if (!obj) return null;
    return {
      position: obj.position,
      scale: obj.scale,
      get alpha() {
        return obj.alpha;
      },
      set alpha(v: number) {
        obj.alpha = v;
      },
      get visible() {
        return obj.visible;
      },
      set visible(v: boolean) {
        obj.visible = v;
      },
      setBlur(strength: number) {
        const current = asFilterArray(obj.filters);
        const existing = current.find((f): f is BlurFilter => f instanceof BlurFilter);
        if (strength <= 0) {
          obj.filters = current.filter((f) => !(f instanceof BlurFilter));
          return;
        }
        if (existing) {
          existing.strength = strength;
          obj.filters = current;
        } else {
          obj.filters = [...current, new BlurFilter({ strength })];
        }
      },
    };
  }

  async capture(): Promise<string> {
    const app = this.app;
    if (!app) return '';
    // Render-settled barrier (spec §2): the protocol acks a change after the
    // reconciler mutates the scene graph but BEFORE Pixi paints it. Wait one
    // animation frame so the just-applied ops (texture uploads, new bounds) are
    // drawn, then extract — otherwise the critic would grade a stale frame.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // Capture the full visible canvas as the user sees it (framing + negative
    // space + background), not just the content bounding box — composition
    // critique needs the framed scene, and a sparse/early scene must still
    // yield a full frame rather than a near-empty crop.
    return app.renderer.extract.base64({
      target: app.stage,
      frame: app.renderer.screen,
      clearColor: '#0b0b0c',
    });
  }

  onTick(cb: (dtMs: number) => void): () => void {
    const fn = (ticker: Ticker) => cb(ticker.deltaMS);
    if (this.app) {
      this.app.ticker.add(fn);
    } else {
      this.pendingTicks.push(fn); // not mounted yet — flushed in mount()
    }
    return () => {
      const i = this.pendingTicks.indexOf(fn);
      if (i >= 0) this.pendingTicks.splice(i, 1);
      this.app?.ticker.remove(fn);
    };
  }

  private flushPendingTicks(): void {
    const app = this.app;
    if (!app) return;
    for (const fn of this.pendingTicks) app.ticker.add(fn);
    this.pendingTicks = [];
  }
}

function asFilterArray(filters: Filter | readonly Filter[] | null | undefined): Filter[] {
  if (filters == null) return [];
  if (Array.isArray(filters)) return [...filters];
  return [filters as Filter];
}
