// runtime/client/src/modules/reels/reelsModule.ts
import type { JsonValue } from '../../model/document';
import type { IGameModule, IModuleHost, IOutcome } from '../module';
import { validateConfig, type IConfigSchema } from '../schema';
import { reconcileOps, type IDesiredNode, type IDesiredScene } from '../reconcile';

export const REELS_SCHEMA: IConfigSchema = {
  rows: { type: 'integer', default: 3, min: 1, max: 8 },
  cols: { type: 'integer', default: 5, min: 1, max: 10 },
  symbols: { type: 'stringArray', default: ['A', 'B', 'C', 'D', 'E'] },
  cellSize: { type: 'number', default: 100, min: 1 },
  spacing: { type: 'number', default: 8, min: 0 },
  originX: { type: 'number', default: 0 },
  originY: { type: 'number', default: 0 },
  parentId: { type: 'string', default: 'root', binding: 'parent' },
  buffer: { type: 'integer', default: 1, min: 0, max: 4 },
};

export function containerId(moduleId: string, col: number): string {
  return `${moduleId}:reel:${col}`;
}

export function cellId(moduleId: string, col: number, row: number): string {
  return `${moduleId}:cell:${col}:${row}`;
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
      nodes.push({
        id: cellId(moduleId, c, r),
        type: 'Sprite',
        props: { position: { x: 0, y: r * span }, symbol: cfg.symbols[r % cfg.symbols.length] },
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
    const desired = buildDesired(this.id, this.config);
    const owns = (nodeId: string) => nodeId.startsWith(`${this.id}:`);
    this.host.emit(reconcileOps(this.host.snapshot(), desired, owns));
  }

  // Behavior verbs (Task 7) are added below.
  mount(): void {}
  update(_dtMs: number): void {}
  dispose(): void {}
  startSpinning(): void {}
  stopSpinning(_outcome: IOutcome): void {}
}
