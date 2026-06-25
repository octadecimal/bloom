import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState as makeGameState, type IGameDocument } from '../game/state';
import { SCENE_GRAPH_PLUGIN_ID, sceneGraphSlice, makeInitialState } from './state';
import { SceneGraphPane } from './SceneGraphPane';

const fakeProps = {} as Parameters<typeof SceneGraphPane>[0];

const fixture: IGameDocument = {
  version: 1,
  nodes: {
    root: { id: 'root', type: 'Root', props: { name: 'Stage' } },
    c1: { id: 'c1', type: 'Container', props: {} },
    s1: { id: 's1', type: 'Sprite', props: {} },
  },
  edges: [
    { id: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'c1', port: 'parent' } },
    { id: 'e2', type: 'child', from: { node: 'c1', port: 'children' }, to: { node: 's1', port: 'parent' } },
  ],
};

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeGameState() as never);
  rootStore.plugins.nested(SCENE_GRAPH_PLUGIN_ID).set(makeInitialState() as never);
});

describe('SceneGraphPane', () => {
  it('shows an empty state when no scene is loaded', () => {
    render(<SceneGraphPane {...fakeProps} />);
    expect(screen.getByTestId('scene-graph-empty')).toBeTruthy();
  });

  it('renders a row per hierarchy node, showing name or id', () => {
    act(() => gameSlice().document.set(fixture as never));
    render(<SceneGraphPane {...fakeProps} />);
    expect(screen.getByTestId('scene-row-root').textContent).toContain('Stage');
    expect(screen.getByTestId('scene-row-c1')).toBeTruthy();
    expect(screen.getByTestId('scene-row-s1').textContent).toContain('s1');
  });

  it('records selectedId when a row is clicked', () => {
    act(() => gameSlice().document.set(fixture as never));
    render(<SceneGraphPane {...fakeProps} />);
    fireEvent.click(screen.getByTestId('scene-row-c1'));
    expect(sceneGraphSlice().selectedId.get()).toBe('c1');
    expect(screen.getByTestId('scene-row-c1').getAttribute('data-selected')).toBe('true');
  });

  it('collapses a node, hiding its descendants', () => {
    act(() => gameSlice().document.set(fixture as never));
    render(<SceneGraphPane {...fakeProps} />);
    fireEvent.click(screen.getByTestId('scene-toggle-c1'));
    expect(screen.queryByTestId('scene-row-s1')).toBeNull();
    expect(screen.getByTestId('scene-row-c1')).toBeTruthy(); // c1 itself still shown
  });
});
