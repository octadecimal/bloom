import type { IHistogramBin } from '../state';

export interface IHistogramProps {
  bins: IHistogramBin[];
  zeroCount: number;
}

type Role = 'loss' | 'base' | 'feature' | 'tail';

// The "rare tail" cutoff mirrors the tail metric's own threshold (P(>=100x) —
// see ITailMetrics.pGE100x / bloom-simulator's profile()) so the histogram's
// color break lines up with the stat tile that names it.
const TAIL_MULTIPLIER = 100;

function roleFor(bin: IHistogramBin): Role {
  if (bin.binLo >= TAIL_MULTIPLIER) return 'tail';
  if (bin.feature > 0 && bin.feature >= bin.base) return 'feature';
  return 'base';
}

function roleColor(role: Role): string {
  switch (role) {
    case 'loss':
      return 'var(--chart-loss)';
    case 'base':
      return 'var(--chart-base)';
    case 'feature':
      return 'var(--chart-feature)';
    case 'tail':
      return 'var(--chart-tail)';
  }
}

function formatMult(n: number): string {
  if (n >= 1000) return `${n / 1000}k×`; // "1000×–2000×" overflows its bar slot; "1k×–2k×" fits
  return Number.isInteger(n) ? `${n}×` : `${n.toFixed(1)}×`;
}

export function binLabel(bin: IHistogramBin): string {
  return bin.binHi === null ? `${formatMult(bin.binLo)}+` : `${formatMult(bin.binLo)}–${formatMult(bin.binHi)}`;
}

const WIDTH = 640;
const HEIGHT = 220;
const PAD_TOP = 8;
const PAD_BOTTOM = 26;

interface IColumn {
  key: string;
  label: string;
  count: number;
  role: Role;
}

/** Hero win-distribution histogram — hand-rolled SVG, not the `IChart` seam
 * (bespoke mark; see docs/design-language.md + the dataviz skill). Bars are on a
 * log(1+count) height scale — the zero/loss column and the rare tail otherwise
 * dwarf everything else on a linear one — and colored by role: base game wins,
 * feature/bonus wins, or the rare tail (>=100x), matching StatTiles' pGE100x. */
export function Histogram({ bins, zeroCount }: IHistogramProps) {
  const columns: IColumn[] = [
    { key: 'loss', label: '0×', count: zeroCount, role: 'loss' },
    ...bins.map((bin, i) => ({ key: `bin-${i}`, label: binLabel(bin), count: bin.base + bin.feature, role: roleFor(bin) })),
  ];
  const maxCount = Math.max(1, ...columns.map((c) => c.count));
  const chartHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const barSlot = WIDTH / columns.length;

  function barHeight(count: number): number {
    if (count <= 0) return 0;
    return (Math.log1p(count) / Math.log1p(maxCount)) * chartHeight;
  }

  return (
    <div data-testid="win-distribution" className="flex h-full min-h-0 flex-col">
      <div className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-2">Win distribution</div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="min-h-0 w-full flex-1"
        role="img"
        aria-label="Win distribution histogram, log-multiplier x-axis"
      >
        <line x1={0} y1={PAD_TOP + chartHeight} x2={WIDTH} y2={PAD_TOP + chartHeight} style={{ stroke: 'var(--hairline)' }} strokeWidth={1} />
        {columns.map((col, i) => {
          const h = barHeight(col.count);
          const w = barSlot * 0.76;
          const x = i * barSlot + barSlot * 0.12;
          const y = PAD_TOP + (chartHeight - h);
          return (
            <g key={col.key} data-testid="hist-bar">
              <rect x={x} y={y} width={w} height={h} rx={2} style={{ fill: roleColor(col.role) }}>
                <title>{`${col.label}: ${col.count}`}</title>
              </rect>
              {/* Staggered onto two baselines — 13 columns of "200×–500×" on one line collide. */}
              <text
                x={i * barSlot + barSlot / 2}
                y={HEIGHT - PAD_BOTTOM + (i % 2 === 0 ? 11 : 21)}
                textAnchor="middle"
                fontSize={9}
                style={{ fill: 'var(--text-3)' }}
              >
                {col.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-none gap-3 px-3 pb-2 text-[10px] text-text-2">
        <LegendSwatch color="var(--chart-base)" label="Base" />
        <LegendSwatch color="var(--chart-feature)" label="Feature" />
        <LegendSwatch color="var(--chart-tail)" label={`Tail (≥${TAIL_MULTIPLIER}×)`} />
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}
