// studio/frontend/src/plugins/assets/AssetBoardPane.tsx
import { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { assetsHooks } from './state';
import type { IGame, Workflow } from './state';
import { openGame, createAsset, createGame, loadGames } from './actions';
import { AssetCard } from './AssetCard';
import { bumpRenderCount } from '../../app/renderCount';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { notify } from '@/lib/notify';

const WORKFLOWS: Workflow[] = ['schnell-opaque', 'schnell-transparent', 'dev-transparent'];
const selectClass = 'rounded-md border border-input bg-background px-2 py-1 text-sm';

export function AssetBoardPane(_props: IDockviewPanelProps) {
  const s = assetsHooks.usePluginState();
  const games = s.games.get({ noproxy: true }) as IGame[];
  const activeGameId = s.activeGameId.get();
  // Subscribe only to the COUNT so adding/removing assets re-renders the grid, but a
  // progress tick (which mutates one asset node) does not re-render the board shell.
  const assetCount = s.assets.length;
  bumpRenderCount('AssetBoardPane');

  const [creating, setCreating] = useState(false);
  const [gameName, setGameName] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workflow, setWorkflow] = useState<Workflow>('schnell-transparent');

  async function submitNewGame() {
    const n = gameName.trim();
    if (!n) return;
    try {
      await createGame(n);
      setGameName('');
      setCreating(false);
    } catch {
      notify.error('Could not create game');
    }
  }

  const newGameRow = (
    <div className="flex items-center gap-2" data-testid="new-game-row">
      <Input
        data-testid="new-game-name"
        placeholder="Game name"
        value={gameName}
        onChange={(e) => setGameName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submitNewGame();
        }}
      />
      <Button data-testid="new-game-submit" onClick={() => void submitNewGame()}>
        Create game
      </Button>
      {games.length > 0 && (
        <Button variant="outline" onClick={() => setCreating(false)}>
          Cancel
        </Button>
      )}
    </div>
  );

  if (games.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center" data-testid="games-empty">
        <div>
          <h2 className="text-lg font-semibold">No games yet</h2>
          <p className="text-sm text-muted-foreground">Create a game to start generating assets.</p>
        </div>
        {creating ? newGameRow : (
          <Button data-testid="new-game" onClick={() => setCreating(true)}>
            + New Game
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3" data-testid="asset-board">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">
          Game:{' '}
          <select
            data-testid="game-select"
            className={selectClass}
            value={activeGameId ?? ''}
            onChange={(e) => void openGame(e.target.value)}
          >
            <option value="" disabled>
              Select a game…
            </option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        {creating ? newGameRow : (
          <Button data-testid="new-game" variant="outline" onClick={() => setCreating(true)}>
            + New Game
          </Button>
        )}
        <Button data-testid="refresh-games" variant="outline" onClick={() => void loadGames()}>
          ↻ Refresh
        </Button>
      </div>

      {activeGameId && (
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
              <select data-testid="asset-workflow" className={selectClass} value={workflow} onChange={(e) => setWorkflow(e.target.value as Workflow)}>
                {WORKFLOWS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
              <Button type="submit">Add asset</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {activeGameId && assetCount === 0 && (
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
