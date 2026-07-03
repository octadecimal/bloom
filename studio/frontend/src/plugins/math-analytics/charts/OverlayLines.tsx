import { chartSeriesToken, runSeriesLabel, type IMathRun } from '../state';
import type { IChartData, IChartSeries } from './IChart';
import { UPlotChart } from './UPlotChart';

export interface IOverlayLinesProps {
  testId: string;
  title: string;
  data: IChartData;
}

/** Generic multi-series overlay wrapper — one `IChart` mount, one series per
 * Compare-selected run, colored by selection order (`chartSeriesToken`). The
 * Compare tab's two overlay charts (RTP convergence, win-distribution shape)
 * both render through this one component; only the `IChartData` they build
 * (`buildRtpConvergenceOverlay` / `buildVolatilityOverlay` below) differs. */
export function OverlayLines({ testId, title, data }: IOverlayLinesProps) {
  return (
    <div data-testid={testId} className="flex min-h-0 flex-col overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <span className="flex-none px-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2">{title}</span>
      <UPlotChart data={data} className="min-h-0 flex-1" />
    </div>
  );
}

/** Overlaid RTP-convergence curves — one line per selected run over its own
 * `profile.rtpConvergence`. Runs can have different-length convergence
 * schedules (e.g. an early-stopped tune samples fewer checkpoints), so series
 * are aligned by checkpoint *index*, not by the real `n` sample-size value —
 * the common case (same tuner config → same sampling schedule) lines up
 * exactly, and a shorter run's series simply stops (gap = null) instead of
 * misaligning against a longer run's later checkpoints. */
export function buildRtpConvergenceOverlay(runs: IMathRun[]): IChartData {
  const maxLen = Math.max(0, ...runs.map((r) => r.profile?.rtpConvergence.length ?? 0));
  const x = Array.from({ length: maxLen }, (_, i) => i);
  const series: IChartSeries[] = runs.map((run, i) => {
    const points = run.profile?.rtpConvergence ?? [];
    return {
      label: runSeriesLabel(run, i),
      values: x.map((_, idx) => points[idx]?.realizedRtp ?? null),
      colorVar: chartSeriesToken(i),
    };
  });
  return { x, series, xLabel: 'Convergence checkpoint', yLabel: 'Realized RTP' };
}

/** Overlaid volatility (win-distribution shape) curves — one line per
 * selected run over its own `profile.distribution` bins, expressed as each
 * bin's share of that run's own total rounds so runs with different total
 * sample counts still compare on shape, not raw magnitude. Aligned by bin
 * *index* — same caveat as `buildRtpConvergenceOverlay` above (bins usually
 * share one scheme across runs of the same game/config). */
export function buildVolatilityOverlay(runs: IMathRun[]): IChartData {
  const maxLen = Math.max(0, ...runs.map((r) => r.profile?.distribution.bins.length ?? 0));
  const x = Array.from({ length: maxLen }, (_, i) => i);
  const series: IChartSeries[] = runs.map((run, i) => {
    const dist = run.profile?.distribution;
    const bins = dist?.bins ?? [];
    const total = dist ? dist.zeroCount + bins.reduce((sum, b) => sum + b.base + b.feature, 0) : 0;
    return {
      label: runSeriesLabel(run, i),
      values: x.map((_, idx) => {
        const bin = bins[idx];
        if (!bin) return null;
        return total > 0 ? (bin.base + bin.feature) / total : 0;
      }),
      colorVar: chartSeriesToken(i),
    };
  });
  return { x, series, xLabel: 'Payout bin', yLabel: 'Share of rounds' };
}
