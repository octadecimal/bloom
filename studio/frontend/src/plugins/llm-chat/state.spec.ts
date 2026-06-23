import { describe, it, expect, afterEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID, parseApprovalAction, type IRunStep } from './state';

describe('llm-chat state', () => {
  afterEach(() => {
    rootStore.plugins.set({});
  });

  it('makeInitialState seeds prefs and empty server state', () => {
    const s = makeInitialState('guest-1234', null);
    expect(s.displayName).toBe('guest-1234');
    expect(s.activeRoomId).toBeNull();
    expect(s.connection).toBe('connecting');
    expect(s.rooms).toEqual([]);
    expect(s.roomsStatus).toBe('idle');
    expect(s.messages).toEqual([]);
    expect(s.members).toEqual([]);
    expect(s.typing).toEqual([]);
    expect(s.aiStatus).toEqual({ state: 'idle', queueDepth: 0 });
    expect(s.roomLoadStatus).toBe('idle');
  });

  it('chatSlice() reads and writes the llm-chat plugin slice', () => {
    rootStore.plugins.merge({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
    chatSlice().displayName.set('renamed');
    expect((rootStore.plugins.get() as Record<string, ILlmChatStateLike>)[LLM_CHAT_PLUGIN_ID].displayName).toBe('renamed');
  });
});

// local structural alias for the assertion above
interface ILlmChatStateLike {
  displayName: string;
}

describe('parseApprovalAction', () => {
  it('parses an approval step content', () => {
    const step: IRunStep = {
      index: 1,
      type: 'approval',
      toolName: null,
      content: JSON.stringify({ tool: 'delete_asset', args: { asset_id: 'a1' }, label: "Delete 'knight'." }),
      status: 'running',
    };
    const action = parseApprovalAction(step);
    expect(action?.tool).toBe('delete_asset');
    expect(action?.label).toContain('knight');
  });

  it('returns null for non-approval steps', () => {
    const step: IRunStep = { index: 0, type: 'final', toolName: null, content: 'hi', status: 'complete' };
    expect(parseApprovalAction(step)).toBeNull();
  });
});
