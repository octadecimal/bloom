import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GDD_PLUGIN_ID, gddSlice, makeInitialState, type IGddDoc } from './state';
import { GddViewerPane } from './GddViewerPane';
import { saveIntentFields } from './actions';
import { getSlotModel, realizeSlotModel } from './restClient';

vi.mock('./actions', () => ({
  openGameDocs: vi.fn(),
  initGdd: vi.fn(),
  saveIntentFields: vi.fn(async () => ({ rebuilt: true, warnings: [] })),
}));

vi.mock('./restClient', () => ({
  getSlotModel: vi.fn(async () => ({ model: { symbols: [], paytable: { entries: [] }, bonuses: [] }, shapeStale: false })),
  realizeSlotModel: vi.fn(async () => ({ realized: true, errors: [], warnings: [] })),
}));

const fakeProps = {} as Parameters<typeof GddViewerPane>[0];

const doc = (aspect: string, order: number, status: IGddDoc['status']): IGddDoc => ({
  id: aspect,
  gameId: 'g1',
  aspect,
  title: aspect,
  order,
  body: `# ${aspect}`,
  status,
  data: {},
  createdAt: '',
  updatedAt: '',
});

beforeEach(() => {
  rootStore.plugins.nested(GDD_PLUGIN_ID).set(makeInitialState() as never);
  vi.mocked(getSlotModel)
    .mockReset()
    .mockResolvedValue({ model: { symbols: [], paytable: { entries: [] }, bonuses: [] }, shapeStale: false });
  vi.mocked(realizeSlotModel).mockReset().mockResolvedValue({ realized: true, errors: [], warnings: [] });
});

const uiDoc = (data: Record<string, unknown>): IGddDoc => ({
  id: 'ui-ux',
  gameId: 'g1',
  aspect: 'ui-ux',
  title: 'UI / UX & Layout',
  order: 6,
  body: '',
  status: 'drafted',
  data,
  createdAt: '',
  updatedAt: '',
});

describe('GddViewerPane intent editor', () => {
  it('clears a previously-set prose field (sends empty string)', async () => {
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([uiDoc({ layout: 'reels centered', orientation: 'landscape' })]);
      gddSlice().selectedAspect.set('ui-ux');
    });
    render(<GddViewerPane {...fakeProps} />);
    const layout = screen.getByTestId('gdd-intent-layout') as HTMLTextAreaElement;
    act(() => fireEvent.change(layout, { target: { value: '' } })); // clear it
    await act(async () => {
      fireEvent.click(screen.getByTestId('gdd-intent-save'));
    });
    expect(saveIntentFields).toHaveBeenCalledWith('g1', 'ui-ux', expect.objectContaining({ layout: '' }));
  });

  it('omits a field that started empty and stayed empty', async () => {
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([uiDoc({ orientation: 'landscape' })]); // no layout set
      gddSlice().selectedAspect.set('ui-ux');
    });
    render(<GddViewerPane {...fakeProps} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('gdd-intent-save'));
    });
    const [, , patch] = (saveIntentFields as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect('layout' in (patch as Record<string, unknown>)).toBe(false);
  });

  it('renders enum selects + prose textareas for ui-ux and saves on click', async () => {
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([uiDoc({ orientation: 'landscape', focal_emphasis: 'balanced' })]);
      gddSlice().selectedAspect.set('ui-ux');
    });
    render(<GddViewerPane {...fakeProps} />);
    const select = screen.getByTestId('gdd-intent-orientation') as HTMLSelectElement;
    expect(select.value).toBe('landscape');
    expect(screen.getByTestId('gdd-intent-layout')).toBeTruthy(); // prose textarea

    act(() => fireEvent.change(select, { target: { value: 'portrait' } }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('gdd-intent-save'));
    });
    expect(saveIntentFields).toHaveBeenCalledWith('g1', 'ui-ux', expect.objectContaining({ orientation: 'portrait' }));
  });

  it('shows read-only markdown for non-intent aspects', async () => {
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([{ ...uiDoc({}), aspect: 'math-model', title: 'Math Model' }]);
      gddSlice().selectedAspect.set('math-model');
    });
    render(<GddViewerPane {...fakeProps} />);
    await act(async () => {}); // flush the mocked getSlotModel() fetch-on-mount
    expect(screen.queryByTestId('gdd-intent-editor')).toBeNull();
  });
});

