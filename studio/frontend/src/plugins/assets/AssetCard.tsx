// studio/frontend/src/plugins/assets/AssetCard.tsx
import { useState, useEffect } from 'react';
import { assetsHooks } from './state';
import type { IGeneration } from './state';
import { BACKEND_URL } from './config';
import { generateAsset, deleteAsset, selectGeneration } from './actions';
import { ImageLightbox } from './ImageLightbox';
import { VIEW_CONFIG, type AssetViewMode } from './viewConfig';
import { bumpRenderCount } from '../../app/renderCount';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// Subscribes to ITS OWN asset node (s.assets[index]) and reads individual leaves,
// so an asset_progress tick (scoped node write) re-renders only this card.
// `mode` drives presentation via VIEW_CONFIG so the card stays a thin renderer.
export function AssetCard({ index, mode }: { index: number; mode: AssetViewMode }) {
  const s = assetsHooks.usePluginState();
  const a = s.assets[index];
  bumpRenderCount('AssetCard');
  const cfg = VIEW_CONFIG[mode];

  const id = a.id.get();
  const status = a.status.get();
  const generations = a.generations.get() as IGeneration[];
  const selectedId = a.selectedGenerationId.get();
  const progress = a.progress.get();
  const selected = generations.find((g) => g.id === selectedId);
  const busy = status === 'generating' || status === 'queued';
  const [zoomed, setZoomed] = useState(false);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    setZoomed(false);
  }, [selectedId]);
  // NOTE: hookstate v4 reserves `state.error` for async promise errors; reach the
  // asset field via `a.nested('error')`.
  const errorMessage = (a.nested('error') as unknown as { get(): string | null }).get();
  const showActions = cfg.actions === 'always' || hovered;

  // Transient-state block — rendered in EVERY mode so an in-flight or failed
  // generation is never hidden, however compact the tile is.
  const statusBlock = (
    <>
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
    </>
  );

  const generateButton = (
    <Button data-testid="asset-generate" variant="accentOutline" onClick={() => generateAsset(id)} disabled={busy}>
      {generations.length > 0 ? 'Generate again' : 'Generate'}
    </Button>
  );
  const deleteButton = (
    <Button variant="ghost" onClick={() => void deleteAsset(id)}>
      Delete
    </Button>
  );
  const lightbox = selected && <ImageLightbox src={`${BACKEND_URL}${selected.imageRef}`} alt={a.name.get()} open={zoomed} onOpenChange={setZoomed} />;

  // LIST MODE — one compact horizontal row: thumb · name · workflow · status · actions.
  if (cfg.row) {
    return (
      <Card data-testid={`asset-card-${id}`} data-view-mode={mode} className={cn(cfg.card, 'flex items-center gap-2 p-1.5')}>
        <div className={cn(cfg.image, 'flex shrink-0 items-center justify-center overflow-hidden rounded bg-muted')}>
          {selected && (
            <img
              data-testid="asset-selected-image"
              src={`${BACKEND_URL}${selected.imageRef}`}
              alt={a.name.get()}
              onClick={() => setZoomed(true)}
              className="h-full w-full cursor-zoom-in object-contain"
            />
          )}
        </div>
        <strong className="flex-1 truncate">{a.name.get()}</strong>
        <span className="font-mono text-[11px] text-muted-foreground">{a.workflow.get()}</span>
        <div className="flex justify-end">{statusBlock}</div>
        {generateButton}
        {deleteButton}
        {lightbox}
      </Card>
    );
  }

  // GRID MODES (small / medium / large) — vertical card with config-driven chrome.
  return (
    <Card
      data-testid={`asset-card-${id}`}
      data-view-mode={mode}
      className={cfg.card}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <strong className="truncate">{a.name.get()}</strong>
          {cfg.showWorkflow && <span className="font-mono text-[11px] text-muted-foreground">{a.workflow.get()}</span>}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        {selected && (
          <div className={cn(cfg.image, 'flex w-full items-center justify-center overflow-hidden rounded-md bg-muted')}>
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

        {statusBlock}
        {!selected && status === 'idle' && <span className="text-xs text-muted-foreground">No image yet</span>}

        {cfg.showCandidates && generations.length > 0 && (
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

      {showActions && (
        <CardFooter className="justify-between">
          {generateButton}
          {deleteButton}
        </CardFooter>
      )}

      {lightbox}
    </Card>
  );
}
