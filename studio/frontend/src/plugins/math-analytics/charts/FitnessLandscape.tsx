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

/** Playhead position as a percentage along the generation timeline: the right
 * edge while `'live'`, or the scrubbed generation's index otherwise. */
export function playheadPercent(frames: IGenFrame[], selectedGeneration: number | 'live'): number {
  if (frames.length <= 1) return 0;
  if (selectedGeneration === 'live') return 100;
  const idx = frames.findIndex((f) => f.generation === selectedGeneration);
  if (idx < 0) return 100;
  return (idx / (frames.length - 1)) * 100;
}

/** Hero chart of the Evolution tab — see docs/superpowers/specs/2026-07-02-math-analytics-dashboard-design.md
 * Tab 1 §1. The line + bands render through the `IChart`/`UPlotChart` seam; the
 * playhead is a plain positioned overlay (percentage along the timeline), kept
 * out of uPlot entirely rather than teaching the seam about cursor state. */
export function FitnessLandscape({ frames, selectedGeneration }: IFitnessLandscapeProps) {
  const data = buildFitnessLandscapeData(frames);
  const left = playheadPercent(frames, selectedGeneration);

  return (
    <div data-testid="fitness-landscape" className="flex min-h-0 flex-col overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <span className="flex-none px-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2">Fitness landscape</span>
      <div className="relative min-h-0 flex-1">
        <UPlotChart data={data} className="h-full w-full" />
        <div
          data-testid="fitness-landscape-playhead"
          className="pointer-events-none absolute inset-y-0 border-l border-dashed"
          style={{ left: `${left}%`, borderColor: 'var(--chart-playhead)' }}
        />
      </div>
    </div>
  );
}
