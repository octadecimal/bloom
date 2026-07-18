// The charting seam. Line/band series render through a uPlot-backed `IChart`
// implementation (`UPlotChart.tsx` / `createUPlotChart`); bespoke marks
// (histogram, stat tiles) are hand-rolled SVG/CSS components instead — they
// never go through this seam. Tests target `IChart`, never uPlot itself, so
// the underlying library stays swappable (see [[prefer-proven-libraries]]).

export interface IChartSeries {
  label: string;
  values: (number | null)[]; // aligned to IChartData.x; null = gap
  /** CSS custom-property name (e.g. `--chart-series-1`) the adapter resolves at render time. */
  colorVar: string;
  /** Render as a dashed reference line (e.g. a flat target value) instead of a solid series. */
  dash?: boolean;
}

export interface IChartBand {
  label?: string;
  loValues: (number | null)[];
  hiValues: (number | null)[];
  colorVar: string;
}

export interface IChartData {
  x: number[];
  series: IChartSeries[];
  bands?: IChartBand[];
  xLabel?: string;
  yLabel?: string;
  /** Log-scale the x-axis (win-distribution / RTP-convergence sample-size axes). */
  logX?: boolean;
  /** Draw a dashed vertical playhead at this data-space x value (the Evolution
   * scrubber's generation). Rendered by the adapter inside the plot area. */
  playheadX?: number;
  /** Bare-line mode for stat tiles: no axes, grid, legend, or cursor. */
  sparkline?: boolean;
  /** Override the legend default (shown when 2+ series and not a sparkline).
   * Small cards set `false` and render their own HTML caption instead —
   * uPlot's legend doesn't fit a quarter-width card. */
  legend?: boolean;
}

export interface IChart {
  mount(el: HTMLElement, data: IChartData): void;
  update(data: IChartData): void;
  destroy(): void;
}
