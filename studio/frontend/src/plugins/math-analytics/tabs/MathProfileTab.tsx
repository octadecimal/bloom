import type { IMathRun, IMetrics, IRunProfile } from '../state';
import { Histogram, binLabel } from '../charts/Histogram';
import { StatTiles } from '../charts/StatTiles';
import { UPlotChart } from '../charts/UPlotChart';
import type { IChartData } from '../charts/IChart';

export interface IMathProfileTabProps {
  run: IMathRun;
}

/** Math Profile — the final, settled model (post-hoc). Composes the five Math
 * Profile charts from the design spec: the hero win-distribution histogram, tail
 * stat tiles, RTP composition, hit-rate by payout band, and RTP convergence.
 * Fills the pane exactly — no inner scroll (see docs/design-language.md's fit
 * rule and the .bloom-tab-fill utility). */
export function MathProfileTab({ run }: IMathProfileTabProps) {
  if (!run.profile) {
    return (
      <div data-testid="math-profile-no-data" className="bloom-tab-fill flex items-center justify-center bg-surface text-text-2">
        This run has no profile data yet.
      </div>
    );
  }

  const profile = run.profile;

  return (
    <div data-testid="math-profile-tab" className="bloom-tab-fill grid grid-rows-[minmax(0,1.35fr)_minmax(0,1fr)] gap-2 bg-surface p-2">
      <Histogram bins={profile.distribution.bins} zeroCount={profile.distribution.zeroCount} />
      <div className="grid min-h-0 grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTiles tail={profile.tail} />
        <RtpComposition metrics={run.metrics} verdict={run.verdict} />
        <HitByBand profile={profile} />
        <RtpConvergenceChart profile={profile} metrics={run.metrics} />
      </div>
    </div>
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function VerdictPill({ verdict }: { verdict: IMathRun['verdict'] }) {
  if (!verdict) return null;
  const cls = verdict === 'pass' ? 'text-success' : 'text-warning';
  return <span className={`text-[10px] font-semibold uppercase ${cls}`}>{verdict === 'pass' ? 'Pass' : 'Near-miss'}</span>;
}

/** Base vs feature RTP split, realized total, and verdict. Hand-rolled (a bespoke
 * mark, not a line/band series), matching the histogram's base/feature roles so
 * the two charts read as one story. */
function RtpComposition({ metrics, verdict }: { metrics: IMetrics | null; verdict: IMathRun['verdict'] }) {
  if (!metrics) {
    return (
      <div
        data-testid="rtp-composition"
        className="flex min-h-0 items-center justify-center rounded-md border border-hairline bg-raised p-2 text-xs text-text-3"
      >
        No metrics
      </div>
    );
  }
  const total = metrics.rtp > 0 ? metrics.rtp : metrics.baseRtp + metrics.featureRtp || 1;
  const baseShare = Math.max(0, metrics.baseRtp / total);
  const featureShare = Math.max(0, metrics.featureRtp / total);

  return (
    <div data-testid="rtp-composition" className="flex min-h-0 flex-col gap-1.5 overflow-hidden rounded-md border border-hairline bg-raised p-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-2">RTP composition</span>
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-semibold text-text-1">{pct(metrics.rtp)}</span>
        <VerdictPill verdict={verdict} />
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-canvas">
        <div style={{ width: `${baseShare * 100}%`, background: 'var(--chart-base)' }} />
        <div style={{ width: `${featureShare * 100}%`, background: 'var(--chart-feature)' }} />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-text-2">
        <span>Base {pct(metrics.baseRtp)}</span>
        <span>Feature {pct(metrics.featureRtp)}</span>
      </div>
    </div>
  );
}

/** Probability mass per payout-multiplier bucket — derived from the same
 * histogram bins as the hero chart, expressed as a share of all rounds. */
function HitByBand({ profile }: { profile: IRunProfile }) {
  const total = profile.distribution.zeroCount + profile.distribution.bins.reduce((sum, b) => sum + b.base + b.feature, 0);
  return (
    <div data-testid="hit-by-band" className="flex min-h-0 flex-col gap-1 overflow-hidden rounded-md border border-hairline bg-raised p-2.5">
      <span className="flex-none text-[10px] font-semibold uppercase tracking-wide text-text-2">Hit rate by band</span>
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 overflow-hidden">
        {profile.distribution.bins.map((bin, i) => {
          const count = bin.base + bin.feature;
          const share = total > 0 ? count / total : 0;
          return (
            <div key={i} className="flex items-center gap-1.5 text-[9px] text-text-2">
              <span className="w-14 flex-none truncate text-right">{binLabel(bin)}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-canvas">
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, share * 100)}%`, background: 'var(--chart-series-1)' }} />
              </div>
              <span className="w-10 flex-none text-text-3">{(share * 100).toFixed(2)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Realized RTP settling onto the run's final measured RTP as the sample grows —
 * the "trust the math" chart. Rendered through the `IChart` seam (uPlot). The
 * wire carries no per-point variance, so rather than fabricate a statistical
 * confidence band, the final RTP is drawn as a dashed target-band reference line
 * (see docs/superpowers/plans/2026-07-02-math-analytics-dashboard.md — a real
 * confidence band is future work once the kernel exposes convergence variance).
 * Exported for reuse by ReportTab (Task 17). */
export function RtpConvergenceChart({ profile, metrics }: { profile: IRunProfile; metrics: IMetrics | null }) {
  const points = profile.rtpConvergence;
  const finalRtp = metrics?.rtp ?? points[points.length - 1]?.realizedRtp ?? 0;
  const data: IChartData = {
    x: points.map((p) => p.n),
    series: [
      { label: 'Realized RTP', values: points.map((p) => p.realizedRtp), colorVar: '--chart-series-1' },
      { label: 'Final RTP', values: points.map(() => finalRtp), colorVar: '--chart-target-band', dash: true },
    ],
    xLabel: 'Sample size (n)',
    yLabel: 'Realized RTP',
    logX: true,
  };
  return (
    <div data-testid="rtp-convergence" className="flex min-h-0 flex-col overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <span className="flex-none px-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2">RTP convergence</span>
      <UPlotChart data={data} className="min-h-0 flex-1" />
    </div>
  );
}
