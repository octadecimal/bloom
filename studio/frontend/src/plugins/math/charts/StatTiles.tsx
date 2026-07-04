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
  value: string;
}

/** Tail & risk stat tiles — hand-rolled (no chart library involved). */
export function StatTiles({ tail }: IStatTilesProps) {
  const tiles: ITileDef[] = [
    { testId: 'stat-max-win', label: 'Max win', value: `${tail.maxWin.toFixed(1)}×` },
    { testId: 'stat-p-ge-100x', label: 'P(win ≥ 100×)', value: pct(tail.pGE100x) },
    { testId: 'stat-p-losing-spin', label: 'Losing spins', value: pct(tail.pLosingSpin) },
    { testId: 'stat-longest-dead-streak', label: 'Longest dead streak', value: `${tail.longestDeadStreak}` },
    { testId: 'stat-bonus-trigger-rate', label: 'Bonus trigger rate', value: pct(tail.bonusTriggerRate) },
  ];

  return (
    <div data-testid="tail-tiles" className="grid h-full min-h-0 grid-cols-2 gap-2 overflow-hidden p-2 sm:grid-cols-3">
      {tiles.map((tile) => (
        <div key={tile.testId} data-testid={tile.testId} className="flex flex-col justify-center rounded-md border border-hairline bg-raised px-2.5 py-2">
          <span className="text-[10px] uppercase tracking-wide text-text-2">{tile.label}</span>
          <span className="text-base font-semibold text-text-1">{tile.value}</span>
        </div>
      ))}
    </div>
  );
}
