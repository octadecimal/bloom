import { chartSeriesToken, MAX_COMPARE_SELECTION, type IMathRun } from '../state';

interface IRunSelectorMultiProps {
  runs: IMathRun[];
  mode: 'multi';
  /** In selection order (not history order) — position drives the color swatch. */
  selectedRunIds: string[];
  onToggle: (runId: string) => void;
  /** Defaults to `MAX_COMPARE_SELECTION` (state.ts). */
  max?: number;
}

interface IRunSelectorSingleProps {
  runs: IMathRun[];
  mode: 'single';
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}

export type IRunSelectorProps = IRunSelectorMultiProps | IRunSelectorSingleProps;

function verdictLabel(verdict: IMathRun['verdict']): string {
  if (verdict === 'pass') return 'Pass';
  if (verdict === 'near_miss') return 'Near-miss';
  return '';
}

/** Run history selector — one component, two modes. "single" backs the pane
 * header's active-run pointer (`selectedRunId`, drives Math Profile); "multi"
 * backs the Compare tab's up-to-`MAX_COMPARE_SELECTION` selection
 * (`selectedRunIds`), color-coding each pick by selection order so the same
 * run reads as the same color in Compare's overlaid charts (Task 16). See
 * docs/superpowers/specs/2026-07-02-math-analytics-dashboard-design.md. */
export function RunSelector(props: IRunSelectorProps) {
  const { runs, mode } = props;

  if (runs.length === 0) {
    return (
      <div data-testid="run-selector-empty" className="p-2 text-xs text-text-3">
        No runs recorded yet.
      </div>
    );
  }

  const max = mode === 'multi' ? (props.max ?? MAX_COMPARE_SELECTION) : undefined;
  const atCap = mode === 'multi' && props.selectedRunIds.length >= (max ?? MAX_COMPARE_SELECTION);

  return (
    <div data-testid="run-selector" role={mode === 'multi' ? 'group' : 'listbox'} aria-label="Run history" className="flex flex-col gap-1">
      {runs.map((run) => {
        const selectionIndex = mode === 'multi' ? props.selectedRunIds.indexOf(run.id) : -1;
        const isSelected = mode === 'multi' ? selectionIndex >= 0 : props.selectedRunId === run.id;
        const disabled = mode === 'multi' && atCap && !isSelected;

        return (
          <button
            key={run.id}
            type="button"
            data-testid={`run-selector-row-${run.id}`}
            disabled={disabled}
            {...(mode === 'multi' ? { 'aria-pressed': isSelected } : { role: 'option', 'aria-selected': isSelected })}
            onClick={() => (mode === 'multi' ? props.onToggle(run.id) : props.onSelect(run.id))}
            className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              isSelected ? 'border-accent/60 bg-raised-hover text-text-1' : 'border-hairline bg-raised text-text-2 hover:bg-raised-hover'
            }`}
          >
            {mode === 'multi' && selectionIndex >= 0 && (
              <span
                data-testid={`run-selector-swatch-${run.id}`}
                className="h-2.5 w-2.5 flex-none rounded-full"
                style={{ background: `var(${chartSeriesToken(selectionIndex)})` }}
              />
            )}
            <span className="flex-1 truncate">{new Date(run.createdAt).toLocaleString()}</span>
            {run.verdict && (
              <span className={`flex-none text-[10px] font-semibold uppercase ${run.verdict === 'pass' ? 'text-success' : 'text-warning'}`}>
                {verdictLabel(run.verdict)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
