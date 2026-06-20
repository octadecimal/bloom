import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { llmChatHooks } from './state';
import { sendPrompt, setTyping } from './actions';
import { bumpRenderCount } from '../../app/renderCount';

// Each bubble subscribes to ITS OWN message node, so a token append re-renders
// only the streaming bubble — not the list container, not the pane shell.
function ChatMessageBubble({ index }: { index: number }) {
  const s = llmChatHooks.usePluginState();
  const m = s.messages[index];
  bumpRenderCount('ChatMessageBubble');
  return (
    <li data-testid={`chat-msg-${m.id.get()}`} data-role={m.role.get()} data-status={m.status.get()}>
      <strong>{m.author.get()}:</strong> {m.content.get()}
    </li>
  );
}

function MessageList() {
  const s = llmChatHooks.usePluginState();
  // Subscribe only to the LENGTH so appends (length change) re-render the list,
  // but content edits (token) do not touch this component.
  const count = s.messages.length;
  return (
    <ul data-testid="chat-messages" style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1, overflow: 'auto' }}>
      {Array.from({ length: count }, (_, i) => (
        <ChatMessageBubble key={i} index={i} />
      ))}
    </ul>
  );
}

function ConnectionIndicator() {
  const s = llmChatHooks.usePluginState();
  const state = s.connection.get();
  return (
    <span data-testid="chat-connection" data-state={state} style={{ fontSize: '0.8rem', opacity: 0.7 }}>
      {state === 'connected' ? '● connected' : `○ ${state}…`}
    </span>
  );
}

function TypingLine() {
  const s = llmChatHooks.usePluginState();
  const who = s.typing.get();
  if (who.length === 0) return null;
  return (
    <div data-testid="chat-typing" style={{ fontStyle: 'italic', opacity: 0.7 }}>
      {who.join(', ')} typing…
    </div>
  );
}

function PresenceLine() {
  const s = llmChatHooks.usePluginState();
  const members = s.members.get();
  return (
    <div data-testid="chat-presence" style={{ fontSize: '0.8rem', opacity: 0.7 }}>
      In room: {members.join(', ')}
    </div>
  );
}

function AiStatusLine() {
  const s = llmChatHooks.usePluginState();
  const st = s.aiStatus.get();
  return (
    <span data-testid="chat-ai-status" data-state={st.state} style={{ fontSize: '0.8rem', opacity: 0.7 }}>
      AI: {st.state}
      {st.queueDepth > 0 ? ` (${st.queueDepth} queued)` : ''}
    </span>
  );
}

export function ChatRoomPane() {
  const s = llmChatHooks.usePluginState();
  const [draft, setDraft] = useState('');
  bumpRenderCount('ChatRoomPane');

  if (s.activeRoomId.get() === null) {
    return (
      <div data-testid="chat-empty" style={{ padding: 12 }}>
        Pick or create a room in the Rooms pane to start chatting.
      </div>
    );
  }

  const submit = () => {
    if (draft.trim()) {
      sendPrompt(draft.trim());
      setDraft('');
      setTyping(false);
    }
  };

  return (
    <div data-testid="chat-room-pane" style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <ConnectionIndicator />
        <AiStatusLine />
      </div>
      <PresenceLine />
      <MessageList />
      <TypingLine />
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          data-testid="chat-composer"
          value={draft}
          placeholder="Message…"
          onChange={(e) => {
            setDraft(e.target.value);
            setTyping(e.target.value.length > 0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          style={{ flex: 1 }}
        />
        <Button data-testid="chat-send" onClick={submit}>
          Send
        </Button>
      </div>
    </div>
  );
}
