import { gameConfigHooks } from '../state';
import { applyModelFromJson } from '../actions';

export function JsonSection() {
  const s = gameConfigHooks.usePluginState();
  const jsonError = s.jsonError.get();

  return (
    <div data-testid="gc-section-json" className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Model JSON</span>
        <button
          data-testid="gc-json-apply"
          onClick={() => applyModelFromJson(s.jsonDraft.get())}
          className="ml-auto rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary-hover"
        >
          Apply
        </button>
      </div>
      {jsonError && (
        <p data-testid="gc-json-error" className="text-xs text-danger">
          {jsonError}
        </p>
      )}
      <textarea
        data-testid="gc-json-textarea"
        value={s.jsonDraft.get()}
        onChange={(e) => s.jsonDraft.set(e.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none rounded border border-border bg-canvas p-2 font-mono text-xs text-text-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}
