import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID, type IMessage } from './state';
import { appendToken } from './reducers';
import * as actions from './actions';
import { ChatRoomPane } from './ChatRoomPane';

vi.spyOn(actions, 'sendPrompt').mockReturnValue(undefined);
vi.spyOn(actions, 'setTyping').mockReturnValue(undefined);

const msg = (over: Partial<IMessage>): IMessage => ({
  id: 'm1',
  roomId: 'r1',
  author: 'assistant',
  role: 'assistant',
  content: '',
  status: 'streaming',
  createdAt: 't',
  ...over,
});

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', 'r1') });
  vi.clearAllMocks();
  window.__renderCounts = {};
});

describe('ChatRoomPane', () => {
  it('shows an empty state when no room is active', () => {
    chatSlice().activeRoomId.set(null);
    render(<ChatRoomPane />);
    expect(screen.getByTestId('chat-empty')).toBeTruthy();
  });

  it('renders messages and reflects their content', () => {
    chatSlice().messages.set([msg({ id: 'a1', content: 'Hello' })]);
    render(<ChatRoomPane />);
    expect(screen.getByTestId('chat-msg-a1').textContent).toContain('Hello');
  });

  it('sending the composer calls sendPrompt', () => {
    render(<ChatRoomPane />);
    fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: 'hi there' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(actions.sendPrompt).toHaveBeenCalledWith('hi there');
  });

  it('shows the connection indicator', () => {
    chatSlice().connection.set('reconnecting');
    render(<ChatRoomPane />);
    expect(screen.getByTestId('chat-connection').getAttribute('data-state')).toBe('reconnecting');
  });

  it('appending a token re-renders only that bubble, not the whole pane', () => {
    chatSlice().messages.set([msg({ id: 'a1', content: 'He' })]);
    render(<ChatRoomPane />);
    window.__renderCounts = {}; // reset after mount
    act(() => {
      const cur = chatSlice().messages.get({ noproxy: true }) as IMessage[];
      chatSlice().messages.set(appendToken(cur, 'r1', 'a1', 'llo'));
    });
    expect(screen.getByTestId('chat-msg-a1').textContent).toContain('Hello');
    // The bubble re-rendered; the pane shell did not.
    expect(window.__renderCounts['ChatMessageBubble'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(window.__renderCounts['ChatRoomPane'] ?? 0).toBe(0);
  });

  it('renders the author label on a message', () => {
    chatSlice().messages.set([msg({ id: 'a2', author: 'alice', role: 'user', content: 'yo' })]);
    render(<ChatRoomPane />);
    expect(screen.getByTestId('chat-msg-a2').textContent).toContain('alice');
  });

  it('shows a streaming caret while a message is streaming', () => {
    chatSlice().messages.set([msg({ id: 's1', content: 'Hi', status: 'streaming' })]);
    render(<ChatRoomPane />);
    expect(screen.getByTestId('chat-caret')).toBeTruthy();
  });

  it('drops the caret when the message is complete', () => {
    chatSlice().messages.set([msg({ id: 'c1', content: 'Done', status: 'complete' })]);
    render(<ChatRoomPane />);
    expect(screen.queryByTestId('chat-caret')).toBeNull();
  });
});
