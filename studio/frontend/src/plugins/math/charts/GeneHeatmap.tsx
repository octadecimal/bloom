import type { IGenFrame } from '../state';

export interface IGeneHeatmapProps {
  frames: IGenFrame[];
  selectedGeneration: number | 'live';
}

function selectedGenerationOf(frames: IGenFrame[], selectedGeneration: number | 'live'): number | null {
  if (frames.length === 0) return null;
  return selectedGeneration === 'live' ? frames[frames.length - 1].generation : selectedGeneration;
}

/** Gene-convergence heatmap — hand-rolled CSS grid (bespoke mark, not the
 * `IChart` seam; see docs/design-language.md + the dataviz skill). One row per
 * tunable gene dimension (`IGenFrame.geneAgreement` index), one column per
 * generation. Rows are fixed 14px height so the strip hugs its content; the
 * tab's flexible space belongs to the charts. Cell color warms from
 * `--chart-gene-cold` (indigo, low population agreement) to
 * `--chart-gene-hot` (amber, converged) via `color-mix()` — no raw color
 * literals in this file (the design-language guard blocks that; only styles.css
 * may declare them). */
export function GeneHeatmap({ frames, selectedGeneration }: IGeneHeatmapProps) {
  const geneCount = frames.reduce((max, f) => Math.max(max, f.geneAgreement.length), 0);
  const selectedGen = selectedGenerationOf(frames, selectedGeneration);

  return (
    <div data-testid="gene-heatmap" className="flex min-h-0 flex-col gap-1 overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <div className="flex flex-none items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-2">Gene convergence</span>
        {geneCount > 0 && (
          <span className="flex items-center gap-1 text-[9px] text-text-3">
            drifting
            <span
              data-testid="gene-heatmap-legend"
              className="h-1.5 w-14 rounded-full"
              style={{ background: 'linear-gradient(to right, var(--chart-gene-cold), var(--chart-gene-hot))' }}
            />
            converged
          </span>
        )}
      </div>
      {geneCount === 0 ? (
        <div className="flex items-center justify-center py-3 text-xs text-text-3">No gene data yet.</div>
      ) : (
        <div className="grid gap-[2px]" style={{ gridTemplateRows: `repeat(${geneCount}, 14px)` }}>
          {Array.from({ length: geneCount }, (_, gene) => (
            <div
              key={gene}
              data-testid="gene-heatmap-row"
              className="grid gap-[2px]"
              style={{ gridTemplateColumns: `repeat(${frames.length}, minmax(0, 1fr))` }}
            >
              {frames.map((frame) => {
                const agreement = Math.max(0, Math.min(1, frame.geneAgreement[gene] ?? 0));
                const pct = Math.round(agreement * 100);
                const isSelected = frame.generation === selectedGen;
                return (
                  <div
                    key={frame.generation}
                    data-testid="gene-heatmap-cell"
                    data-generation={frame.generation}
                    data-selected={isSelected}
                    title={`gen ${frame.generation} · gene ${gene} · ${pct}% agreement`}
                    className="h-full w-full rounded-[2px]"
                    style={{
                      background: `color-mix(in oklab, var(--chart-gene-cold), var(--chart-gene-hot) ${pct}%)`,
                      boxShadow: isSelected ? 'inset 0 0 0 1.5px var(--chart-playhead)' : 'none',
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
