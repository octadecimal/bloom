import { describe, it, expect } from 'vitest';
import { llmChat } from './index';

describe('llmChat plugin manifest', () => {
  it('declares id, persist:false, and three panes', () => {
    expect(llmChat.id).toBe('llm-chat');
    expect(llmChat.persist).toBe(false);
    expect(llmChat.panes.map((p) => p.id)).toEqual(['llm-chat/rooms', 'llm-chat/room', 'llm-chat/settings']);
  });

  it('declares three commands', () => {
    expect(llmChat.commands?.map((c) => c.id)).toEqual(['llm-chat/open-rooms', 'llm-chat/open-room', 'llm-chat/open-settings']);
  });
});
