import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const connectChatAs = vi.fn();
const disconnectChat = vi.fn();
vi.mock('../plugins/llm-chat/actions', () => ({ connectChatAs: (u: string) => connectChatAs(u), disconnectChat: () => disconnectChat() }));

import { SessionSync } from './SessionSync';
import { SessionProvider } from '../session/SessionContext';
import { saveSession } from '../session/session';

beforeEach(() => {
  localStorage.clear();
  connectChatAs.mockReset();
  disconnectChat.mockReset();
});

describe('SessionSync', () => {
  it('connects with the logged-in username', () => {
    saveSession('ada');
    render(
      <SessionProvider>
        <SessionSync />
      </SessionProvider>,
    );
    expect(connectChatAs).toHaveBeenCalledWith('ada');
  });
  it('disconnects when anon', () => {
    render(
      <SessionProvider>
        <SessionSync />
      </SessionProvider>,
    );
    expect(disconnectChat).toHaveBeenCalled();
  });
});
