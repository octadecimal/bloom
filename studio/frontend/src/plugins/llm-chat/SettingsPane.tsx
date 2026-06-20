import { useEffect, useState } from 'react';
import { getModels, type IModelOption } from './restClient';
import { bumpRenderCount } from '../../app/renderCount';

export function SettingsPane() {
  const [models, setModels] = useState<IModelOption[]>([]);
  bumpRenderCount('SettingsPane');

  useEffect(() => {
    let cancelled = false;
    void getModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div data-testid="chat-settings-pane" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        Model (active room)
        <select data-testid="settings-model" defaultValue="">
          <option value="" disabled>
            Select a model…
          </option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
