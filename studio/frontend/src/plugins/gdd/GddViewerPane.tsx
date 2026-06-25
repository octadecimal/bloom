import type { IDockviewPanelProps } from 'dockview-react';
import { gddHooks } from './state';
import { Markdown } from '@/components/ui/Markdown';

const STATUS_LABEL: Record<string, string> = {
  empty: 'empty',
  drafted: 'drafted',
  needs_input: 'needs input',
  complete: 'complete',
};

export function GddViewerPane(_props: IDockviewPanelProps) {
  const s = gddHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  const docs = s.docs.get();
  const selected = s.selectedAspect.get();

  if (!activeGameId) {
    return (
      <div data-testid="gdd-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to see its Game Design Document.
      </div>
    );
  }

  const current = docs.find((d) => d.aspect === selected) ?? docs[0];

  return (
    <div className="flex h-full bg-surface">
      <ul className="w-56 flex-none overflow-auto border-r border-hairline p-1">
        {docs.map((d) => (
          <li key={d.aspect}>
            <button
              data-testid={`gdd-aspect-${d.aspect}`}
              onClick={() => s.selectedAspect.set(d.aspect)}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm text-text-1 hover:bg-raised-hover"
            >
              <span>{d.title}</span>
              <span data-testid={`gdd-status-${d.aspect}`} className={d.status === 'needs_input' ? 'text-accent-text' : 'text-text-3'}>
                {STATUS_LABEL[d.status]}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex-1 overflow-auto p-3">
        <Markdown source={current?.body || ''} />
      </div>
    </div>
  );
}
