// studio/frontend/src/plugins/assets/AssetCard.tsx
import { useSyncExternalStore } from 'react';
import type { IAsset, IGeneration } from './state';
import { assetsSlice } from './state';
import { BACKEND_URL } from './config';
import { generateAsset, deleteAsset, selectGeneration } from './actions';
import { bumpRenderCount } from '../../app/renderCount';
import { onRootStoreSet } from '../../state/rootStore';

// Subscribe to the root store and snapshot the specific array element.
// useSyncExternalStore bails out (skips the function body) when getSnapshot()
// returns the same reference — setAssetProgress preserves the reference for
// unchanged elements via slice() + spread-on-changed-index, so only the card
// whose asset object was replaced actually re-renders.
function useAssetAtIndex(index: number): IAsset {
  const getSnapshot = () =>
    (assetsSlice().assets.get({ noproxy: true }) as IAsset[])[index];
  return useSyncExternalStore(onRootStoreSet, getSnapshot);
}

export function AssetCard({ index }: { index: number }) {
  const asset = useAssetAtIndex(index);
  bumpRenderCount('AssetCard');

  const { id, status, generations, selectedGenerationId, progress, name, workflow, width, height, error } =
    asset as IAsset & { generations: IGeneration[] };

  const selected = (generations as IGeneration[]).find((g) => g.id === selectedGenerationId);

  return (
    <div className="asset-card" data-testid={`asset-card-${id}`}>
      <header>
        <strong>{name}</strong> <span>{workflow}</span>
      </header>

      {selected && (
        <img
          data-testid="asset-selected-image"
          src={`${BACKEND_URL}${selected.imageRef}`}
          alt={name}
          width={width}
          height={height}
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      )}

      {status === 'generating' && progress && (
        <progress data-testid="asset-progress" value={progress.value} max={progress.max} />
      )}
      {status === 'queued' && <span data-testid="asset-queued">queued…</span>}
      {status === 'error' && <span data-testid="asset-error">{error ?? 'error'}</span>}

      {(generations as IGeneration[]).length > 0 && (
        <div className="asset-candidates" data-testid="asset-candidates">
          {(generations as IGeneration[]).map((g) => (
            <img
              key={g.id}
              src={`${BACKEND_URL}${g.imageRef}`}
              alt={`seed ${g.seed}`}
              width={48}
              height={48}
              onClick={() => void selectGeneration(id, g.id)}
              style={{ outline: g.id === selectedGenerationId ? '2px solid currentColor' : 'none', cursor: 'pointer' }}
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
