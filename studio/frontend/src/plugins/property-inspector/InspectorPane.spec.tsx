import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState as makeGameState, type IGameDocument } from '../game/state';
import { SCENE_GRAPH_PLUGIN_ID, sceneGraphSlice, makeInitialState as makeSceneGraphState } from '../scene-graph/state';
import { PROPERTY_INSPECTOR_PLUGIN_ID, makeInitialState } from './state';
import { InspectorPane } from './InspectorPane';

const fakeProps = {} as Parameters<typeof InspectorPane>[0];

const fixture: IGameDocument = {
  version: 1,
  nodes: {
    s1: { id: 's1', type: 'Sprite', props: { name: 'hero', x: 120, tint: { r: 255, g: 0, b: 0 } } },
  },
  edges: [],
};

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeGameState() as never);
  rootStore.plugins.nested(SCENE_GRAPH_PLUGIN_ID).set(makeSceneGraphState() as never);
  rootStore.plugins.nested(PROPERTY_INSPECTOR_PLUGIN_ID).set(makeInitialState() as never);
});

describe('InspectorPane', () => {
  it('shows an empty state when nothing is selected', () => {
    act(() => gameSlice().document.set(fixture as never));
    render(<InspectorPane {...fakeProps} />);
    expect(screen.getByTestId('inspector-empty')).toBeTruthy();
  });

  it('shows the selected node type, id, and scalar props', () => {
    act(() => gameSlice().document.set(fixture as never));
    act(() => sceneGraphSlice().selectedId.set('s1'));
    render(<InspectorPane {...fakeProps} />);
    expect(screen.getByTestId('inspector-type').textContent).toBe('Sprite');
    expect(screen.getByTestId('inspector-id').textContent).toBe('s1');
    expect(screen.getByTestId('inspector-prop-name').textContent).toContain('hero');
    expect(screen.getByTestId('inspector-prop-x').textContent).toContain('120');
  });

  it('renders nested children and collapses them on caret click', () => {
    act(() => gameSlice().document.set(fixture as never));
    act(() => sceneGraphSlice().selectedId.set('s1'));
    render(<InspectorPane {...fakeProps} />);
    expect(screen.getByTestId('inspector-prop-tint.r')).toBeTruthy();
    fireEvent.click(screen.getByTestId('inspector-toggle-tint'));
    expect(screen.queryByTestId('inspector-prop-tint.r')).toBeNull();
    expect(screen.getByTestId('inspector-prop-tint')).toBeTruthy(); // branch row itself still shown
  });
});
