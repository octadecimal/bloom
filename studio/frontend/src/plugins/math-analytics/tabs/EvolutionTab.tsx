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
    <div data-testid="evolution-tab" className="bloom-tab-fill grid grid-rows-[minmax(0,1.6fr)_minmax(0,1fr)_auto] gap-2 bg-surface p-2">
      <div className="grid min-h-0 grid-cols-[2fr_1fr] gap-2">
        <FitnessLandscape frames={frames} selectedGeneration={selectedGeneration} />
        <div className="grid min-h-0 grid-rows-2 gap-2">
          <RtpHoming frames={frames} />
          <VolHoming frames={frames} />
        </div>
      </div>
      <GeneHeatmap frames={frames} selectedGeneration={selectedGeneration} />
      <Scrubber frames={frames} selectedGeneration={selectedGeneration} onScrub={onScrub} />
    </div>
  );
}

/** Best-RTP curving toward its target. The wire (`analytics_progress` /
 * `IGenSnapshot`) carries no target-band bounds — only the best-of-generation
 * scalar — so, mirroring MathProfileTab's RtpConvergenceChart (same
 * constraint, same precedent), the current run's own latest measured RTP is
 * drawn as a dashed reference line rather than a fabricated band. */
function RtpHoming({ frames }: { frames: IGenFrame[] }) {
  const latest = frames[frames.length - 1]?.best.rtp ?? 0;
  const data: IChartData = {
    x: frames.map((f) => f.generation),
    series: [
      { label: 'Best RTP', values: frames.map((f) => f.best.rtp), colorVar: '--chart-series-1' },
      { label: 'Latest RTP', values: frames.map(() => latest), colorVar: '--chart-target-band', dash: true },
    ],
    xLabel: 'Generation',
    yLabel: 'RTP',
  };
  return (
    <div data-testid="rtp-homing" className="flex min-h-0 flex-col overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <span className="flex-none px-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2">RTP homing</span>
      <UPlotChart data={data} className="min-h-0 flex-1" />
    </div>
  );
}

/** Best-volatility curving toward its target — same shape and constraint as
 * RtpHoming above. */
function VolHoming({ frames }: { frames: IGenFrame[] }) {
  const latest = frames[frames.length - 1]?.best.volatility ?? 0;
  const data: IChartData = {
    x: frames.map((f) => f.generation),
    series: [
      { label: 'Best volatility', values: frames.map((f) => f.best.volatility), colorVar: '--chart-series-1' },
      { label: 'Latest volatility', values: frames.map(() => latest), colorVar: '--chart-target-band', dash: true },
    ],
    xLabel: 'Generation',
    yLabel: 'Volatility',
  };
  return (
    <div data-testid="vol-homing" className="flex min-h-0 flex-col overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <span className="flex-none px-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2">Volatility homing</span>
      <UPlotChart data={data} className="min-h-0 flex-1" />
    </div>
  );
}
