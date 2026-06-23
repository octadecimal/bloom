import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID, type IMessage } from './state';
import { appendToken } from './reducers';
import * as actions from './actions';
import { ChatRoomPane, parseSlashCommand } from './ChatRoomPane';

vi.spyOn(actions, 'sendPrompt').mockReturnValue(undefined);
vi.spyOn(actions, 'setTyping').mockReturnValue(undefined);
vi.spyOn(actions, 'runSkill').mockReturnValue(undefined);

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

  it('renders the error banner with the destructive token when lastError is set', () => {
    chatSlice().lastError.set('boom');
    render(<ChatRoomPane />);
    const banner = screen.getByTestId('chat-error');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('boom');
    expect(banner.className).toContain('text-destructive');
  });

  it('renders a monochrome avatar chip with no rainbow inline style', () => {
    chatSlice().messages.set([msg({ id: 'h1', author: 'Alice', role: 'user', content: 'hey' })]);
    render(<ChatRoomPane />);
    const chip = screen.getByTestId('chat-msg-h1').querySelector('[aria-hidden]') as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute('style')).toBeNull(); // avatarHue HSL removed
    expect(chip.textContent).toBe('a'); // lowercased initial
  });

  it('marks the assistant bubble with an accent rule and an "ai" chip', () => {
    chatSlice().messages.set([msg({ id: 'a9', author: 'assistant', role: 'assistant', content: 'hi' })]);
    render(<ChatRoomPane />);
    const bubble = screen.getByTestId('chat-msg-a9');
    expect(bubble.className).toContain('border-primary/50');
    const chip = bubble.querySelector('[aria-hidden]') as HTMLElement;
    expect(chip.textContent).toBe('ai');
  });
});

describe('parseSlashCommand', () => {
  it('extracts name + key=value args', () => {
    expect(parseSlashCommand('/generate-sprite description="a knight" style=pixel')).toEqual({
      skillName: 'generate-sprite',
      args: { description: 'a knight', style: 'pixel' },
    });
    expect(parseSlashCommand('hello world')).toBeNull();
  });

  it('handles a slash command with no args', () => {
    expect(parseSlashCommand('/foo')).toEqual({ skillName: 'foo', args: {} });
  });
});

describe('ChatRoomPane skill autocomplete', () => {
  it('typing "/" shows skill autocomplete filtered by prefix', () => {
    chatSlice().skills.set([{ name: 'generate-sprite', description: 'd', args: [] }]);
    render(<ChatRoomPane />);
    fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: '/gen' } });
    expect(screen.getByTestId('skill-autocomplete')).toBeInTheDocument();
    expect(screen.getByTestId('skill-option-generate-sprite')).toBeInTheDocument();
  });

  it('opens a form when an autocomplete option is clicked and runs on submit', () => {
    chatSlice().skills.set([{ name: 'generate-sprite', description: 'make a sprite', args: [{ name: 'description', type: 'string', required: true }] }]);
    render(<ChatRoomPane />);
    fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: '/generate-sprite' } });
    fireEvent.click(screen.getByTestId('skill-option-generate-sprite'));
    expect(screen.getByTestId('skill-form')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('skill-form-field-description'), { target: { value: 'a knight' } });
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(actions.runSkill).toHaveBeenCalledWith('generate-sprite', { description: 'a knight' });
    // After submit: form is gone and composer is cleared
    expect(screen.queryByTestId('skill-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-composer')).toHaveValue('');
  });

  it('cancelling the form clears the composer and closes the form', () => {
    chatSlice().skills.set([{ name: 'generate-sprite', description: 'make a sprite', args: [{ name: 'description', type: 'string', required: true }] }]);
    render(<ChatRoomPane />);
    fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: '/generate-sprite' } });
    fireEvent.click(screen.getByTestId('skill-option-generate-sprite'));
    fireEvent.click(screen.getByTestId('skill-form-cancel'));
    expect(screen.queryByTestId('skill-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-composer')).toHaveValue('');
  });
});
