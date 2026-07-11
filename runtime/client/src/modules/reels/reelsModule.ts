// runtime/client/src/modules/reels/reelsModule.ts
import type { IGameDocument, JsonValue } from '../../model/document';
import type { IGameModule, IModuleHost, IOutcome } from '../module';
import { validateConfig, type IConfigSchema } from '../schema';
import { reconcileOps, type IDesiredNode, type IDesiredScene } from '../reconcile';
import type { IDisplayHandle } from '../../render/renderer';
import { advance, blurFor, finalRow, reelDelay, settleOffset, settleT, settleTarget, symbolAt, wrap } from './reelsMath';
import type { Op } from '../../model/ops';
import { colorForSymbol } from './symbolColor';
import type { ITriggerData } from '../../play/composedTypes';
import { landscapeSafeArea } from '../safeArea';

export const REELS_SCHEMA: IConfigSchema = {
  rows: { type: 'integer', default: 3, min: 1, max: 8 },
  cols: { type: 'integer', default: 5, min: 1, max: 10 },
  symbols: { type: 'stringArray', default: ['A', 'B', 'C', 'D', 'E'] },
  cellSize: { type: 'number', default: 100, min: 1 },
  spacing: { type: 'number', default: 8, min: 0 },
  originX: { type: 'number', default: 0 },
  originY: { type: 'number', default: 0 },
  parentId: { type: 'string', default: 'root', binding: 'parent' },
  buffer: { type: 'integer', default: 2, min: 0, max: 4 },
};

/** Resting row for cell index `r`: the last buffer cell parks above the grid (row -1),
 *  matching the scroll window renderReel wraps through — so settling needs no frame shift. */
export function restRow(r: number, rows: number, buffer: number): number {
  return buffer >= 1 && r === rows + buffer - 1 ? -1 : r;
}

export function containerId(moduleId: string, col: number): string {
  return `${moduleId}:reel:${col}`;
}

export function cellId(moduleId: string, col: number, row: number): string {
  return `${moduleId}:cell:${col}:${row}`;
}

/** Centered origin so the visible rows×cols block sits in the middle of the safe area.
 *  (One buffer row sits above the grid, the rest below.) span = cellSize + spacing. */
export function centeredOrigin(
  grid: { cols: number; rows: number; cellSize: number; spacing: number },
  safe: { width: number; height: number },
): { originX: number; originY: number } {
  const span = grid.cellSize + grid.spacing;
  return {
    originX: safe.width / 2 - ((grid.cols - 1) * span) / 2,
    originY: safe.height / 2 - ((grid.rows - 1) * span) / 2,
  };
}

interface IReelsConfig {
  rows: number;
  cols: number;
  symbols: string[];
  cellSize: number;
  spacing: number;
  originX: number;
  originY: number;
  parentId: string;
  buffer: number;
}

function resolveConfig(raw: Record<string, JsonValue>): IReelsConfig {
  const { ok, value, errors } = validateConfig<IReelsConfig>(REELS_SCHEMA, raw);
  if (!ok) console.warn('[reels] invalid config, using defaults for:', errors.join('; '));
  return value;
}

/** Pure: the desired node set for a given config (stable ids → idempotent reprojection). */
export function buildDesired(moduleId: string, raw: Record<string, JsonValue>): IDesiredScene {
  const cfg = resolveConfig(raw);
  const span = cfg.cellSize + cfg.spacing;
  const nodes: IDesiredNode[] = [];
  for (let c = 0; c < cfg.cols; c++) {
    nodes.push({
      id: containerId(moduleId, c),
      type: 'Container',
      props: { position: { x: cfg.originX + c * span, y: cfg.originY }, zIndex: c },
      parent: cfg.parentId,
    });
    for (let r = 0; r < cfg.rows + cfg.buffer; r++) {
      const row = restRow(r, cfg.rows, cfg.buffer);
      const sym = symbolAt(cfg.symbols, row);
      nodes.push({
        id: cellId(moduleId, c, r),
        type: 'Sprite',
        props: {
          position: { x: 0, y: row * span },
          symbol: sym,
          fill: colorForSymbol(sym),
          size: { width: cfg.cellSize, height: cfg.cellSize },
          label: sym,
        },
        parent: containerId(moduleId, c),
      });
    }
  }
  return { nodes };
}

