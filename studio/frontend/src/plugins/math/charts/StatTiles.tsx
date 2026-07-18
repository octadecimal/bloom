import type { ITailMetrics } from '../state';

export interface IStatTilesProps {
  tail: ITailMetrics;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

interface ITileDef {
  testId: string;
  label: string;
  /** Full metric name, shown as a native tooltip when the label is shortened. */
  title: string;
  value: string;
}

/** Tail & risk stats — hand-rolled (no chart library involved). One card of
 * label/value rows (mirrors the hit-rate-by-band card): a tile-per-metric grid
 * truncated both labels AND values once the pane shared its row with three
 * sibling cards. */
export function StatTiles({ tail }: IStatTilesProps) {
  const tiles: ITileDef[] = [
    { testId: 'stat-max-win', label: 'Max win', title: 'Maximum win multiplier', value: `${tail.maxWin.toFixed(1)}×` },
    { testId: 'stat-p-ge-100x', label: 'P(win ≥ 100×)', title: 'Probability of a 100×+ win', value: pct(tail.pGE100x) },
    { testId: 'stat-p-losing-spin', label: 'Losing spins', title: 'Share of losing spins', value: pct(tail.pLosingSpin) },
    { testId: 'stat-longest-dead-streak', label: 'Dead streak', title: 'Longest dead streak', value: `${tail.longestDeadStreak}` },
    { testId: 'stat-bonus-trigger-rate', label: 'Bonus rate', title: 'Bonus trigger rate', value: pct(tail.bonusTriggerRate) },
  ];

  return (
    <div data-testid="tail-tiles" className="flex h-full min-h-0 flex-col gap-1 overflow-hidden rounded-md border border-hairline bg-raised p-2.5">
      <span className="flex-none text-[10px] font-semibold uppercase tracking-wide text-text-2">Tail &amp; risk</span>
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 overflow-hidden">
        {tiles.map((tile) => (
          <div key={tile.testId} data-testid={tile.testId} title={tile.title} className="flex items-baseline justify-between gap-1.5 text-[10px]">
            <span className="truncate uppercase tracking-wide text-text-2">{tile.label}</span>
            <span className="flex-none text-xs font-semibold text-text-1">{tile.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
