import { mathHooks, type ICurationResult, type IMathRun, type ITargetSpec } from '../state';
import { latestOutcome, outcomeVerdict } from '../reducers';
import { applyMath } from '../actions';

/** Pinned to the LATEST outcome (newest generate run vs verify-only result) —
 * never the RunSelector's browsed run. Apply stays human-gated and is enabled
 * even on a failed verdict (warning styling), per spec. While a tune / verify /
 * cancel is in flight the strip shows a neutral RUNNING…/CANCELLING… badge and
 * hides the previous outcome entirely (spec:
 * docs/superpowers/specs/2026-07-05-math-verdict-inflight-design.md). */
export function ResultStrip() {
  const s = mathHooks.usePluginState();
  const outcome = latestOutcome({
    runs: s.runs.get({ noproxy: true }) as IMathRun[],
    verifyResult: s.verifyResult.get({ noproxy: true }) as ICurationResult | null,
  });
  const target = s.derivedTarget.get() as ITargetSpec | null;
  const tuneResult = s.tuneResult.get();
  const genStatus = s.genStatus.get();
  const verifyStatus = s.verifyStatus.get();
  const applied = s.applied.get();

  const running = genStatus === 'tuning' || genStatus === 'verifying' || genStatus === 'cancelling' || verifyStatus === 'running';

  const verdict = outcomeVerdict(outcome);
  const badge = running
    ? genStatus === 'cancelling'
      ? 'CANCELLING…'
      : 'RUNNING…'
    : verdict === 'pass'
      ? 'PASS'
      : verdict === 'near_miss'
        ? 'NEAR-MISS'
        : verdict === 'fail'
          ? 'FAIL'
          : verdict === 'error'
            ? 'ERROR'
            : '—';
  const badgeClass = running
    ? 'text-text-2'
    : verdict === 'pass'
      ? 'text-success'
      : verdict === 'near_miss'
        ? 'text-warning'
        : verdict === 'fail' || verdict === 'error'
          ? 'text-danger'
          : 'text-text-3';
  const metrics = outcome?.kind === 'run' ? (outcome.run.verify?.metrics ?? outcome.run.metrics) : (outcome?.result.metrics ?? null);
  const se = metrics?.se ?? null;
  const rtpOutsideBand = !!target && !!metrics && Math.abs(metrics.rtp - target.rtp_target) > target.rtp_tolerance;
  const volOutsideBand = !!target && !!metrics && (metrics.volatility < target.volatility_min || metrics.volatility > target.volatility_max);
  const withinNoise = !running && verdict === 'pass' && se != null && (rtpOutsideBand || volOutsideBand);
  const runLocks = outcome?.kind === 'run' ? outcome.run.locks : null;
  const lockedSections = runLocks ? (['reels', 'paytable', 'bonus'] as const).filter((k) => runLocks[k]) : [];
  const failedVerdict = !running && (verdict === 'fail' || verdict === 'error');

  const stopReason = outcome?.kind === 'run' ? outcome.run.stopReason : null;
  const generations = outcome?.kind === 'run' ? outcome.run.trace.length : 0;
  const stopLabel =
    stopReason === 'feasible'
      ? `target reached in ${generations} generation${generations === 1 ? '' : 's'}`
      : stopReason === 'stagnated'
        ? `stagnated after ${generations} generations`
        : stopReason === 'budget'
          ? `generation budget exhausted (${generations})`
          : null;

  return (
    <div className="flex-none border-t border-hairline p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-text-2">Verdict</span>
        <span data-testid="result-verdict" className={`text-sm font-semibold ${badgeClass}`}>
          {badge}
        </span>
        {!running && stopLabel && (
          <span data-testid="result-stop-reason" className="text-text-3">
            {stopLabel}
          </span>
        )}
        {withinNoise && (
          <span
            data-testid="within-noise"
            title={`Measured outside the target band but within the ±2·SE noise allowance (SE rtp ${se!.rtp.toFixed(4)}). Pass = band miss ≤ 2·SE.`}
            className="text-text-3"
          >
            within noise
          </span>
        )}
        {!running && lockedSections.length > 0 && (
          <span data-testid="result-lock-chips" className="text-text-3">
            locked: {lockedSections.join(', ')}
          </span>
        )}
        <button
          data-testid="apply-button"
          onClick={() => void applyMath()}
          disabled={!tuneResult?.tunedModel || running}
          className={`ml-auto rounded px-3 py-1 text-sm ${
            failedVerdict ? 'border border-warning text-warning' : 'text-text-1 hover:bg-raised-hover'
          } disabled:text-text-3`}
        >
          Apply
        </button>
      </div>
      {!running && metrics && (
        <table className="mt-1 text-text-1">
          <tbody>
            <tr>
              <td className="pr-4 text-text-2">Measured RTP</td>
              <td data-testid="metric-rtp">{metrics.rtp.toFixed(4)}</td>
              <td data-testid="metric-rtp-se" className="pl-1 text-text-3">
                {se ? `±${(2 * se.rtp).toFixed(4)}` : ''}
              </td>
              <td className="pl-3 text-text-3">
                {target ? `band ${(target.rtp_target - target.rtp_tolerance).toFixed(3)}–${(target.rtp_target + target.rtp_tolerance).toFixed(3)}` : ''}
              </td>
            </tr>
            <tr>
              <td className="pr-4 text-text-2">Volatility</td>
              <td>{metrics.volatility.toFixed(3)}</td>
              <td className="pl-1 text-text-3">{se ? `±${(2 * se.volatility).toFixed(3)}` : ''}</td>
              <td className="pl-3 text-text-3">
                {target ? `band ${target.volatility_min}–${target.volatility_max >= 1e9 ? '∞' : target.volatility_max}` : ''}
              </td>
            </tr>
            <tr>
              <td className="pr-4 text-text-2">Hit frequency</td>
              <td>{metrics.hitFrequency.toFixed(4)}</td>
              <td />
              <td />
            </tr>
          </tbody>
        </table>
      )}
      {!running && applied && (
        <p data-testid="math-applied" className="mt-1 text-success">
          Applied — Game Config now reflects the tuned model.
        </p>
      )}
    </div>
  );
}
