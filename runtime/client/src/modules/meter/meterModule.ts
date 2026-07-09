import type { JsonValue } from '../../model/document';
import type { IGameModule, IModuleHost } from '../module';
import { validateConfig, type IConfigSchema } from '../schema';
import { reconcileOps, type IDesiredNode, type IDesiredScene } from '../reconcile';
import type { Op } from '../../model/ops';
import type { ITriggerData } from '../../play/composedTypes';
import { landscapeSafeArea } from '../safeArea';

export const METER_SCHEMA: IConfigSchema = {
  target: { type: 'integer', default: 4, min: 1, max: 64 },
  parentId: { type: 'string', default: 'root', binding: 'parent' },
};

const SEG_W = 48;
const SEG_H = 20;
const SEG_GAP = 8;
const LIT = '#ffd54a';
const UNLIT = '#2a2a2a';
const STEP_MS = 150; // per-segment light-up cadence

export function barId(moduleId: string): string {
  return `${moduleId}:bar`;
}

export function segId(moduleId: string, i: number): string {
  return `${moduleId}:seg:${i}`;
}

interface IMeterConfig {
  target: number;
  parentId: string;
}

/** Pure: the desired node set — a segment bar centered near the bottom of the
 *  safe area, `fill` segments lit (placeholder art, like reels' colored cells). */
export function buildMeterDesired(moduleId: string, cfg: IMeterConfig, fill: number, safe: { width: number; height: number }): IDesiredScene {
  const span = SEG_W + SEG_GAP;
  const barWidth = cfg.target * span - SEG_GAP;
  const nodes: IDesiredNode[] = [
    {
      id: barId(moduleId),
      type: 'Container',
      props: { position: { x: safe.width / 2 - barWidth / 2, y: safe.height - SEG_H - 24 } },
      parent: cfg.parentId,
    },
  ];
  for (let i = 0; i < cfg.target; i++) {
    nodes.push({
      id: segId(moduleId, i),
      type: 'Sprite',
      props: { position: { x: i * span, y: 0 }, size: { width: SEG_W, height: SEG_H }, fill: i < fill ? LIT : UNLIT },
      parent: barId(moduleId),
    });
  }
  return { nodes };
}

/** meter@1 presentation: renders the server-served fill level — the module
 *  never counts symbols itself (the client never re-runs math). */
export class MeterModule implements IGameModule {
  readonly type = 'meter';
  readonly configSchema = METER_SCHEMA;
  private config: Record<string, JsonValue>;
  private fill = 0;
  private pending: { to: number; target: number; elapsed: number; resolve: () => void } | null = null;
  private offTick: (() => void) | null = null;

  constructor(private readonly args: { id: string; host: IModuleHost; config?: Record<string, JsonValue> }) {
    this.config = { ...(args.config ?? {}) };
  }

  get id(): string {
    return this.args.id;
  }

  private get host(): IModuleHost {
    return this.args.host;
  }

  private cfg(): IMeterConfig {
    const { ok, value, errors } = validateConfig<IMeterConfig>(METER_SCHEMA, this.config);
    if (!ok) console.warn('[meter] invalid config, using defaults for:', errors.join('; '));
    return value;
  }

  project(): void {
    const snap = this.host.snapshot();
    const desired = buildMeterDesired(this.id, this.cfg(), this.fill, landscapeSafeArea(snap));
    const owns = (nodeId: string) => nodeId.startsWith(`${this.id}:`);
    this.host.emit(reconcileOps(snap, desired, owns));
  }

  mount(): void {
    this.offTick = this.host.onTick((dt) => this.update(dt));
  }

  dispose(): void {
    this.offTick?.();
    this.offTick = null;
  }

  update(dtMs: number): void {
    const p = this.pending;
    if (!p) return;
    p.elapsed += dtMs;
    while (p.elapsed >= STEP_MS && this.fill < p.to) {
      p.elapsed -= STEP_MS;
      this.setFill(this.fill + 1);
    }
    if (this.fill >= p.to) {
      this.pending = null;
      this.host.bus.emit('meter:changed', { fill: this.fill, target: p.target });
      p.resolve();
    }
  }

  /** Composed trigger seam (TraceWalker): animate to the served fill. A lower
   *  fill (a new round started) snaps immediately — fill is server-authoritative. */
  invoke(trigger: string, data: ITriggerData): Promise<void> {
    if (trigger !== 'accumulate' || data.kind !== 'meter') {
      return Promise.reject(new Error(`meter: unsupported trigger ${trigger} (${data.kind})`));
    }
    const to = Math.min(data.fill, this.cfg().target);
    if (to <= this.fill) {
      this.setFill(to);
      this.host.bus.emit('meter:changed', { fill: this.fill, target: data.target });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.pending = { to, target: data.target, elapsed: 0, resolve };
    });
  }

  private setFill(fill: number): void {
    this.fill = fill;
    const ops: Op[] = [];
    for (let i = 0; i < this.cfg().target; i++) {
      ops.push({ kind: 'setProp', id: segId(this.id, i), path: 'fill', value: i < fill ? LIT : UNLIT });
    }
    this.host.emit(ops);
  }

  debugState(): { fill: number; target: number } {
    return { fill: this.fill, target: this.cfg().target };
  }
}
