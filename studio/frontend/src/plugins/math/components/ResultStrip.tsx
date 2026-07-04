import { mathHooks, type ICurationResult, type IMathRun, type ITargetSpec } from '../state';
import { latestOutcome, outcomeVerdict } from '../reducers';
import { applyMath } from '../actions';

/** Pinned to the LATEST outcome (newest generate run vs verify-only result) —
 * never the RunSelector's browsed run. Apply stays human-gated and is enabled
 * even on a failed verdict (warning styling), per spec. */
export function ResultStrip() {
  const s = mathHooks.usePluginState();
  const outcome = latestOutcome({
    runs: s.runs.get({ noproxy: true }) as IMathRun[],
    verifyResult: s.verifyResult.get({ noproxy: true }) as ICurationResult | null,
  });
  const target = s.derivedTarget.get() as ITargetSpec | null;
  const tuneResult = s.tuneResult.get();
  const genStatus = s.genStatus.get();
  const applied = s.applied.get();

  const verdict = outcomeVerdict(outcome);
  const badge = verdict === 'pass' ? 'PASS' : verdict === 'near_miss' ? 'NEAR-MISS' : verdict === 'fail' ? 'FAIL' : verdict === 'error' ? 'ERROR' : '—';
  const badgeClass =
    verdict === 'pass' ? 'text-success' : verdict === 'near_miss' ? 'text-warning' : verdict === 'fail' || verdict === 'error' ? 'text-danger' : 'text-text-3';
  const metrics = outcome?.kind === 'run' ? (outcome.run.verify?.metrics ?? outcome.run.metrics) : (outcome?.result.metrics ?? null);
  const runLocks = outcome?.kind === 'run' ? outcome.run.locks : null;
  const lockedSections = runLocks ? (['reels', 'paytable', 'bonus'] as const).filter((k) => runLocks[k]) : [];
  const failedVerdict = verdict === 'fail' || verdict === 'error';

  return (
    <div className="flex-none border-t border-hairline p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-text-2">Verdict</span>
        <span data-testid="result-verdict" className={`text-sm font-semibold ${badgeClass}`}>
          {badge}
        </span>
        {lockedSections.length > 0 && (
          <span data-testid="result-lock-chips" className="text-text-3">
            locked: {lockedSections.join(', ')}
          </span>
        )}
        <button
          data-testid="apply-button"
          onClick={() => void applyMath()}
          disabled={!tuneResult?.tunedModel || genStatus === 'tuning' || genStatus === 'verifying'}
          className={`ml-auto rounded px-3 py-1 text-sm ${
            failedVerdict ? 'border border-warning text-warning' : 'text-text-1 hover:bg-raised-hover'
          } disabled:text-text-3`}
        >
          Apply
        </button>
      </div>
      {metrics && (
        <table className="mt-1 text-text-1">
          <tbody>
            <tr>
              <td className="pr-4 text-text-2">Measured RTP</td>
              <td data-testid="metric-rtp">{metrics.rtp.toFixed(4)}</td>
              <td className="pl-3 text-text-3">
                {target ? `band ${(target.rtp_target - target.rtp_tolerance).toFixed(3)}–${(target.rtp_target + target.rtp_tolerance).toFixed(3)}` : ''}
              </td>
            </tr>
            <tr>
              <td className="pr-4 text-text-2">Volatility</td>
              <td>{metrics.volatility.toFixed(3)}</td>
              <td className="pl-3 text-text-3">
                {target ? `band ${target.volatility_min}–${target.volatility_max >= 1e9 ? '∞' : target.volatility_max}` : ''}
              </td>
            </tr>
            <tr>
              <td className="pr-4 text-text-2">Hit frequency</td>
              <td>{metrics.hitFrequency.toFixed(4)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
      {applied && (
        <p data-testid="math-applied" className="mt-1 text-success">
          Applied — Game Config now reflects the tuned model.
        </p>
      )}
    </div>
  );
}
