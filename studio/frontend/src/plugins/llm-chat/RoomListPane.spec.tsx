import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, LLM_CHAT_PLUGIN_ID } from './state';
import * as actions from './actions';
import { RoomListPane } from './RoomListPane';

vi.spyOn(actions, 'createRoom').mockResolvedValue(undefined);
vi.spyOn(actions, 'openRoom').mockResolvedValue(undefined);

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
  vi.clearAllMocks();
});

describe('RoomListPane', () => {
  it('renders rooms from the slice', () => {
    rootStore.plugins.nested(LLM_CHAT_PLUGIN_ID).merge({
      rooms: [{ id: 'r1', name: 'General', model: 'm', gameId: null, createdAt: 't' }],
    } as never);
    render(<RoomListPane />);
    expect(screen.getByText('General')).toBeTruthy();
  });

  it('clicking a room calls openRoom', () => {
    rootStore.plugins.nested(LLM_CHAT_PLUGIN_ID).merge({
      rooms: [{ id: 'r1', name: 'General', model: 'm', gameId: null, createdAt: 't' }],
    } as never);
    render(<RoomListPane />);
    fireEvent.click(screen.getByTestId('room-open-r1'));
    expect(actions.openRoom).toHaveBeenCalledWith('r1');
  });

  it('submitting the new-room form calls createRoom', () => {
    render(<RoomListPane />);
    fireEvent.change(screen.getByTestId('new-room-input'), { target: { value: 'Brainstorm' } });
    fireEvent.click(screen.getByTestId('new-room-create'));
    expect(actions.createRoom).toHaveBeenCalledWith('Brainstorm');
  });

  it('shows a retry affordance when roomsStatus is error', () => {
    rootStore.plugins.nested(LLM_CHAT_PLUGIN_ID).merge({ roomsStatus: 'error' } as never);
    render(<RoomListPane />);
    expect(screen.getByTestId('rooms-error')).toBeTruthy();
  });
});
