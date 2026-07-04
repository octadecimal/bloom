import type { IGenFrame } from '../state';
import type { IChartData } from './IChart';
import { UPlotChart } from './UPlotChart';

export interface IFitnessLandscapeProps {
  frames: IGenFrame[];
  selectedGeneration: number | 'live';
}

/** Best-fitness line + a shaded population-spread band (min–max, plus the
 * denser IQR q1–q3) across every recorded generation. Exported for direct
 * (adapter-level) testing — see FitnessLandscape.spec.tsx — since the
 * component itself renders through the `UPlotChart`/`IChart` seam. */
export function buildFitnessLandscapeData(frames: IGenFrame[]): IChartData {
  return {
    x: frames.map((f) => f.generation),
    series: [{ label: 'Best fitness', values: frames.map((f) => f.best.fitness), colorVar: '--chart-series-1' }],
    bands: [
      {
        label: 'Population range',
        loValues: frames.map((f) => f.population.min),
        hiValues: frames.map((f) => f.population.max),
        colorVar: '--chart-population-band',
      },
      {
        label: 'IQR',
        loValues: frames.map((f) => f.population.q1),
        hiValues: frames.map((f) => f.population.q3),
        colorVar: '--chart-iqr-band',
      },
    ],
    xLabel: 'Generation',
    yLabel: 'Fitness',
  };
}

/** The generation the playhead marks: the scrubbed generation when it exists,
 * otherwise the newest recorded one (live mode, or a stale scrub position
 * after frames reset). Undefined with no frames. */
export function playheadGeneration(frames: IGenFrame[], selectedGeneration: number | 'live'): number | undefined {
  if (frames.length === 0) return undefined;
  if (selectedGeneration !== 'live' && frames.some((f) => f.generation === selectedGeneration)) return selectedGeneration;
  return frames[frames.length - 1].generation;
}

/** Hero chart of the Evolution tab — see docs/superpowers/specs/2026-07-02-math-analytics-dashboard-design.md
 * Tab 1 §1. The line + bands render through the `IChart`/`UPlotChart` seam; the
 * playhead rides inside the chart as `IChartData.playheadX` (drawn by the
 * adapter at the true data-space position — an overlay div can't know uPlot's
 * axis gutter; see docs/superpowers/specs/2026-07-04-math-evolution-visual-polish-design.md §2). */
export function FitnessLandscape({ frames, selectedGeneration }: IFitnessLandscapeProps) {
  const data: IChartData = { ...buildFitnessLandscapeData(frames), playheadX: playheadGeneration(frames, selectedGeneration) };

  return (
    <div data-testid="fitness-landscape" className="flex min-h-0 flex-col overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <span className="flex-none px-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2">Fitness landscape</span>
      <UPlotChart data={data} className="min-h-0 flex-1" />
    </div>
  );
}
