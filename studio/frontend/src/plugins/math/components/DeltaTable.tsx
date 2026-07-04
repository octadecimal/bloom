import { chartSeriesToken, runSeriesLabel, type IMathRun } from '../state';

export interface IDeltaTableProps {
  runs: IMathRun[];
}

function pct(x: number | null | undefined): string {
  return x == null ? '—' : `${(x * 100).toFixed(1)}%`;
}

function num(x: number | null | undefined, digits: number): string {
  return x == null ? '—' : x.toFixed(digits);
}

function multiplier(x: number | null | undefined): string {
  return x == null ? '—' : `${x.toFixed(1)}×`;
}

/** Generations-to-converge — derived from the persisted trace, not a stored
 * field: the last trace entry's (0-indexed) `generation` + 1, i.e. the count
 * of generations the tune actually ran. 0 for a run with no trace yet. */
export function generationsToConverge(run: IMathRun): number {
  const last = run.trace[run.trace.length - 1];
  return last ? last.generation + 1 : 0;
}

function verdictLabel(verdict: IMathRun['verdict']): string {
  if (verdict === 'pass') return 'Pass';
  if (verdict === 'near_miss') return 'Near-miss';
  return '—';
}

interface IRowDef {
  testId: string;
  label: string;
  value: (run: IMathRun) => string;
}

const ROWS: IRowDef[] = [
  { testId: 'delta-row-rtp', label: 'RTP', value: (run) => pct(run.metrics?.rtp) },
  { testId: 'delta-row-volatility', label: 'Volatility', value: (run) => num(run.metrics?.volatility, 1) },
  { testId: 'delta-row-hit-frequency', label: 'Hit frequency', value: (run) => pct(run.metrics?.hitFrequency) },
  { testId: 'delta-row-max-win', label: 'Max win', value: (run) => multiplier(run.profile?.tail.maxWin) },
  { testId: 'delta-row-generations', label: 'Generations to converge', value: (run) => `${generationsToConverge(run)}` },
  { testId: 'delta-row-verdict', label: 'Verdict', value: (run) => verdictLabel(run.verdict) },
];

/** Compare's delta table (Task 16) — one column per selected run (in
 * selection order), six rows of headline metrics. Each header cell is tinted
 * with that run's Compare series color (`chartSeriesToken`, same index the
 * overlay charts and the `RunSelector` swatches use) so a run reads as the
 * same identity everywhere in the tab. */
export function DeltaTable({ runs }: IDeltaTableProps) {
  if (runs.length === 0) {
    return (
      <div data-testid="delta-table" className="flex min-h-0 items-center justify-center rounded-md border border-hairline bg-raised p-2 text-xs text-text-3">
        Select runs to compare.
      </div>
    );
  }

  return (
    <div data-testid="delta-table" className="min-h-0 overflow-hidden rounded-md border border-hairline bg-raised p-2">
      <table className="w-full table-fixed border-collapse text-xs">
        <thead>
          <tr>
            <th className="w-36 px-1.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-text-2">Metric</th>
            {runs.map((run, i) => (
              <th
                key={run.id}
                data-testid={`delta-col-${run.id}`}
                title={runSeriesLabel(run, i)}
                className="border-t-2 px-1.5 py-1 text-left text-[10px] font-semibold"
                style={{ borderColor: `var(${chartSeriesToken(i)})`, color: `var(${chartSeriesToken(i)})` }}
              >
                {new Date(run.createdAt).toLocaleString()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.testId} data-testid={row.testId}>
              <td className="px-1.5 py-1 text-text-2">{row.label}</td>
              {runs.map((run) => (
                <td key={run.id} data-testid={`${row.testId}-${run.id}`} className="px-1.5 py-1 text-text-1">
                  {row.value(run)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
