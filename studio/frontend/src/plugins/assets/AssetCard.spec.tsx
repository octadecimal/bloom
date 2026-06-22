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
    render(<AssetCard index={0} />);
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
    render(<AssetCard index={0} />);
    const img = screen.getByTestId('asset-selected-image') as HTMLImageElement;
    expect(img.src).toContain('/media/g1/a1/gen1.png');
  });

  it('always renders a visible, enabled Generate button for an idle asset', () => {
    // Checks that an idle asset exposes a Generate button that is present and not disabled.
    assetsSlice().assets.set([mk({ status: 'idle', progress: null })]);
    const { getByTestId } = render(<AssetCard index={0} />);
    const gen = getByTestId('asset-generate') as HTMLButtonElement;
    expect(gen).toBeTruthy();
    expect(gen.disabled).toBe(false);
    expect(gen.textContent).toContain('Generate');
  });

  it('a progress tick re-renders only the targeted card', () => {
    assetsSlice().assets.set([mk({ id: 'a1', progress: null, status: 'queued' }), mk({ id: 'a2', progress: null, status: 'queued' })]);
    render(
      <>
        <AssetCard index={0} />
        <AssetCard index={1} />
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
    const { getByTestId } = render(<AssetCard index={0} />);
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
    render(<AssetCard index={0} />);
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
    fireEvent.click(screen.getByTestId('asset-selected-image'));
    const img = screen.getByTestId('image-lightbox-img') as HTMLImageElement;
    expect(img.src).toContain('/media/g1/a1/gen1.png');
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
    render(<AssetCard index={0} />);
    const thumb = screen.getByTestId('asset-candidates').querySelectorAll('img')[1];
    fireEvent.click(thumb);
    expect(selectGeneration).toHaveBeenCalledWith('a1', 'gen2');
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
  });
});
