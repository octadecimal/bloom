import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { llmChatHooks } from './state';
import { sendPrompt, setTyping } from './actions';
import { avatarHue } from './avatarColor';
import { bumpRenderCount } from '../../app/renderCount';

// Each bubble subscribes to ITS OWN message node, so a token append re-renders
// only the streaming bubble — not the list container, not the pane shell.
function ChatMessageBubble({ index }: { index: number }) {
  const s = llmChatHooks.usePluginState();
  const m = s.messages[index];
  bumpRenderCount('ChatMessageBubble');

  const id = m.id.get();
  const author = m.author.get();
  const role = m.role.get();
  const status = m.status.get();
  const content = m.content.get();
  const isAssistant = role === 'assistant';
  const initial = (author.trim()[0] ?? '?').toUpperCase();

  return (
    <li data-testid={`chat-msg-${id}`} data-role={role} data-status={status} className="flex gap-2">
      <div
        aria-hidden
        className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-xs font-semibold text-primary-foreground ${isAssistant ? 'bg-primary' : ''}`}
        style={isAssistant ? undefined : { backgroundColor: `hsl(${avatarHue(author)} 60% 45%)` }}
      >
        {isAssistant ? 'AI' : initial}
      </div>
      <div className="min-w-0">
        <div className="mb-0.5 flex items-center gap-2">
          <span className="text-xs font-semibold">{author}</span>
          {isAssistant && <span className="rounded border border-border px-1.5 text-[10px] text-muted-foreground">ai</span>}
        </div>
        <div className="text-sm leading-relaxed">
          {content}
          {status === 'streaming' && (
            <span data-testid="chat-caret" className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-sm bg-primary align-baseline" />
          )}
        </div>
      </div>
    </li>
  );
}

function MessageList() {
  const s = llmChatHooks.usePluginState();
  // Subscribe only to the LENGTH so appends (length change) re-render the list,
  // but content edits (token) do not touch this component.
  const count = s.messages.length;
  return (
    <ul data-testid="chat-messages" className="m-0 flex flex-1 list-none flex-col gap-3 overflow-auto p-0">
      {Array.from({ length: count }, (_, i) => (
        <ChatMessageBubble key={i} index={i} />
      ))}
    </ul>
  );
}

function ConnectionIndicator() {
  const s = llmChatHooks.usePluginState();
  const state = s.connection.get();
  const connected = state === 'connected';
  return (
    <span
      data-testid="chat-connection"
      data-state={state}
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-primary' : 'bg-muted-foreground'}`} />
      {connected ? 'connected' : `${state}…`}
    </span>
  );
}

function TypingLine() {
  const s = llmChatHooks.usePluginState();
  const who = s.typing.get();
  if (who.length === 0) return null;
  return (
    <div data-testid="chat-typing" className="text-xs italic text-muted-foreground">
      {who.join(', ')} typing…
    </div>
  );
}

function PresenceLine() {
  const s = llmChatHooks.usePluginState();
  const members = s.members.get();
  return (
    <div data-testid="chat-presence" className="text-xs text-muted-foreground">
      In room: {members.join(', ')}
    </div>
  );
}

function ErrorBanner() {
  const s = llmChatHooks.usePluginState();
  const err = s.lastError.get();
  if (!err) return null;
  return (
    <div data-testid="chat-error" role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      ⚠ {err}
    </div>
  );
}

function AiStatusLine() {
  const s = llmChatHooks.usePluginState();
  const st = s.aiStatus.get();
  return (
    <span
      data-testid="chat-ai-status"
      data-state={st.state}
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
    >
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
      <div data-testid="chat-empty" className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <h2 className="text-lg font-semibold">No room selected</h2>
        <p className="text-sm text-muted-foreground">Return to the room picker to choose or create a room.</p>
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
    <div data-testid="chat-room-pane" className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <ConnectionIndicator />
        <AiStatusLine />
      </div>
      <PresenceLine />
      <ErrorBanner />
      <MessageList />
      <TypingLine />
      <div className="flex gap-2">
        <Input
          data-testid="chat-composer"
          value={draft}
          placeholder="Message…"
          className="flex-1"
          onChange={(e) => {
            setDraft(e.target.value);
            setTyping(e.target.value.length > 0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <Button data-testid="chat-send" onClick={submit}>
          Send
        </Button>
      </div>
    </div>
  );
}
