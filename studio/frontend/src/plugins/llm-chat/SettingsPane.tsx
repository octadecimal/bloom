import { useEffect, useState } from 'react';
import { getModels, type IModelOption } from './restClient';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { bumpRenderCount } from '../../app/renderCount';

export function SettingsPane() {
  const [models, setModels] = useState<IModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  bumpRenderCount('SettingsPane');

  useEffect(() => {
    let cancelled = false;
    void getModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div data-testid="chat-settings-pane" className="h-full overflow-auto p-3">
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Settings</h2>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm">
            Model (active room)
            <Select data-testid="settings-model" defaultValue="">
              <option value="" disabled>
                {loading ? 'Loading models…' : 'Select a model…'}
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </label>
        </CardContent>
      </Card>
    </div>
  );
}
