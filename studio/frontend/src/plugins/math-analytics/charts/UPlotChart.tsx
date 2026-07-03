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

function toAlignedData(data: IChartData): uPlot.AlignedData {
  return [data.x, ...data.series.map((s) => s.values)] as unknown as uPlot.AlignedData;
}

function toOptions(data: IChartData, width: number, height: number): uPlot.Options {
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
    ],
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
