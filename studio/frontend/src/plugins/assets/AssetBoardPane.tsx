// studio/frontend/src/plugins/assets/AssetBoardPane.tsx
import { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { assetsHooks } from './state';
import type { IGame, Workflow } from './state';
import { openGame, createAsset, loadGames } from './actions';
import { AssetCard } from './AssetCard';
import { bumpRenderCount } from '../../app/renderCount';

const WORKFLOWS: Workflow[] = ['schnell-opaque', 'schnell-transparent', 'dev-transparent'];

export function AssetBoardPane(_props: IDockviewPanelProps) {
  const s = assetsHooks.usePluginState();
  const games = s.games.get({ noproxy: true }) as IGame[];
  const activeGameId = s.activeGameId.get();
  // Subscribe only to the COUNT so adding/removing assets re-renders the grid, but a
  // progress tick (which mutates one asset node) does not re-render the board shell.
  const assetCount = s.assets.length;
  bumpRenderCount('AssetBoardPane');

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workflow, setWorkflow] = useState<Workflow>('schnell-transparent');

  return (
    <div className="asset-board" style={{ padding: 12 }}>
      <label>
        Game:{' '}
        <select data-testid="game-select" value={activeGameId ?? ''} onChange={(e) => void openGame(e.target.value)}>
          <option value="" disabled>
            Select a game…
          </option>
          {games.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>{' '}
      <button data-testid="refresh-games" onClick={() => void loadGames()}>
        ↻ Refresh games
      </button>
      {activeGameId && (
        <form
          data-testid="new-asset-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !prompt.trim()) return;
            void createAsset({ name, prompt, width: 1024, height: 1024, workflow });
            setName('');
            setPrompt('');
          }}
        >
          <input data-testid="asset-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input data-testid="asset-prompt" placeholder="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <select data-testid="asset-workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value as Workflow)}>
            {WORKFLOWS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <button type="submit">Add asset</button>
        </form>
      )}
      <div className="asset-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {Array.from({ length: assetCount }, (_, i) => (
          <AssetCard key={i} index={i} />
        ))}
      </div>
    </div>
  );
}
