// studio/frontend/src/plugins/assets/AssetCard.tsx
import { useState, useEffect } from 'react';
import { assetsHooks } from './state';
import type { IGeneration } from './state';
import { BACKEND_URL } from './config';
import { generateAsset, deleteAsset, selectGeneration } from './actions';
import { ImageLightbox } from './ImageLightbox';
import { bumpRenderCount } from '../../app/renderCount';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card';

// Subscribes to ITS OWN asset node (s.assets[index]) and reads individual leaves,
// so an asset_progress tick (scoped node write) re-renders only this card.
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
  const busy = status === 'generating' || status === 'queued';
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    setZoomed(false);
  }, [selectedId]);
  // NOTE: hookstate v4 reserves `state.error` as a built-in for async promise
  // errors. Accessing `a.error` returns the hookstate promise-error (undefined),
  // not the asset field. Use `a.nested('error')` to reach the correct child node.
  const errorMessage = (a.nested('error') as unknown as { get(): string | null }).get();

  return (
    <Card data-testid={`asset-card-${id}`} className="w-56">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <strong className="truncate">{a.name.get()}</strong>
          <span className="font-mono text-[11px] text-muted-foreground">{a.workflow.get()}</span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        {selected && (
          <div className="flex h-32 w-full items-center justify-center overflow-hidden rounded-md bg-muted">
            <img
              data-testid="asset-selected-image"
              src={`${BACKEND_URL}${selected.imageRef}`}
              alt={a.name.get()}
              width={a.width.get()}
              height={a.height.get()}
              onClick={() => setZoomed(true)}
              className="h-full w-full cursor-zoom-in object-contain"
            />
          </div>
        )}

        {status === 'generating' && progress && <progress data-testid="asset-progress" className="w-full" value={progress.value} max={progress.max} />}
        {status === 'generating' && !progress && !selected && (
          <span data-testid="asset-generating" className="text-xs text-muted-foreground">
            Generating…
          </span>
        )}
        {status === 'queued' && (
          <span data-testid="asset-queued" className="text-xs text-muted-foreground">
            queued…
          </span>
        )}
        {status === 'error' && (
          <span data-testid="asset-error" className="text-xs text-destructive">
            {errorMessage ?? 'Generation failed'}
          </span>
        )}
        {!selected && status === 'idle' && <span className="text-xs text-muted-foreground">No image yet</span>}

        {generations.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid="asset-candidates">
            {generations.map((g) => (
              <img
                key={g.id}
                src={`${BACKEND_URL}${g.imageRef}`}
                alt={`seed ${g.seed}`}
                width={48}
                height={48}
                onClick={() => void selectGeneration(id, g.id)}
                className="cursor-pointer rounded"
                style={{ outline: g.id === selectedId ? '2px solid currentColor' : 'none' }}
              />
            ))}
          </div>
        )}
      </CardContent>

      <CardFooter className="justify-between">
        <Button data-testid="asset-generate" variant="accentOutline" onClick={() => generateAsset(id)} disabled={busy}>
          {generations.length > 0 ? 'Generate again' : 'Generate'}
        </Button>
        <Button variant="ghost" onClick={() => void deleteAsset(id)}>
          Delete
        </Button>
      </CardFooter>

      {selected && <ImageLightbox src={`${BACKEND_URL}${selected.imageRef}`} alt={a.name.get()} open={zoomed} onOpenChange={setZoomed} />}
    </Card>
  );
}