export class ReelsModule implements IGameModule {
  readonly type = 'reels';
  readonly configSchema = REELS_SCHEMA;
  private config: Record<string, JsonValue>;

  private phase: 'idle' | 'spinning' | 'settling' = 'idle';
  private offsets: number[] = [];
  private settleStarts: number[] = [];
  private settleTargets: number[] = [];
  private elapsed = 0;
  private outcome: IOutcome | null = null;
  private offTick: (() => void) | null = null;
  private settledGrid: string[][] = [];

  private static readonly SPIN_SPEED = 1.2; // px/ms
  private static readonly REF_SPEED = 1.2;
  private static readonly MAX_BLUR = 8;
  private static readonly SETTLE_MS = 600;
  private static readonly STAGGER_MS = 150;

  constructor(private readonly args: { id: string; host: IModuleHost; config?: Record<string, JsonValue> }) {
    this.config = { ...(args.config ?? {}) };
  }

  get id(): string {
    return this.args.id;
  }

  private get host(): IModuleHost {
    return this.args.host;
  }

  setConfig(partial: Record<string, JsonValue>): void {
    this.config = { ...this.config, ...partial };
  }

  project(): void {
    const snap = this.host.snapshot();
    const desired = buildDesired(this.id, this.withCenteredOrigin(this.config, snap));
    const owns = (nodeId: string) => nodeId.startsWith(`${this.id}:`);
    this.host.emit(reconcileOps(snap, desired, owns));
  }

  /** Fill a centered origin from the Root's landscape safe area when the config
   *  leaves originX/originY unset; explicit origins pass through unchanged. */
  private withCenteredOrigin(raw: Record<string, JsonValue>, doc: IGameDocument): Record<string, JsonValue> {
    if (raw.originX !== undefined && raw.originY !== undefined) return raw;
    const cfg = resolveConfig(raw);
    const { originX, originY } = centeredOrigin(cfg, landscapeSafeArea(doc));
    return { ...raw, originX: raw.originX ?? originX, originY: raw.originY ?? originY };
  }

  mount(): void {
    this.offTick = this.host.onTick((dt) => this.update(dt));
  }

  dispose(): void {
    this.offTick?.();
    this.offTick = null;
  }

  startSpinning(): void {
    const cfg = resolveConfig(this.config);
    this.offsets = new Array(cfg.cols).fill(0);
    this.outcome = null;
    this.elapsed = 0;
    this.phase = 'spinning';
  }

  stopSpinning(outcome: IOutcome): void {
    this.outcome = outcome;
    this.elapsed = 0;
    const cfg = resolveConfig(this.config);
    const span = cfg.cellSize + cfg.spacing;
    const total = cfg.rows + cfg.buffer;
    // Natural residual travel of the old decaying-speed settle (integral of 1-easeOutCubic).
    const minTravel = (ReelsModule.SPIN_SPEED * ReelsModule.SETTLE_MS) / 4;
    this.settleStarts = [...this.offsets];
    this.settleTargets = [];
    const ops: Op[] = [];
    for (let c = 0; c < cfg.cols; c++) {
      // Each column keeps full speed through its stagger delay, then eases from `base`
      // to a target on an exact cell boundary — so it lands aligned, no snap.
      const base = this.offsets[c] + ReelsModule.SPIN_SPEED * reelDelay(c, ReelsModule.STAGGER_MS);
      const target = settleTarget(base, minTravel, span);
      this.settleTargets.push(target);
      // Stamp each cell with the symbol of the row it will land on, now, under max
      // blur — the real stop symbols then scroll into view during the final wraps.
      const strip = this.stopStrip(c, cfg.symbols);
      for (let r = 0; r < total; r++) {
        const sym = symbolAt(strip, finalRow(r, target, span, total));
        ops.push({ kind: 'setProp', id: cellId(this.id, c, r), path: 'fill', value: colorForSymbol(sym) });
        ops.push({ kind: 'setProp', id: cellId(this.id, c, r), path: 'label', value: sym });
      }
    }
    this.host.emit(ops);
    this.phase = 'settling';
  }

