import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GDD_PLUGIN_ID, gddSlice, makeInitialState, type IGddDoc } from './state';
import { GddViewerPane } from './GddViewerPane';

vi.mock('./actions', () => ({ openGameDocs: vi.fn(), initGdd: vi.fn() }));

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
