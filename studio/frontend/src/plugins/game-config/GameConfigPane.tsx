import type { ReactElement } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Lock, LockOpen } from 'lucide-react';
import { toggleLock } from './actions';
import { gameConfigHooks, type ISectionLocks } from './state';
import type { ISlotModel } from './model';
import { deriveStats } from './reducers';
import { validateModel, type GcTab } from './validate';
import { StatusPill, type StatusTone } from '../../components/ui/StatusPill';
import { SymbolsSection } from './sections/SymbolsSection';
import { ReelsSection } from './sections/ReelsSection';
import { PaylinesSection } from './sections/PaylinesSection';
import { PaytableSection } from './sections/PaytableSection';
import { BonusSection } from './sections/BonusSection';
import { JsonSection } from './sections/JsonSection';

const TABS: { key: GcTab; label: string }[] = [
  { key: 'symbols', label: 'Symbols' },
  { key: 'reels', label: 'Reels' },
  { key: 'paylines', label: 'Paylines' },
  { key: 'paytable', label: 'Paytable' },
  { key: 'bonus', label: 'Bonus' },
  { key: 'json', label: 'JSON' },
];

const LOCKABLE: Partial<Record<GcTab, keyof ISectionLocks>> = {
  reels: 'reels',
  paytable: 'paytable',
  bonus: 'bonus',
};

const SECTIONS: Record<GcTab, () => ReactElement> = {
  symbols: SymbolsSection,
  reels: ReelsSection,
  paylines: PaylinesSection,
  paytable: PaytableSection,
  bonus: BonusSection,
  json: JsonSection,
};

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-lg border border-border bg-raised px-2.5 py-1">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div data-testid={testId} className="text-sm text-text-1">
        {value}
      </div>
    </div>
  );
}

export function GameConfigPane(_props: IDockviewPanelProps) {
  const s = gameConfigHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  const model = s.model.get({ noproxy: true }) as ISlotModel | null;

  if (!activeGameId || !model) {
    return (
      <div data-testid="gc-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to edit its core configuration.
      </div>
    );
  }

  const stats = deriveStats(model);
  const issues = validateModel(model);
  const activeTab = s.activeTab.get();
  const locks = s.locks.get({ noproxy: true }) as ISectionLocks;
  const sync = s.sync.get();
  const syncLabel =
    sync === 'saving' ? 'saving…' : sync === 'external' ? `updated externally · ${s.externalSource.get() ?? ''}` : sync === 'error' ? 'save failed' : 'saved';
  const syncTone: StatusTone = sync === 'external' ? 'warning' : sync === 'error' ? 'danger' : sync === 'saved' ? 'success' : 'neutral';
  const Section = SECTIONS[activeTab];

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-hairline p-2">
        <Stat label="Window" value={`${stats.rows} × ${stats.reelCount}`} testId="gc-stat-window" />
        <Stat label="Symbols" value={String(stats.symbolCount)} testId="gc-stat-symbols" />
        <Stat label="Lines" value={String(stats.paylineCount)} testId="gc-stat-lines" />
        <Stat label="Strips" value={stats.stripLengths.join(', ')} testId="gc-stat-strips" />
        <span className="ml-auto inline-flex items-center gap-2">
          {issues.length > 0 && (
            <StatusPill data-testid="gc-issues-pill" tone="warning">
              {issues.length} issue{issues.length === 1 ? '' : 's'}
            </StatusPill>
          )}
          <StatusPill data-testid="gc-sync-pill" tone={syncTone}>
            {syncLabel}
          </StatusPill>
        </span>
      </div>

      <div className="flex items-center border-b border-hairline px-2">
        {TABS.map((t) => {
          const count = issues.filter((i) => i.tab === t.key).length;
          const active = t.key === activeTab;
          const lockKey = LOCKABLE[t.key];
          return (
            <button
              key={t.key}
              data-testid={`gc-tab-${t.key}`}
              onClick={() => s.activeTab.set(t.key)}
              className={`relative flex items-center gap-1.5 px-3 py-1.5 text-xs ${
                active ? 'border-b-2 border-primary text-text-1' : 'text-text-2 hover:text-text-1'
              }`}
            >
              {t.label}
              {count > 0 && <span data-testid={`gc-tab-dot-${t.key}`} className="h-1.5 w-1.5 rounded-full bg-warning" />}
              {lockKey && locks[lockKey] && <Lock data-testid={`gc-tab-lock-${t.key}`} className="h-3 w-3 text-text-3" />}
            </button>
          );
        })}
        {(() => {
          const lockKey = LOCKABLE[activeTab];
          if (!lockKey) return null;
          const locked = locks[lockKey];
          return (
            <button
              data-testid={`gc-lock-${lockKey}`}
              title={
                locked
                  ? 'Locked against automation (GA, templates) — still editable by hand. Click to unlock.'
                  : 'Lock this section against automation (GA, templates). Humans can always edit.'
              }
              onClick={() => toggleLock(lockKey)}
              className={`ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs ${locked ? 'text-warning' : 'text-text-2'} hover:bg-raised hover:text-text-1`}
            >
              {locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
              {locked ? 'Locked' : 'Lock'}
            </button>
          );
        })()}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <Section />
      </div>
    </div>
  );
}
