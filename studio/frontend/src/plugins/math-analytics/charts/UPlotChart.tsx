import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { IChart, IChartData } from './IChart';

/** Reads a design-language token off :root. Never a raw literal — see the
 * no-raw-color guard (`design-language.guard.spec.ts`); canvas-drawn libraries
 * like uPlot need a real color string, so this is the sanctioned escape hatch. */
function cssVar(name: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'currentColor';
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || 'currentColor';
}

/** Each `IChartBand` becomes two hidden columns appended after the plain
 * series — hi first, then lo — matched 1:1 with the hidden `uPlot.Series`
 * entries `toOptions` appends in the same order, and wired together by
 * `bandSeriesIndices` below. Exported (alongside `toOptions`) so band support
 * can be unit-tested directly: jsdom has no canvas, so a real uPlot instance
 * can never be mounted in tests — see UPlotChart.spec.tsx. */
export function toAlignedData(data: IChartData): uPlot.AlignedData {
  const bandColumns = (data.bands ?? []).flatMap((b) => [b.hiValues, b.loValues]);
  return [data.x, ...data.series.map((s) => s.values), ...bandColumns] as unknown as uPlot.AlignedData;
}

/** The [hi, lo] `uPlot.Series` index pair for the Nth band, given how many
 * plain series precede the band columns in `toAlignedData`/`toOptions`. */
function bandSeriesIndices(seriesCount: number, bandIndex: number): [number, number] {
  const hi = 1 + seriesCount + bandIndex * 2; // +1 for the x column at index 0
  return [hi, hi + 1];
}

export function toOptions(data: IChartData, width: number, height: number): uPlot.Options {
  const bandDefs = data.bands ?? [];
  // uPlot fills a band between two *series* (not raw data) — see uPlot.Band's
  // "top edge" / "bottom edge" contract. The hi/lo edges are real series so the
  // fill has values to work from, but hidden (transparent stroke, no points):
  // the band's fill IS their visual representation, drawn by uPlot's own band
  // renderer, not a stroked line.
  const bandSeries: uPlot.Series[] = bandDefs.flatMap((b) => [
    { label: b.label ? `${b.label} (hi)` : undefined, stroke: 'transparent', width: 0, points: { show: false } },
    { label: b.label ? `${b.label} (lo)` : undefined, stroke: 'transparent', width: 0, points: { show: false } },
  ]);
  const bands: uPlot.Band[] | undefined =
    bandDefs.length > 0 ? bandDefs.map((b, i) => ({ series: bandSeriesIndices(data.series.length, i), fill: cssVar(b.colorVar) })) : undefined;

  return {
    width,
    height,
    scales: { x: { time: false, distr: data.logX ? 3 : 1 } },
    axes: [
      { label: data.xLabel, stroke: cssVar('--text-2'), grid: { stroke: cssVar('--hairline') } },
      { label: data.yLabel, stroke: cssVar('--text-2'), grid: { stroke: cssVar('--hairline') } },
    ],
    series: [
      {},
      ...data.series.map((s) => ({
        label: s.label,
        stroke: cssVar(s.colorVar),
        width: 2,
        dash: s.dash ? [6, 4] : undefined,
        points: { show: false },
      })),
      ...bandSeries,
    ],
    bands,
    legend: { show: data.series.length > 1 },
  };
}

/** The uPlot-backed `IChart` implementation. Construction stays behind this factory
 * so components (and their tests) depend only on `IChart`. */
export function createUPlotChart(width = 600, height = 220): IChart {
  let plot: uPlot | null = null;
  return {
    mount(el, data) {
      plot = new uPlot(toOptions(data, el.clientWidth || width, height), toAlignedData(data), el);
    },
    update(data) {
      if (!plot) return;
      plot.setData(toAlignedData(data));
    },
    destroy() {
      plot?.destroy();
      plot = null;
    },
  };
}

export interface IUPlotChartProps {
  data: IChartData;
  className?: string;
  /** Injection seam for tests — defaults to the real uPlot-backed adapter. */
  factory?: () => IChart;
}

export function UPlotChart({ data, className, factory = createUPlotChart }: IUPlotChartProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChart | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const chart = factory();
    chart.mount(elRef.current, data);
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
    // Mount once; subsequent data changes flow through `update` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chartRef.current?.update(data);
  }, [data]);

  return <div ref={elRef} className={className} />;
}
