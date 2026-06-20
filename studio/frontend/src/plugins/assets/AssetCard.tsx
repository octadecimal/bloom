// studio/frontend/src/plugins/assets/AssetCard.tsx
import { assetsHooks } from './state';
import type { IGeneration } from './state';
import { BACKEND_URL } from './config';
import { generateAsset, deleteAsset, selectGeneration } from './actions';
import { bumpRenderCount } from '../../app/renderCount';

// Subscribes to ITS OWN asset node (s.assets[index]) and reads individual leaves,
// so an asset_progress tick (scoped node write) re-renders only this card —
// not its siblings, not the board. Mirrors ChatRoomPane's ChatMessageBubble pattern.
export function AssetCard({ index }: { index: number }) {
  const s = assetsHooks.usePluginState();
  const a = s.assets[index];
  bumpRenderCount('AssetCard');

  const id = a.id.get();
  const status = a.status.get();
  const generations = a.generations.get() as IGeneration[];
  const selectedId = a.selectedGenerationId.get();
  const progress = a.progress.get();
  const selected = generations.find((g) => g.id === selectedId);

  return (
    <div className="asset-card" data-testid={`asset-card-${id}`}>
      <header>
        <strong>{a.name.get()}</strong> <span>{a.workflow.get()}</span>
      </header>

      {selected && (
        <img
          data-testid="asset-selected-image"
          src={`${BACKEND_URL}${selected.imageRef}`}
          alt={a.name.get()}
          width={a.width.get()}
          height={a.height.get()}
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      )}

      {status === 'generating' && progress && <progress data-testid="asset-progress" value={progress.value} max={progress.max} />}
      {status === 'queued' && <span data-testid="asset-queued">queued…</span>}
      {status === 'error' && <span data-testid="asset-error">{a.error.get() ?? 'error'}</span>}

      {generations.length > 0 && (
        <div className="asset-candidates" data-testid="asset-candidates">
          {generations.map((g) => (
            <img
              key={g.id}
              src={`${BACKEND_URL}${g.imageRef}`}
              alt={`seed ${g.seed}`}
              width={48}
              height={48}
              onClick={() => void selectGeneration(id, g.id)}
              style={{ outline: g.id === selectedId ? '2px solid currentColor' : 'none', cursor: 'pointer' }}
            />
          ))}
        </div>
      )}

      <div className="asset-actions">
        <button onClick={() => generateAsset(id)} disabled={status === 'generating' || status === 'queued'}>
          Generate
        </button>
        <button onClick={() => void deleteAsset(id)}>Delete</button>
      </div>
    </div>
  );
}
