import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { selectGeneration } from './actions';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState, type IAsset } from './state';
import { AssetCard } from './AssetCard';

vi.mock('./actions', () => ({
  generateAsset: vi.fn(),
  updateAsset: vi.fn(),
  deleteAsset: vi.fn(),
  selectGeneration: vi.fn(),
}));

const mk = (over: Partial<IAsset>): IAsset => ({
  id: 'a1',
  gameId: 'g1',
  name: 'Wild',
  category: null,
  prompt: 'p',
  width: 64,
  height: 64,
  workflow: 'schnell-opaque',
  seed: null,
  status: 'generating',
  generations: [],
  selectedGenerationId: null,
  error: null,
  progress: { value: 2, max: 4 },
  ...over,
});

beforeEach(() => {
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
  assetsSlice().assets.set([mk({})]);
  window.__renderCounts = {};
});

describe('AssetCard', () => {
  it('shows a progress indicator while generating', () => {
    render(<AssetCard index={0} mode="large" />);
    expect(screen.getByTestId('asset-progress')).toBeTruthy();
  });

  it('shows the selected generation image when done', () => {
    assetsSlice().assets.set([
      mk({
        status: 'done',
        generations: [{ id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' }],
        selectedGenerationId: 'gen1',
        progress: null,
      }),
    ]);
    render(<AssetCard index={0} mode="large" />);
    const img = screen.getByTestId('asset-selected-image') as HTMLImageElement;
    expect(img.src).toContain('/media/g1/a1/gen1.png');
  });

  it('always renders a visible, enabled Generate button for an idle asset', () => {
    // Checks that an idle asset exposes a Generate button that is present and not disabled.
    assetsSlice().assets.set([mk({ status: 'idle', progress: null })]);
    const { getByTestId } = render(<AssetCard index={0} mode="large" />);
    const gen = getByTestId('asset-generate') as HTMLButtonElement;
    expect(gen).toBeTruthy();
    expect(gen.disabled).toBe(false);
    expect(gen.textContent).toContain('Generate');
  });

  it('a progress tick re-renders only the targeted card', () => {
    assetsSlice().assets.set([mk({ id: 'a1', progress: null, status: 'queued' }), mk({ id: 'a2', progress: null, status: 'queued' })]);
    render(
      <>
        <AssetCard index={0} mode="large" />
        <AssetCard index={1} mode="large" />
      </>,
    );
    window.__renderCounts = {}; // reset after mount
    act(() => {
      // Scoped node write — the production pattern: only assets[0].progress node changes,
      // so hookstate only re-renders the component subscribed to assets[0], not assets[1].
      assetsSlice().assets[0].progress.set({ value: 1, max: 4 });
    });
    // Exactly one card re-rendered (the one whose node changed), not both.
    expect(window.__renderCounts['AssetCard'] ?? 0).toBe(1);
  });

  it('renders the error message when the asset status is error', () => {
    assetsSlice().assets.set([mk({ status: 'error', error: 'boom', progress: null })]);
    const { getByTestId } = render(<AssetCard index={0} mode="large" />);
    const err = getByTestId('asset-error');
    expect(err).toBeTruthy();
    expect(err.textContent).toContain('boom');
  });

  it('opens the full-size lightbox when the selected preview is clicked', () => {
    assetsSlice().assets.set([
      mk({
        status: 'done',
        generations: [{ id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' }],
        selectedGenerationId: 'gen1',
        progress: null,
      }),
    ]);
    render(<AssetCard index={0} mode="large" />);
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
    fireEvent.click(screen.getByTestId('asset-selected-image'));
    const img = screen.getByTestId('image-lightbox-img') as HTMLImageElement;
    expect(img.src).toContain('/media/g1/a1/gen1.png');
  });

  it('closes the full-size lightbox when the selected generation changes', () => {
    assetsSlice().assets.set([
      mk({
        status: 'done',
        generations: [
          { id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' },
          { id: 'gen2', seed: 2, imageRef: '/media/g1/a1/gen2.png', createdAt: '' },
        ],
        selectedGenerationId: 'gen1',
        progress: null,
      }),
    ]);
    render(<AssetCard index={0} mode="large" />);
    // Open the lightbox
    fireEvent.click(screen.getByTestId('asset-selected-image'));
    expect(screen.getByTestId('image-lightbox-img')).toBeTruthy();
    // Change the selected generation via state update
    act(() => {
      assetsSlice().assets[0].selectedGenerationId.set('gen2');
    });
    // Lightbox should be closed
    expect(screen.queryByTestId('image-lightbox-img')).toBeNull();
  });

  it('clicking a candidate thumbnail selects it and does not open the lightbox', () => {
    assetsSlice().assets.set([
      mk({
        status: 'done',
        generations: [
          { id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' },
          { id: 'gen2', seed: 2, imageRef: '/media/g1/a1/gen2.png', createdAt: '' },
        ],
        selectedGenerationId: 'gen1',
        progress: null,
      }),
    ]);
    render(<AssetCard index={0} mode="large" />);
    const thumb = screen.getByTestId('asset-candidates').querySelectorAll('img')[1];
    fireEvent.click(thumb);
    expect(selectGeneration).toHaveBeenCalledWith('a1', 'gen2');
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
  });

  it('large mode shows the workflow tag, candidates, and an always-visible Generate', () => {
    assetsSlice().assets.set([
      mk({
        status: 'done',
        generations: [{ id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' }],
        selectedGenerationId: 'gen1',
        progress: null,
      }),
    ]);
    render(<AssetCard index={0} mode="large" />);
    expect(screen.getByTestId('asset-candidates')).toBeTruthy();
    expect(screen.getByText('schnell-opaque')).toBeTruthy();
    expect(screen.getByTestId('asset-generate')).toBeTruthy();
  });

  it('medium mode hides workflow + candidates and reveals actions only on hover', () => {
    assetsSlice().assets.set([
      mk({
        status: 'done',
        generations: [{ id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' }],
        selectedGenerationId: 'gen1',
        progress: null,
      }),
    ]);
    render(<AssetCard index={0} mode="medium" />);
    expect(screen.queryByTestId('asset-candidates')).toBeNull();
    expect(screen.queryByText('schnell-opaque')).toBeNull();
    expect(screen.queryByTestId('asset-generate')).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId('asset-card-a1'));
    expect(screen.getByTestId('asset-generate')).toBeTruthy();
    fireEvent.mouseLeave(screen.getByTestId('asset-card-a1'));
    expect(screen.queryByTestId('asset-generate')).toBeNull();
  });

  it('surfaces the error state in compact (small) mode', () => {
    assetsSlice().assets.set([mk({ status: 'error', error: 'boom', progress: null })]);
    render(<AssetCard index={0} mode="small" />);
    expect(screen.getByTestId('asset-error').textContent).toContain('boom');
  });

  it('list mode renders a row with name, workflow, and always-visible actions', () => {
    assetsSlice().assets.set([mk({ status: 'idle', progress: null })]);
    render(<AssetCard index={0} mode="list" />);
    const card = screen.getByTestId('asset-card-a1');
    expect(card.getAttribute('data-view-mode')).toBe('list');
    expect(screen.getByText('Wild')).toBeTruthy();
    expect(screen.getByText('schnell-opaque')).toBeTruthy();
    expect(screen.getByTestId('asset-generate')).toBeTruthy();
  });
});
