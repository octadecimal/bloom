import type { IMathRun } from '../state';
import { RunSelector } from '../components/RunSelector';
import { DeltaTable } from '../components/DeltaTable';
import { OverlayLines, buildRtpConvergenceOverlay, buildVolatilityOverlay } from '../charts/OverlayLines';

export interface ICompareTabProps {
  /** Full run history (for the mounted `RunSelector`), newest-first. */
  runs: IMathRun[];
  /** Compare's multi-select — up to `MAX_COMPARE_SELECTION`, in *selection*
   * order (state.ts). */
  selectedRunIds: string[];
  onToggleRun: (runId: string) => void;
}

/** Resolve `selectedRunIds` to full `IMathRun`s, in *selection order* (not
 * history order — position drives each run's Compare series color via
 * `chartSeriesToken`). `GET /analytics/runs` already returns full
 * `MathRunDoc`s (profile included, `math_run_wire` — Task 8), so no per-run
 * fetch is needed here. A stale id (a run since dropped from history) is
 * silently skipped rather than rendering a gap. */
export function resolveSelectedRuns(runs: IMathRun[], selectedRunIds: string[]): IMathRun[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  return selectedRunIds.map((id) => byId.get(id)).filter((run): run is IMathRun => run != null);
}

/** Compare — cross-run analysis over persisted history (Task 16, Tab 3 of the
 * design spec). The mounted `RunSelector` (multi mode) drives up to
 * `MAX_COMPARE_SELECTION` selections; the resolved runs render as overlaid
 * RTP-convergence + win-distribution-shape curves and side-by-side in a delta
 * table, all colored by the same selection-order identity
 * (`chartSeriesToken`). Fills the pane exactly — no inner scroll
 * (`.bloom-tab-fill`, mirroring MathProfileTab/EvolutionTab). */
export function CompareTab({ runs, selectedRunIds, onToggleRun }: ICompareTabProps) {
  const selectedRuns = resolveSelectedRuns(runs, selectedRunIds);

  return (
    <div data-testid="compare-tab" className="bloom-tab-fill grid grid-cols-[220px_minmax(0,1fr)] gap-2 bg-surface p-2">
      <div className="flex min-h-0 flex-col gap-1 overflow-hidden rounded-md border border-hairline bg-raised p-2">
        <span className="flex-none text-[10px] font-semibold uppercase tracking-wide text-text-2">Runs to compare</span>
        <div className="min-h-0 flex-1 overflow-hidden">
          <RunSelector runs={runs} mode="multi" selectedRunIds={selectedRunIds} onToggle={onToggleRun} />
        </div>
      </div>

      {selectedRuns.length === 0 ? (
        <div data-testid="compare-empty" className="flex min-h-0 items-center justify-center text-xs text-text-3">
          Select up to 5 runs to compare.
        </div>
      ) : (
        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
          <OverlayLines testId="compare-rtp-overlay" title="RTP convergence" data={buildRtpConvergenceOverlay(selectedRuns)} />
          <OverlayLines testId="compare-vol-overlay" title="Win-distribution shape" data={buildVolatilityOverlay(selectedRuns)} />
          <DeltaTable runs={selectedRuns} />
        </div>
      )}
    </div>
  );
}
