import { useEffect, useState } from 'react';
import { getModels, type IModelOption } from './restClient';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { PanelHeader } from '@/components/ui/PanelHeader';
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
    <div data-testid="chat-settings-pane" className="flex h-full flex-col overflow-auto bg-surface">
      <PanelHeader label="Settings" />
      <div className="p-2.5">
        <Card>
          <CardContent className="flex flex-col gap-2 pt-2.5">
            <label className="flex flex-col gap-1 text-[13px]">
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
    </div>
  );
}
