import type { IDockviewPanelProps } from 'dockview-react';
import type { ReactElement } from 'react';
import { gameStructureHooks, type GsTab } from './state';
import type { IGameDefinition } from './model';
import { buildPackage } from './actions';
import { engineOrigin } from '../game/config';
import { MechanicsSection } from './sections/MechanicsSection';
import { StatesSection } from './sections/StatesSection';
import { TransitionsSection } from './sections/TransitionsSection';
import { JsonSection } from './sections/JsonSection';
import { StatusPill, type StatusTone } from '../../components/ui/StatusPill';

const TABS: { key: GsTab; label: string }[] = [
  { key: 'mechanics', label: 'Mechanics' },
  { key: 'states', label: 'States' },
  { key: 'transitions', label: 'Transitions' },
  { key: 'json', label: 'JSON' },
];

const SECTIONS: Record<GsTab, () => ReactElement> = {
  mechanics: MechanicsSection,
  states: StatesSection,
  transitions: TransitionsSection,
  json: JsonSection,
};

export function GameStructurePane(_props: IDockviewPanelProps) {
  const s = gameStructureHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  const def = s.definition.get({ noproxy: true }) as IGameDefinition | null;

  if (!activeGameId || !def) {
    return (
      <div data-testid="gs-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to edit its structure.
      </div>
    );
  }

  const activeTab = s.activeTab.get();
  const sync = s.sync.get();
  const syncLabel =
    sync === 'saving' ? 'saving…' : sync === 'external' ? `updated externally · ${s.externalSource.get() ?? ''}` : sync === 'error' ? 'save failed' : 'saved';
  const syncTone: StatusTone = sync === 'external' ? 'warning' : sync === 'error' ? 'danger' : sync === 'saved' ? 'success' : 'neutral';

  const validation = s.validation.get({ noproxy: true });
  const vLabel =
    validation.status === 'checking'
      ? 'checking…'
      : validation.status === 'errors'
        ? `${validation.errors.length} issue${validation.errors.length === 1 ? '' : 's'}`
        : validation.status === 'ok'
          ? 'valid'
          : '—';
  const vTone: StatusTone = validation.status === 'errors' ? 'danger' : validation.status === 'ok' ? 'success' : 'neutral';

  const build = s.build.get({ noproxy: true });
  const gameId = activeGameId; // non-null past the guard

  const Section = SECTIONS[activeTab];

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-hairline p-2">
        <span className="ml-auto inline-flex items-center gap-2">
          <StatusPill data-testid="gs-validation-pill" tone={vTone}>
            {vLabel}
          </StatusPill>
          <button
            data-testid="gs-build"
            onClick={() => void buildPackage()}
            disabled={build.status === 'building'}
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
          >
            {build.status === 'building' ? 'Building…' : 'Build'}
          </button>
          {build.status === 'done' && build.metrics && (
            <span data-testid="gs-metrics" className="flex items-center gap-2 text-[11px] text-text-2">
              <span data-testid="gs-metric-rtp">rtp {build.metrics.rtp.toFixed(3)}</span>
              <span data-testid="gs-metric-hit-rate">hit {(build.metrics.hitRate * 100).toFixed(1)}%</span>
              <span data-testid="gs-metric-max-win">max {build.metrics.maxWinX}x</span>
              <span data-testid="gs-metric-visits">
                {Object.entries(build.metrics.stateVisits)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(' ')}
              </span>
            </span>
          )}
          {build.status === 'error' && (
            <span data-testid="gs-build-error" className="text-[11px] text-danger">
              {build.errors[0]}
            </span>
          )}
          {build.status === 'done' && (
            <a
              data-testid="gs-play"
              href={`${engineOrigin()}/?package=${encodeURIComponent(gameId)}`}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
            >
              Play ↗
            </a>
          )}
          <StatusPill data-testid="gs-sync-pill" tone={syncTone}>
            {syncLabel}
          </StatusPill>
        </span>
      </div>

      <div className="flex items-center border-b border-hairline px-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            data-testid={`gs-tab-${t.key}`}
            onClick={() => s.activeTab.set(t.key)}
            className={`relative flex items-center gap-1.5 px-3 py-1.5 text-xs ${
              t.key === activeTab ? 'border-b-2 border-primary text-text-1' : 'text-text-2 hover:text-text-1'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {validation.status === 'errors' && (
        <div data-testid="gs-validation-errors" className="border-b border-hairline bg-raised px-3 py-1.5">
          {validation.errors.map((e, i) => (
            <p key={i} className="font-mono text-[11px] text-danger">
              {e}
            </p>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <Section />
      </div>
    </div>
  );
}
