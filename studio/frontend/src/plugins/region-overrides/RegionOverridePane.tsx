import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { gameHooks } from '../game/state';
import { getOverrides, putOverride, deleteOverride, type IOverrideView, type IRegionFields } from './restClient';

const FIELDS: (keyof IRegionFields)[] = ['x', 'y', 'region_w', 'region_h', 'anchor_x', 'anchor_y'];

function RoleRow({
  gameId,
  role,
  plan,
  override,
  onDone,
}: {
  gameId: string;
  role: string;
  plan: IRegionFields;
  override: Partial<IRegionFields>;
  onDone: (msg: string) => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(FIELDS.map((f) => [f, override[f] != null ? String(override[f]) : ''])));

  async function save() {
    const fields: Partial<IRegionFields> = {};
    for (const f of FIELDS) {
      if (vals[f] !== '') fields[f] = Number(vals[f]);
    }
    const { rebuilt } = await putOverride(gameId, role, fields);
    onDone(rebuilt ? `Reflowed ${role}.` : `Saved ${role}.`);
  }

  async function reset() {
    await deleteOverride(gameId, role);
    setVals(Object.fromEntries(FIELDS.map((f) => [f, ''])));
    onDone(`Reset ${role} to plan.`);
  }

  return (
    <div className="flex flex-col gap-2 border-b border-hairline py-3" data-testid={`region-role-${role}`}>
      <span className="text-sm text-text-1">{role}</span>
      <div className="flex flex-wrap gap-2">
        {FIELDS.map((f) => (
          <label key={f} className="flex flex-col text-xs text-text-3">
            {f}
            <input
              type="number"
              data-testid={`region-${role}-${f}`}
              value={vals[f]}
              placeholder={String(plan[f])}
              onChange={(e) => setVals((v) => ({ ...v, [f]: e.target.value }))}
              className="w-20 rounded border border-hairline bg-raised px-2 py-1 text-text-1"
            />
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          data-testid={`region-${role}-save`}
          onClick={save}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary-hover"
        >
          Save
        </button>
        <button data-testid={`region-${role}-reset`} onClick={reset} className="rounded border border-hairline px-3 py-1 text-sm text-text-2 hover:bg-raised">
          Reset
        </button>
      </div>
    </div>
  );
}

export function RegionOverridePane(_props: IDockviewPanelProps) {
  const gameId = gameHooks.usePluginState().activeGameId.get() ?? '';
  const [view, setView] = useState<IOverrideView | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (gameId)
      getOverrides(gameId)
        .then(setView)
        .catch(() => setStatus('Load failed.'));
  }, [gameId]);

  if (!gameId) return <div className="p-3 text-sm text-text-3">Open a game to edit its layout regions.</div>;
  if (!view) return <div className="p-3 text-sm text-text-3">Loading regions&hellip;</div>;

  return (
    <div data-testid="region-editor" className="flex flex-col overflow-auto bg-surface p-3">
      {Object.entries(view.plan).map(([role, plan]) => (
        <RoleRow key={role} gameId={gameId} role={role} plan={plan} override={view.overrides[role] ?? {}} onDone={setStatus} />
      ))}
      {status && (
        <span data-testid="region-status" className="mt-2 text-sm text-text-3">
          {status}
        </span>
      )}
    </div>
  );
}
