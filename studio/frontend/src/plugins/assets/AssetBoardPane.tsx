// studio/frontend/src/plugins/assets/AssetBoardPane.tsx
import { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { assetsHooks } from './state';
import type { Workflow } from './state';
import { createAsset } from './actions';
import { AssetCard } from './AssetCard';
import { bumpRenderCount } from '../../app/renderCount';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';

const WORKFLOWS: Workflow[] = ['schnell-opaque', 'schnell-transparent', 'dev-transparent'];

export function AssetBoardPane(_props: IDockviewPanelProps) {
  const s = assetsHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  // Subscribe only to the COUNT so adding/removing assets re-renders the grid, but a
  // progress tick (which mutates one asset node) does not re-render the board shell.
  const assetCount = s.assets.length;
  bumpRenderCount('AssetBoardPane');

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workflow, setWorkflow] = useState<Workflow>('schnell-transparent');

  if (!activeGameId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground" data-testid="board-no-game">
        Opening game…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3" data-testid="asset-board">
      <Card>
        <CardContent className="pt-4">
          <form
            className="flex flex-wrap items-center gap-2"
            data-testid="new-asset-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || !prompt.trim()) return;
              void createAsset({ name, prompt, width: 1024, height: 1024, workflow });
              setName('');
              setPrompt('');
            }}
          >
            <Input data-testid="asset-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input data-testid="asset-prompt" placeholder="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <Select data-testid="asset-workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value as Workflow)}>
              {WORKFLOWS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </Select>
            <Button type="submit">Add asset</Button>
          </form>
        </CardContent>
      </Card>

      {assetCount === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="assets-empty">
          No assets yet — add your first asset above, then press Generate.
        </p>
      )}

      <div className="flex flex-wrap gap-3" data-testid="asset-grid">
        {Array.from({ length: assetCount }, (_, i) => (
          <AssetCard key={i} index={i} />
        ))}
      </div>
    </div>
  );
}
