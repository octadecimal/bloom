import { useRef, useState } from 'react';
import type { IMathRun, ITuningParams } from '../state';
import { framesFromTrace } from '../reducers';
import { FitnessLandscape } from '../charts/FitnessLandscape';
import { GeneHeatmap } from '../charts/GeneHeatmap';
import { Histogram } from '../charts/Histogram';
import { StatTiles } from '../charts/StatTiles';
import { RtpConvergenceChart } from './MathProfileTab';
import { exportReport, type IExportFormat } from '../lib/exportReport';

export interface IReportTabProps {
  run: IMathRun;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

interface ITileDef {
  testId: string;
  label: string;
  value: string;
}

/** RTP/volatility/hit/max-win headline tiles — the document's summary
 * masthead. Hand-rolled (mirrors StatTiles' visual language), distinct fields
 * from StatTiles' tail metrics below it. */
function SummaryTiles({ run }: { run: IMathRun }) {
  const metrics = run.metrics;
  const maxWin = run.profile?.tail.maxWin ?? 0;
  const tiles: ITileDef[] = [
    { testId: 'summary-rtp', label: 'RTP', value: metrics ? pct(metrics.rtp) : '—' },
    { testId: 'summary-volatility', label: 'Volatility', value: metrics ? metrics.volatility.toFixed(1) : '—' },
    { testId: 'summary-hit-frequency', label: 'Hit frequency', value: metrics ? pct(metrics.hitFrequency) : '—' },
    { testId: 'summary-max-win', label: 'Max win', value: `${maxWin.toFixed(1)}×` },
  ];
  return (
    <div data-testid="report-summary" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.testId} data-testid={tile.testId} className="flex flex-col justify-center rounded-md border border-hairline bg-raised px-3 py-2.5">
          <span className="text-[10px] uppercase tracking-wide text-text-2">{tile.label}</span>
          <span className="text-lg font-semibold text-text-1">{tile.value}</span>
        </div>
      ))}
    </div>
  );
}

interface IConfigRowDef {
  testId: string;
  label: string;
  value: (params: ITuningParams) => string;
}

const CONFIG_ROWS: IConfigRowDef[] = [
  { testId: 'config-master-seed', label: 'Master seed', value: (p) => `${p.masterSeed}` },
  { testId: 'config-population', label: 'Population', value: (p) => `${p.population}` },
  { testId: 'config-max-generations', label: 'Max generations', value: (p) => `${p.maxGenerations}` },
  { testId: 'config-search-candidates', label: 'Search candidates', value: (p) => `${p.searchCandidateCount}` },
  { testId: 'config-final-candidates', label: 'Final candidates', value: (p) => `${p.finalCandidateCount}` },
  { testId: 'config-elitism', label: 'Elitism', value: (p) => `${p.elitism}` },
  { testId: 'config-mutation-rate', label: 'Mutation rate', value: (p) => pct(p.mutationRate) },
  { testId: 'config-crossover-rate', label: 'Crossover rate', value: (p) => pct(p.crossoverRate) },
  { testId: 'config-stagnation-window', label: 'Stagnation window', value: (p) => `${p.stagnationWindow}` },
  { testId: 'config-weight-rtp', label: 'Weight · RTP', value: (p) => `${p.weights.rtp}` },
  { testId: 'config-weight-volatility', label: 'Weight · Volatility', value: (p) => `${p.weights.volatility}` },
  { testId: 'config-weight-hit-rate', label: 'Weight · Hit rate', value: (p) => `${p.weights.hitRate}` },
  { testId: 'config-weight-hit-frequency', label: 'Weight · Hit frequency', value: (p) => `${p.weights.hitFrequency ?? 1}` },
];

/** The tune configuration that produced this run — the `ITuningParams` the
 * GA search, mutation/crossover, and multi-objective weights were set to. */
function ConfigSection({ params }: { params: ITuningParams }) {
  return (
    <div data-testid="report-config" className="rounded-md border border-hairline bg-raised p-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-2">Config used</span>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {CONFIG_ROWS.map((row) => (
          <div key={row.testId} data-testid={row.testId} className="flex flex-col">
            <dt className="text-[10px] text-text-3">{row.label}</dt>
            <dd className="text-xs text-text-1">{row.value(params)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const FORMATS: { id: IExportFormat; label: string }[] = [
  { id: 'pdf', label: 'PDF' },
  { id: 'png', label: 'PNG' },
];

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Report — the one intentionally SCROLLABLE tab (Task 17, Tab 4 of the design
 * spec): the whole run stacked top-to-bottom as a single document (summary →
 * GA evolution → gene convergence → win distribution → tail/risk → RTP
 * convergence → config used), with an Export PDF/PNG action pinned in the
 * header. Every chart below is the SAME component the Evolution/Math Profile
 * tabs use — Report composes, it doesn't re-derive. Unlike those tabs' fixed
 * `.bloom-tab-fill` (fill-to-pane, no scroll) root, this root scrolls
 * (`overflow-y-auto`) because a stacked document has no natural fill height —
 * see docs/design-language.md's fit rule and its one documented exception. */
export function ReportTab({ run }: IReportTabProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [format, setFormat] = useState<IExportFormat>('pdf');
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    if (!contentRef.current || exporting) return;
    setExporting(true);
    try {
      const blob = await exportReport(contentRef.current, format);
      downloadBlob(blob, `math-report-${run.id}.${format}`);
    } finally {
      setExporting(false);
    }
  }

  if (!run.profile) {
    return (
      <div data-testid="report-no-data" className="flex h-full items-center justify-center bg-surface text-text-2">
        This run has no profile data yet.
      </div>
    );
  }

  const profile = run.profile;
  const frames = framesFromTrace(run);
  const selectedGeneration = frames.length > 0 ? frames[frames.length - 1].generation : ('live' as const);

  return (
    <div data-testid="report-tab" className="h-full min-h-0 overflow-y-auto bg-surface">
      <div className="sticky top-0 z-10 flex flex-none items-center justify-between border-b border-hairline bg-surface p-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-2">Report</span>
        <div className="flex items-center gap-2">
          <select
            data-testid="export-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as IExportFormat)}
            className="rounded border border-hairline bg-raised px-1.5 py-1 text-[11px] text-text-1"
          >
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <button
            data-testid="export-button"
            onClick={() => void handleExport()}
            disabled={exporting}
            className="rounded border border-hairline bg-raised px-2.5 py-1 text-[11px] text-text-1 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>

      <div ref={contentRef} className="flex flex-col gap-3 p-3">
        <SummaryTiles run={run} />

        <div data-testid="report-evolution" className="grid h-64">
          <FitnessLandscape frames={frames} selectedGeneration={selectedGeneration} />
        </div>

        <div data-testid="report-gene-convergence" className="grid h-56">
          <GeneHeatmap frames={frames} selectedGeneration={selectedGeneration} />
        </div>

        <div data-testid="report-win-distribution" className="h-64 rounded-md border border-hairline bg-raised">
          <Histogram bins={profile.distribution.bins} zeroCount={profile.distribution.zeroCount} />
        </div>

        <div data-testid="report-tail" className="h-40">
          <StatTiles tail={profile.tail} />
        </div>

        <div data-testid="report-rtp-convergence" className="grid h-64">
          <RtpConvergenceChart profile={profile} metrics={run.metrics} />
        </div>

        <ConfigSection params={run.params} />
      </div>
    </div>
  );
}