  /** Composed trigger seam (TraceWalker): run one served spin end to end and
   *  resolve when the reels settle. The Orchestrator/slots path never calls this. */
  invoke(trigger: string, data: ITriggerData): Promise<void> {
    if (trigger !== 'spin' || data.kind !== 'reels') {
      return Promise.reject(new Error(`reels: unsupported trigger ${trigger} (${data.kind})`));
    }
    const grid = data.grid.map((reel) => reel.map((sym) => String(sym)));
    return new Promise((resolve) => {
      const off = this.host.bus.on('reels:settled', () => {
        off();
        resolve();
      });
      this.project(); // idempotent — ensures structure exists (as Orchestrator.spin does)
      this.startSpinning();
      this.stopSpinning({ grid });
    });
  }

  update(dtMs: number): void {
    if (this.phase === 'idle') return;
    const cfg = resolveConfig(this.config);
    const span = cfg.cellSize + cfg.spacing;

    if (this.phase === 'spinning') {
      for (let c = 0; c < cfg.cols; c++) {
        this.offsets[c] = advance(this.offsets[c], ReelsModule.SPIN_SPEED, dtMs);
        this.renderReel(c, cfg, span, ReelsModule.SPIN_SPEED);
      }
      return;
    }

    // settling — positional easing: each column is a pure function of elapsed,
    // so it lands exactly on its cell-boundary target instead of freezing mid-cell.
    this.elapsed += dtMs;
    let allDone = true;
    for (let c = 0; c < cfg.cols; c++) {
      const delay = reelDelay(c, ReelsModule.STAGGER_MS);
      if (settleT(this.elapsed, delay, ReelsModule.SETTLE_MS) < 1) allDone = false;
      const prev = this.offsets[c];
      this.offsets[c] = settleOffset(this.elapsed, delay, ReelsModule.SETTLE_MS, this.settleStarts[c], this.settleTargets[c], ReelsModule.SPIN_SPEED);
      const speed = dtMs > 0 ? (this.offsets[c] - prev) / dtMs : 0;
      this.renderReel(c, cfg, span, speed);
    }

    if (allDone) this.finishSettle(cfg);
  }

  private renderReel(col: number, cfg: IReelsConfig, span: number, speed: number): void {
    const blur = blurFor(speed, ReelsModule.MAX_BLUR, ReelsModule.REF_SPEED);
    const total = cfg.rows + cfg.buffer;
    for (let r = 0; r < total; r++) {
      const handle = this.host.resolve(cellId(this.id, col, r));
      if (!handle) continue;
      handle.position.y = wrap(r * span + this.offsets[col], total * span) - span;
      handle.setBlur(blur);
    }
  }

  /** The settled stop column for reel `col`, padded to the strip length the renderer indexes. */
  private stopStrip(col: number, symbols: string[]): string[] {
    const stops = this.outcome?.grid[col] ?? [];
    return stops.length ? stops : symbols;
  }

  /** Safety net: columns already land on cell boundaries showing the outcome, so
   *  these writes re-canonicalize cell ids to rows without changing visible content. */
  private finishSettle(cfg: IReelsConfig): void {
    const span = cfg.cellSize + cfg.spacing;
    const total = cfg.rows + cfg.buffer;
    const grid: string[][] = [];
    const ops: Op[] = [];
    for (let c = 0; c < cfg.cols; c++) {
      const stops = this.outcome?.grid[c] ?? [];
      grid.push(stops.slice(0, cfg.rows));
      for (let r = 0; r < total; r++) {
        const row = restRow(r, cfg.rows, cfg.buffer);
        const handle = this.host.resolve(cellId(this.id, c, r));
        if (handle) {
          handle.setBlur(0);
          handle.position.y = row * span;
        }
        if (!stops.length) continue;
        // Same rest frame + same symbol-per-row the settle landed on, so nothing
        // visibly moves — spare rows keep the strip's wraparound continuation.
        const sym = symbolAt(stops, row);
        ops.push({ kind: 'setProp', id: cellId(this.id, c, r), path: 'fill', value: colorForSymbol(sym) });
        ops.push({ kind: 'setProp', id: cellId(this.id, c, r), path: 'label', value: sym });
      }
    }
    if (ops.length) this.host.emit(ops);
    this.settledGrid = grid;
    this.phase = 'idle';
    this.host.bus.emit('reels:settled', { grid });
  }

  debugState(): { phase: 'idle' | 'spinning' | 'settling'; grid: string[][] } {
    return { phase: this.phase, grid: this.settledGrid };
  }
}
