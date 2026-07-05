import type { IGenFrame } from '../state';
import { FitnessLandscape } from '../charts/FitnessLandscape';
import { GeneHeatmap } from '../charts/GeneHeatmap';
import { Scrubber } from '../charts/Scrubber';
import { UPlotChart } from '../charts/UPlotChart';
import type { IChartData } from '../charts/IChart';

export interface IEvolutionTabProps {
  frames: IGenFrame[];
  selectedGeneration: number | 'live';
  onScrub: (generation: number) => void;
}

/** Evolution — the GA story, watched live as a tune runs or replayed post-hoc.
 * Composes the five Evolution charts from the design spec: the hero fitness
 * landscape, RTP/volatility homing, the gene-convergence heatmap, and the
 * generation scrubber that drives all of their playheads. Fills the pane
 * exactly — no inner scroll (see docs/design-language.md's fit rule and the
 * .bloom-tab-fill utility, mirroring MathProfileTab). */
export function EvolutionTab({ frames, selectedGeneration, onScrub }: IEvolutionTabProps) {
  if (frames.length === 0) {
    return (
      <div data-testid="evolution-no-data" className="bloom-tab-fill flex items-center justify-center bg-surface text-text-2">
        No generations recorded yet — start a tune to watch it evolve.
      </div>
    );
  }

  return (
    <div data-testid="evolution-tab" className="bloom-tab-fill grid grid-rows-[minmax(0,1fr)_auto_auto] gap-2 bg-surface p-2">
      <div className="grid min-h-0 grid-cols-[2fr_1fr] gap-2">
        <FitnessLandscape frames={frames} selectedGeneration={selectedGeneration} />
        <div className="grid min-h-0 grid-rows-2 gap-2">
          <HomingTile testId="rtp-homing" title="RTP homing" seriesLabel="Best RTP" frames={frames} pick={(f) => f.best.rtp} format={(v) => v.toFixed(4)} />
          <HomingTile
            testId="vol-homing"
            title="Volatility homing"
            seriesLabel="Best volatility"
            frames={frames}
            pick={(f) => f.best.volatility}
            format={(v) => v.toFixed(3)}
          />
        </div>
      </div>
      <GeneHeatmap frames={frames} selectedGeneration={selectedGeneration} />
      <Scrubber frames={frames} selectedGeneration={selectedGeneration} onScrub={onScrub} />
    </div>
  );
}

/** Best-of-generation convergence as a stat tile: tiny label, the latest best
 * value as the headline number, and a bare sparkline of the homing path. The
 * `analytics_progress` wire carries no target-band bounds (only the
 * best-of-generation scalar), so there is intentionally NO reference line:
 * drawing one at the run's own latest value would be tautological and would
 * falsely imply convergence-to-a-target. Rendering a genuine target band is a
 * tracked fast-follow, gated on the wire growing target bounds. */
function HomingTile({
  testId,
  title,
  seriesLabel,
  frames,
  pick,
  format,
}: {
  testId: string;
  title: string;
  seriesLabel: string;
  frames: IGenFrame[];
  pick: (f: IGenFrame) => number;
  format: (v: number) => string;
}) {
  const data: IChartData = {
    x: frames.map((f) => f.generation),
    series: [{ label: seriesLabel, values: frames.map(pick), colorVar: '--chart-series-1' }],
    sparkline: true,
  };
  return (
    <div data-testid={testId} className="flex min-h-0 flex-col overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <div className="flex flex-none items-baseline justify-between px-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-2">{title}</span>
        <span data-testid={`${testId}-value`} className="text-lg font-medium tabular-nums leading-none text-text-1">
          {format(pick(frames[frames.length - 1]))}
        </span>
      </div>
      <UPlotChart data={data} className="min-h-0 flex-1" />
    </div>
  );
}
