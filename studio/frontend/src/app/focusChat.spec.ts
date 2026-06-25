import { describe, it, expect, vi, afterEach } from 'vitest';
import { isFocusChatChord, revealAndFocusChatComposer } from './focusChat';
import type { IPluginHost } from '../host/types';

function makeHost(overrides: Partial<IPluginHost> = {}): IPluginHost {
  return {
    registerPane: vi.fn(),
    registerCommand: vi.fn(),
    openPane: vi.fn(),
    runCommand: vi.fn(),
    listPanes: vi.fn(() => []),
    listCommands: vi.fn(() => []),
    resetLayout: vi.fn(),
    ...overrides,
  };
}

describe('isFocusChatChord', () => {
  it('matches Ctrl+L', () => {
    expect(isFocusChatChord({ ctrlKey: true, metaKey: false, key: 'l' } as KeyboardEvent)).toBe(true);
  });
  it('matches Cmd+L regardless of key case', () => {
    expect(isFocusChatChord({ ctrlKey: false, metaKey: true, key: 'L' } as KeyboardEvent)).toBe(true);
  });
  it('ignores L without a modifier', () => {
    expect(isFocusChatChord({ ctrlKey: false, metaKey: false, key: 'l' } as KeyboardEvent)).toBe(false);
  });
  it('ignores Ctrl+K', () => {
    expect(isFocusChatChord({ ctrlKey: true, metaKey: false, key: 'k' } as KeyboardEvent)).toBe(false);
  });
});

describe('revealAndFocusChatComposer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reveals the chat room pane via the host', () => {
    const host = makeHost();
    revealAndFocusChatComposer(host);
    expect(host.openPane).toHaveBeenCalledWith('llm-chat/room');
  });

  it('focuses the composer when it is already present', () => {
    const input = document.createElement('input');
    input.setAttribute('data-testid', 'chat-composer');
    document.body.appendChild(input);
    revealAndFocusChatComposer(makeHost());
    expect(document.activeElement).toBe(input);
  });
});
