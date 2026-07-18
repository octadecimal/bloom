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

export function toOptions(data: IChartData, width: number, height: number, playheadX?: () => number | undefined): uPlot.Options {
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

  const axes: uPlot.Axis[] = data.sparkline
    ? [{ show: false }, { show: false }]
    : [
        {
          label: data.xLabel,
          stroke: cssVar('--text-2'),
          grid: { stroke: cssVar('--hairline') },
          // ponytail: log-x tick labels are blanked — uPlot draws every label a
          // custom `values` returns (no space-based skipping), and in the small
          // convergence card even decade labels smear into each other. The HTML
          // caption names the axis. If a large view ever wants them back, wire
          // uPlot's `filter` (space-aware) instead of `values`.
          values: data.logX ? (_u, ticks) => ticks.map(() => '') : undefined,
        },
        { label: data.yLabel, stroke: cssVar('--text-2'), grid: { stroke: cssVar('--hairline') } },
      ];

  return {
    width,
    height,
    scales: { x: { time: false, distr: data.logX ? 3 : 1 } },
    axes,
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
    legend: { show: data.legend ?? (!data.sparkline && data.series.length > 1) },
    cursor: data.sparkline ? { show: false } : undefined,
    hooks: playheadX
      ? {
          draw: [
            (u: uPlot) => {
              const xVal = playheadX();
              if (xVal == null) return;
              const x = u.valToPos(xVal, 'x', true);
              const { ctx, bbox } = u;
              ctx.save();
              ctx.lineWidth = devicePixelRatio;
              ctx.strokeStyle = cssVar('--chart-playhead');
              ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
              ctx.beginPath();
              ctx.moveTo(x, bbox.top);
              ctx.lineTo(x, bbox.top + bbox.height);
              ctx.stroke();
              ctx.restore();
            },
          ],
        }
      : undefined,
  };
}

/** uPlot's series (and derived options like `legend.show`) are fixed at
 * construction time — `plot.setData` can only change data *values*, never add
 * or remove series/bands. A "shape" is the (series count, band count) pair
 * that determines how many `uPlot.Series` entries `toOptions` declares; when
 * it changes, `setData` would either silently drop the extra series (fewer
 * columns than configured) or throw (uPlot indexes `data[i]` for every
 * configured series, and a missing column is `undefined`). */
function shapeOf(data: IChartData): string {
  return `${data.series.length}:${data.bands?.length ?? 0}`;
}

/** The uPlot-backed `IChart` implementation. Construction stays behind this factory
 * so components (and their tests) depend only on `IChart`. Size always comes from
 * the mount element (600x220 only as a zero-size fallback), and a ResizeObserver
 * keeps the canvas matched to the container across Dockview pane resizes. */
export function createUPlotChart(): IChart {
  let plot: uPlot | null = null;
  let mountEl: HTMLElement | null = null;
  let shape = '';
  let ro: ResizeObserver | null = null;
  let current: IChartData | null = null;

  // uPlot's `height` option sizes the plot region only — the `.u-legend`
  // element it renders for multi-series charts sits *below* that region,
  // inside the same mount element. Left unaccounted for, the legend overflows
  // the mount's `overflow-hidden` card and is permanently clipped. The legend
  // doesn't exist until uPlot constructs into the element, so `build` below
  // corrects the initial size with one extra `setSize` call once it appears.
  function sizeOf(el: HTMLElement): { width: number; height: number } {
    const legendHeight = el.querySelector<HTMLElement>('.u-legend')?.offsetHeight ?? 0;
    const rawHeight = el.clientHeight || 220;
    const height = legendHeight > 0 ? Math.max(rawHeight - legendHeight, 1) : rawHeight;
    return { width: el.clientWidth || 600, height };
  }

  function build(el: HTMLElement, data: IChartData) {
    current = data;
    const { width, height } = sizeOf(el);
    plot = new uPlot(
      toOptions(data, width, height, () => current?.playheadX),
      toAlignedData(data),
      el,
    );
    shape = shapeOf(data);
    // The legend only exists post-construction; if one rendered, re-measure
    // and correct the size uPlot was just built with. The ResizeObserver
    // keeps it right thereafter.
    const legendHeight = el.querySelector<HTMLElement>('.u-legend')?.offsetHeight ?? 0;
    if (legendHeight > 0) plot.setSize(sizeOf(el));
  }

  return {
    mount(el, data) {
      mountEl = el;
      build(el, data);
      // jsdom (vitest) has no ResizeObserver; guard so non-resize tests can
      // mount without stubbing it. Real browsers always take this branch.
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => {
          if (plot && mountEl) plot.setSize(sizeOf(mountEl));
        });
        ro.observe(el);
      }
    },
    update(data) {
      if (!plot || !mountEl) return;
      current = data;
      if (shapeOf(data) !== shape) {
        // Series/band count changed since construction — rebuild the uPlot
        // instance from scratch (new options + data) rather than feeding
        // `setData` a mismatched column count.
        plot.destroy();
        build(mountEl, data);
        return;
      }
      plot.setData(toAlignedData(data));
    },
    destroy() {
      ro?.disconnect();
      ro = null;
      plot?.destroy();
      plot = null;
      mountEl = null;
      current = null;
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
