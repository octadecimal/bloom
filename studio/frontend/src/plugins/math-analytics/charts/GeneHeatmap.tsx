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
 * generation. Cell color warms from `--chart-gene-cold` (indigo, low
 * population agreement) to `--chart-gene-hot` (amber, converged) via
 * `color-mix()` — no raw color literals in this file (the design-language
 * guard blocks that; only styles.css may declare them). */
export function GeneHeatmap({ frames, selectedGeneration }: IGeneHeatmapProps) {
  const geneCount = frames.reduce((max, f) => Math.max(max, f.geneAgreement.length), 0);
  const selectedGen = selectedGenerationOf(frames, selectedGeneration);

  return (
    <div data-testid="gene-heatmap" className="flex min-h-0 flex-col gap-1 overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <span className="flex-none text-[10px] font-semibold uppercase tracking-wide text-text-2">Gene convergence</span>
      {geneCount === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-text-3">No gene data yet.</div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-[2px]" style={{ gridTemplateRows: `repeat(${geneCount}, minmax(0, 1fr))` }}>
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
