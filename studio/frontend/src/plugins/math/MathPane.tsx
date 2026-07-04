import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { mathHooks, selectedRun, type IMathState, type IGenFrame, type IMathRun } from './state';
import { MathProfileTab } from './tabs/MathProfileTab';
import { EvolutionTab } from './tabs/EvolutionTab';
import { CompareTab } from './tabs/CompareTab';
import { ReportTab } from './tabs/ReportTab';
import { TargetStrip } from './components/TargetStrip';
import { GenerateBar } from './components/GenerateBar';
import { ResultStrip } from './components/ResultStrip';
import { AdvancedSection } from './components/AdvancedSection';
import { refreshRuns, scrub, toggleRunSelected } from './actions';
import { refreshTuneResult } from './sync';

type ITabId = 'profile' | 'evolution' | 'compare' | 'report';

interface ITabDef {
  id: ITabId;
  label: string;
  // Math Profile (Task 10), Evolution (Task 13), Compare (Task 16), and
  // Report (Task 17) are all built now — every tab is enabled.
  enabled: boolean;
}

const TABS: ITabDef[] = [
  { id: 'profile', label: 'Math Profile', enabled: true },
  { id: 'evolution', label: 'Evolution', enabled: true },
  { id: 'compare', label: 'Compare', enabled: true },
  { id: 'report', label: 'Report', enabled: true },
];

/** The unified Math pane shell — a header strip over a tab bar, mirroring the
 * cockpit shape from docs/superpowers/specs/2026-07-02-math-analytics-dashboard-design.md.
 * Generate/verify/apply live in the strips around these tabs; the tabs
 * themselves stay read-only analytics. */
export function MathPane(_props: IDockviewPanelProps) {
  const s = mathHooks.usePluginState();
  const [activeTab, setActiveTab] = useState<ITabId>('profile');
  const activeGameId = s.activeGameId.get();

  // Pane (re-)open: refresh what a closed pane may have missed — the run history
  // and the pending tuned model (issue #82 / PR #99 port). refreshTuneResult
  // no-ops while a generate is streaming.
  useEffect(() => {
    if (activeGameId) {
      void refreshRuns(activeGameId);
      void refreshTuneResult(activeGameId);
    }
  }, [activeGameId]);

  if (!activeGameId) {
    return (
      <div data-testid="math-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to tune its math toward the GDD intent.
      </div>
    );
  }

  const loadStatus = s.loadStatus.get();
  const run = selectedRun(s.get() as IMathState);
  const runs = s.runs.get() as IMathRun[];
  const selectedRunIds = s.selectedRunIds.get() as string[];
  const frames = s.frames.get() as IGenFrame[];
  const selectedGeneration = s.selectedGeneration.get();
  // Evolution has data whenever frames exist — which happens before any run has
  // ever persisted (frames stream live via `analytics_progress` during a game's
  // very first tune) as well as post-hoc (frames replayed from a frozen run's
  // trace). Math Profile, by contrast, only ever has data once a run exists.
  const hasEvolutionData = frames.length > 0;

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex flex-none items-center justify-between border-b border-hairline p-2">
        <span className="text-sm text-text-1">Math</span>
        {run && (
          <span className="text-xs text-text-3">
            {run.verdict === 'pass' ? 'PASS' : run.verdict === 'near_miss' ? 'NEAR-MISS' : ''} · {new Date(run.createdAt).toLocaleString()}
          </span>
        )}
      </div>

      <TargetStrip />
      <GenerateBar />

      <div role="tablist" className="flex flex-none gap-1 border-b border-hairline px-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            data-testid={`analytics-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            disabled={!tab.enabled}
            onClick={() => tab.enabled && setActiveTab(tab.id)}
            className={`border-b-2 px-2.5 py-1.5 text-xs ${
              activeTab === tab.id ? 'border-accent text-text-1' : 'border-transparent text-text-3'
            } disabled:cursor-not-allowed disabled:text-text-3/60`}
          >
            {tab.label}
            {!tab.enabled && <span className="ml-1 text-[9px] uppercase text-text-3">soon</span>}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {loadStatus === 'loading' && (
          <div data-testid="analytics-loading" className="flex h-full items-center justify-center text-text-2">
            Loading runs…
          </div>
        )}
        {loadStatus !== 'loading' && !run && !hasEvolutionData && (
          <div data-testid="analytics-no-runs" className="flex h-full items-center justify-center text-text-2">
            No tune runs recorded for this game yet.
          </div>
        )}
        {loadStatus !== 'loading' && run && activeTab === 'profile' && <MathProfileTab run={run} />}
        {loadStatus !== 'loading' && activeTab === 'evolution' && <EvolutionTab frames={frames} selectedGeneration={selectedGeneration} onScrub={scrub} />}
        {loadStatus !== 'loading' && activeTab === 'compare' && <CompareTab runs={runs} selectedRunIds={selectedRunIds} onToggleRun={toggleRunSelected} />}
        {loadStatus !== 'loading' && run && activeTab === 'report' && <ReportTab run={run} />}
      </div>

      <ResultStrip />
      <AdvancedSection />
    </div>
  );
}
