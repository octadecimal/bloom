import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GDD_PLUGIN_ID, gddSlice, makeInitialState, type IGddDoc } from './state';
import { GddViewerPane } from './GddViewerPane';
import { saveIntentFields } from './actions';

vi.mock('./actions', () => ({
  openGameDocs: vi.fn(),
  initGdd: vi.fn(),
  saveIntentFields: vi.fn(async () => ({ rebuilt: true, warnings: [] })),
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

  it('shows read-only markdown for non-intent aspects', () => {
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([{ ...uiDoc({}), aspect: 'math-model', title: 'Math Model' }]);
      gddSlice().selectedAspect.set('math-model');
    });
    render(<GddViewerPane {...fakeProps} />);
    expect(screen.queryByTestId('gdd-intent-editor')).toBeNull();
  });
});

describe('GddViewerPane', () => {
  it('shows an empty state when no game is active', () => {
    render(<GddViewerPane {...fakeProps} />);
    expect(screen.getByTestId('gdd-no-game')).toBeTruthy();
  });

  it('lists the seeded aspects with status markers', () => {
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([doc('theme', 1, 'complete'), doc('math-model', 2, 'needs_input')]);
    });
    render(<GddViewerPane {...fakeProps} />);
    expect(screen.getByTestId('gdd-aspect-theme')).toBeTruthy();
    expect(screen.getByTestId('gdd-aspect-math-model')).toBeTruthy();
    expect(screen.getByTestId('gdd-status-math-model').textContent).toMatch(/needs input/i);
  });
});