describe('GddViewerPane', () => {
  it('shows an empty state when no game is active', () => {
    render(<GddViewerPane {...fakeProps} />);
    expect(screen.getByTestId('gdd-no-game')).toBeTruthy();
  });

  it('lists the seeded aspects with status markers', async () => {
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([doc('theme', 1, 'complete'), doc('math-model', 2, 'needs_input')]);
    });
    render(<GddViewerPane {...fakeProps} />);
    await act(async () => {}); // flush the mocked getSlotModel() fetch-on-mount
    expect(screen.getByTestId('gdd-aspect-theme')).toBeTruthy();
    expect(screen.getByTestId('gdd-aspect-math-model')).toBeTruthy();
    expect(screen.getByTestId('gdd-status-math-model').textContent).toMatch(/needs input/i);
  });
});

describe('GddViewerPane realized mirror', () => {
  const symbolsDoc = (): IGddDoc => ({
    ...doc('symbols-reels', 3, 'complete'),
    data: { symbols: [{ slot: 'W', name: 'Wild', model_id: 0 }] },
  });

  it('fetches the slot model and renders the paytable mirror with joined symbol names', async () => {
    vi.mocked(getSlotModel).mockResolvedValueOnce({
      model: { symbols: [{ id: 0, role: 'wild' }], paytable: { entries: [{ symbol: 0, count: 5, payout: 500 }] }, bonuses: [] },
      shapeStale: false,
    });
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([symbolsDoc(), doc('paytable', 4, 'complete')]);
      gddSlice().selectedAspect.set('paytable');
    });
    render(<GddViewerPane {...fakeProps} />);
    await waitFor(() => expect(screen.getByTestId('gdd-mirror-paytable')).toHaveTextContent('Wild'));
    expect(getSlotModel).toHaveBeenCalledWith('g1');
  });

  it('shows a shape-stale warning with a working re-realize button on shape-affected aspects', async () => {
    vi.mocked(getSlotModel).mockResolvedValue({
      model: { symbols: [], paytable: { entries: [] }, bonuses: [] },
      shapeStale: true,
    });
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([symbolsDoc()]);
      gddSlice().selectedAspect.set('symbols-reels');
    });
    render(<GddViewerPane {...fakeProps} />);
    await waitFor(() => expect(screen.getByTestId('gdd-shape-stale')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /re-realize model/i }));
    });
    expect(realizeSlotModel).toHaveBeenCalledWith('g1');
    expect(getSlotModel).toHaveBeenCalledTimes(2); // initial mount fetch + post-realize refetch
  });

  it('surfaces realize errors and keeps the banner when realized is false', async () => {
    vi.mocked(getSlotModel).mockResolvedValue({
      model: { symbols: [], paytable: { entries: [] }, bonuses: [] },
      shapeStale: true,
    });
    vi.mocked(realizeSlotModel).mockResolvedValue({ realized: false, errors: ['no symbols defined'], warnings: [] });
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([symbolsDoc()]);
      gddSlice().selectedAspect.set('symbols-reels');
    });
    render(<GddViewerPane {...fakeProps} />);
    await waitFor(() => expect(screen.getByTestId('gdd-shape-stale')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /re-realize model/i }));
    });
    expect(screen.getByTestId('gdd-realize-error')).toHaveTextContent('no symbols defined');
    expect(screen.getByTestId('gdd-shape-stale')).toBeTruthy(); // banner stays
    expect(getSlotModel).toHaveBeenCalledTimes(1); // no refetch on a failed realize
  });

  it('does not render the mirror or the shape-stale warning outside their scoped aspects', async () => {
    vi.mocked(getSlotModel).mockResolvedValue({
      model: { symbols: [], paytable: { entries: [] }, bonuses: [] },
      shapeStale: true,
    });
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([doc('theme', 1, 'complete')]);
      gddSlice().selectedAspect.set('theme');
    });
    render(<GddViewerPane {...fakeProps} />);
    await waitFor(() => expect(getSlotModel).toHaveBeenCalled());
    expect(screen.queryByTestId('gdd-shape-stale')).toBeNull();
    expect(screen.queryByTestId('gdd-mirror-paytable')).toBeNull();
    expect(screen.queryByTestId('gdd-mirror-bonus-features')).toBeNull();
  });
});
