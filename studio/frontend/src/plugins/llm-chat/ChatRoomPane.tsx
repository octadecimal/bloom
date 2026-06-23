import { useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusPill } from '@/components/ui/StatusPill';
import { llmChatHooks } from './state';
import { sendPrompt, setTyping, runSkill } from './actions';
import { bumpRenderCount } from '../../app/renderCount';
import { RunTimeline } from './RunTimeline';

// ---------------------------------------------------------------------------
// Pure helper — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Parse a slash command from the composer draft.
 * "/generate-sprite description="a knight" style=pixel"
 *   → { skillName: 'generate-sprite', args: { description: 'a knight', style: 'pixel' } }
 * "hello world" → null
 */
export function parseSlashCommand(text: string): { skillName: string; args: Record<string, string> } | null {
  const slashMatch = text.match(/^\/(\S+)\s*(.*)$/);
  if (!slashMatch) return null;

  const skillName = slashMatch[1];
  const rest = slashMatch[2] ?? '';
  const args: Record<string, string> = {};

  const argRe = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = argRe.exec(rest)) !== null) {
    // group 2 = quoted value, group 3 = bare value
    args[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }

  return { skillName, args };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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
  const initial = (author.trim()[0] ?? '?').toLowerCase();

  return (
    <li
      data-testid={`chat-msg-${id}`}
      data-role={role}
      data-status={status}
      className={`flex gap-2 rounded-r ${isAssistant ? 'border-l-2 border-primary/50 bg-primary/[0.04] pl-2' : ''}`}
    >
      <div
        aria-hidden
        className={`mt-px flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border bg-raised font-mono text-[9px] ${
          isAssistant ? 'border-primary/30 text-accent-text' : 'border-border text-muted-foreground'
        }`}
      >
        {isAssistant ? 'ai' : initial}
      </div>
      <div className="min-w-0">
        <div className={`text-[10.5px] font-semibold leading-tight ${isAssistant ? 'text-accent-text/90' : 'text-muted-foreground'}`}>{author}</div>
        <div className="text-[13px] leading-snug text-foreground">
          {content}
          {status === 'streaming' && (
            <span data-testid="chat-caret" className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 rounded-sm bg-primary align-baseline" />
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
    <ul data-testid="chat-messages" className="m-0 flex flex-1 list-none flex-col gap-1.5 overflow-auto p-0">
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
    <StatusPill data-testid="chat-connection" data-state={state} tone={connected ? 'success' : 'warning'}>
      {connected ? 'connected' : `${state}…`}
    </StatusPill>
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
    <StatusPill data-testid="chat-ai-status" data-state={st.state} tone={st.state === 'idle' ? 'neutral' : 'warning'}>
      AI: {st.state}
      {st.queueDepth > 0 ? ` (${st.queueDepth} queued)` : ''}
    </StatusPill>
  );
}

/**
 * Skill autocomplete popup — isolated sub-component so it subscribes to the
 * `skills` leaf independently. This means a `skills` change re-renders only
 * this component, not `ChatRoomPane`, preserving the render-count discipline.
 */
function SkillAutocomplete({ prefix }: { prefix: string }) {
  const s = llmChatHooks.usePluginState();
  const skills = s.skills.get();
  const matches = skills.filter((sk) => sk.name.startsWith(prefix));
  if (matches.length === 0) return null;
  return (
    <ul data-testid="skill-autocomplete" className="m-0 list-none rounded-md border bg-surface p-1 text-sm shadow-md">
      {matches.map((sk) => (
        <li key={sk.name} data-testid={`skill-option-${sk.name}`} className="cursor-pointer rounded px-2 py-1 text-foreground hover:bg-raised">
          <span className="font-semibold text-accent-text">/{sk.name}</span>
          {sk.description ? <span className="ml-2 text-muted-foreground">{sk.description}</span> : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Main pane
// ---------------------------------------------------------------------------

export function ChatRoomPane() {
  const s = llmChatHooks.usePluginState();
  const [draft, setDraft] = useState('');
  bumpRenderCount('ChatRoomPane');

  if (s.activeRoomId.get() === null) {
    return (
      <div data-testid="chat-empty" className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <h2 className="text-base font-semibold">No room selected</h2>
        <p className="text-sm text-muted-foreground">Return to the room picker to choose or create a room.</p>
      </div>
    );
  }

  const submit = () => {
    if (draft.trim()) {
      const parsed = parseSlashCommand(draft.trim());
      if (parsed) {
        runSkill(parsed.skillName, parsed.args);
      } else {
        sendPrompt(draft.trim());
      }
      setDraft('');
      setTyping(false);
    }
  };

  // Derive autocomplete prefix: only non-empty when draft starts with "/"
  const slashPrefix = draft.startsWith('/') ? draft.slice(1).split(' ')[0] : null;

  return (
    <div data-testid="chat-room-pane" className="flex h-full flex-col gap-2 bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2">
        <ConnectionIndicator />
        <AiStatusLine />
      </div>
      <PresenceLine />
      <ErrorBanner />
      <MessageList />
      <TypingLine />
      <RunTimeline />
      {slashPrefix !== null && <SkillAutocomplete prefix={slashPrefix} />}
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
        <Button data-testid="chat-send" size="icon" aria-label="Send" onClick={submit}>
          <ArrowUp className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
