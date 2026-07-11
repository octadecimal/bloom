import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { gddHooks } from './state';
import { saveIntentFields } from './actions';
import { getSlotModel, realizeSlotModel } from './restClient';
import { setModelChangedHandler } from './socketClient';
import { INTENT_FIELDS } from './intentFields';
import { Markdown } from '@/components/ui/Markdown';
import { MirrorSection, type IMirrorModel } from './MirrorSection';

const STATUS_LABEL: Record<string, string> = {
  empty: 'empty',
  drafted: 'drafted',
  needs_input: 'needs input',
  complete: 'complete',
};

// Aspects whose realized shape can drift out of sync with the GDD (spec
// 2026-07-09 §5); these are the only ones offered the re-realize affordance.
const SHAPE_ASPECTS = new Set(['math-model', 'symbols-reels', 'bonus-features']);
const MIRROR_ASPECTS = new Set(['paytable', 'bonus-features']);

function IntentEditor({ gameId, aspect, data }: { gameId: string; aspect: string; data: Record<string, unknown> }) {
  const fields = INTENT_FIELDS[aspect];
  const initial = Object.fromEntries(fields.map((f) => [f.key, String(data[f.key] ?? '')]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  async function onSave() {
    setSaving(true);
    setStatus('');
    try {
      // Send a field if it is non-empty OR it changed from its initial value
      // (so clearing a previously-set field sends '' and actually clears it).
      const patch = Object.fromEntries(fields.map((f) => [f.key, values[f.key]]).filter(([k, v]) => v !== '' || v !== initial[k as string]));
      const res = await saveIntentFields(gameId, aspect, patch);
      setStatus(res.rebuilt ? 'Reflowed scene.' : 'Saved.');
    } catch {
      setStatus('Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="gdd-intent-editor" className="mb-4 flex flex-col gap-3 border-b border-hairline pb-4">
      {fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1 text-sm text-text-2">
          <span>{f.label}</span>
          {f.control === 'select' ? (
            <select
              data-testid={`gdd-intent-${f.key}`}
              value={values[f.key] || ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className="rounded border border-hairline bg-raised px-2 py-1 text-text-1"
            >
              <option value="">—</option>
              {f.options!.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <textarea
              data-testid={`gdd-intent-${f.key}`}
              value={values[f.key] || ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              rows={3}
              className="rounded border border-hairline bg-raised px-2 py-1 text-text-1"
            />
          )}
        </label>
      ))}
      <div className="flex items-center gap-3">
        <button
          data-testid="gdd-intent-save"
          onClick={onSave}
          disabled={saving}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {status && (
          <span data-testid="gdd-intent-status" className="text-sm text-text-3">
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

export function GddViewerPane(_props: IDockviewPanelProps) {
  const s = gddHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  const docs = s.docs.get();
  const selected = s.selectedAspect.get();

  const [slotModel, setSlotModel] = useState<IMirrorModel | null>(null);
  const [shapeStale, setShapeStale] = useState(false);
  const [realizing, setRealizing] = useState(false);
  const [realizeError, setRealizeError] = useState<string | null>(null);

  useEffect(() => {
    setSlotModel(null);
    setShapeStale(false);
    setRealizeError(null);
    if (!activeGameId) return;
    const gameId = activeGameId;
    let cancelled = false;
    async function refresh() {
      try {
        const doc = await getSlotModel(gameId);
        if (cancelled) return;
        setSlotModel(doc.model);
        setShapeStale(doc.shapeStale);
      } catch {
        // transient fetch failure: keep the last-known mirror rather than blanking it
      }
    }
    void refresh();
    setModelChangedHandler((p) => {
      if (p.gameId === gameId) void refresh();
    });
    return () => {
      cancelled = true;
      setModelChangedHandler(null);
    };
  }, [activeGameId]);

  if (!activeGameId) {
    return (
      <div data-testid="gdd-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to see its Game Design Document.
      </div>
    );
  }

  const current = docs.find((d) => d.aspect === selected) ?? docs[0];
  const symbolRows = (docs.find((d) => d.aspect === 'symbols-reels')?.data?.symbols ?? []) as Array<{
    model_id?: number;
    name?: string;
    slot?: string;
  }>;
  const names = new Map<number, string>();
  for (const row of symbolRows) {
    if (row.model_id != null) names.set(Number(row.model_id), row.name || row.slot || '');
  }

  const gameId = activeGameId; // narrowed non-null by the early return above; the closure below doesn't inherit that narrowing from `activeGameId` directly
  async function onRealize() {
    setRealizing(true);
    try {
      const res = await realizeSlotModel(gameId);
      if (!res.realized) {
        setRealizeError(res.errors.join('; ') || 'realize failed');
        return; // model unchanged on the backend; keep the stale banner as-is
      }
      const doc = await getSlotModel(gameId);
      setSlotModel(doc.model);
      setShapeStale(doc.shapeStale);
      setRealizeError(null);
    } catch {
      setRealizeError('realize request failed');
    } finally {
      setRealizing(false);
    }
  }

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
        {current && INTENT_FIELDS[current.aspect] && (
          <IntentEditor key={current.aspect} gameId={activeGameId} aspect={current.aspect} data={current.data || {}} />
        )}
        <Markdown source={current?.body || ''} />
        {current && SHAPE_ASPECTS.has(current.aspect) && shapeStale && (
          <div data-testid="gdd-shape-stale" className="mt-3 flex flex-col gap-2 border-t border-hairline pt-3 text-sm">
            <div className="flex items-center gap-3 text-accent-text">
              <span>The game model&rsquo;s shape no longer matches this GDD.</span>
              <button
                onClick={() => void onRealize()}
                disabled={realizing}
                className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              >
                {realizing ? 'Re-realizing…' : 'Re-realize model'}
              </button>
            </div>
            {realizeError && (
              <span data-testid="gdd-realize-error" className="text-text-3">
                Re-realize failed: {realizeError}
              </span>
            )}
          </div>
        )}
        {current && MIRROR_ASPECTS.has(current.aspect) && (
          <MirrorSection aspect={current.aspect as 'paytable' | 'bonus-features'} model={slotModel} names={names} />
        )}
      </div>
    </div>
  );
}
