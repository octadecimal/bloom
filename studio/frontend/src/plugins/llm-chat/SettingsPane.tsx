import { useEffect, useState } from 'react';
import { llmChatHooks } from './state';
import { setDisplayName } from './actions';
import { getModels, type IModelOption } from './restClient';
import { bumpRenderCount } from '../../app/renderCount';

export function SettingsPane() {
  const s = llmChatHooks.usePluginState();
  const [name, setName] = useState(s.displayName.get());
  const [models, setModels] = useState<IModelOption[]>([]);
  bumpRenderCount('SettingsPane');

  useEffect(() => {
    let cancelled = false;
    void getModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch(() => {
        /* surfaced elsewhere; picker simply stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div data-testid="chat-settings-pane" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        Display name
        <input
          data-testid="settings-displayname"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (next && next !== s.displayName.get()) setDisplayName(next);
          }}
        />
      </label>

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
