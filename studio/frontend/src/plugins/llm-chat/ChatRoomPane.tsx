import { useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusPill } from '@/components/ui/StatusPill';
import { llmChatHooks, type ISkill } from './state';
import { sendPrompt, setTyping, runSkill } from './actions';
import { bumpRenderCount } from '../../app/renderCount';
import { RunTimeline } from './RunTimeline';
import { SkillForm } from './SkillForm';
import { splitSlashDraft, moveHighlight, clampHighlight, decideEnter } from './slashParse';

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
 * Skill autocomplete popup — presentational, receives matches + highlight from parent.
 * Parent computes matches only while actively selecting, preserving render-count discipline.
 */
function SkillAutocomplete({ matches, highlight, onPick }: { matches: ISkill[]; highlight: number; onPick: (name: string) => void }) {
  if (matches.length === 0) return null;
  return (
    <ul data-testid="skill-autocomplete" className="m-0 list-none rounded-md border bg-surface p-1 text-sm shadow-md">
      {matches.map((sk, i) => (
        <li
          key={sk.name}
          data-testid={`skill-option-${sk.name}`}
          data-active={i === highlight ? 'true' : 'false'}
          className={`cursor-pointer rounded px-2 py-1 text-foreground ${i === highlight ? 'bg-raised' : 'hover:bg-raised'}`}
          onMouseDown={(e) => {
            e.preventDefault(); // keep composer focus
            onPick(sk.name);
          }}
        >
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
  const [highlight, setHighlight] = useState(0);
  const [popupDismissed, setPopupDismissed] = useState(false);
  const [formSkillName, setFormSkillName] = useState<string | null>(null);
  // Reading `skills` here intentionally subscribes ChatRoomPane to the skills
  // leaf ONLY while a form is open (guarded by `formSkillName`); the no-form
  // hot path never calls `.get()`, preserving render-count discipline.
  const formSkill = formSkillName
    ? (() => {
        const found = s.skills.get().find((sk) => sk.name === formSkillName);
        return found ? ({ ...found } as ISkill) : null;
      })()
    : null;
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
      sendPrompt(draft.trim());
      setDraft('');
      setTyping(false);
    }
  };

  // Compute slash context + matches WITHOUT subscribing on the hot path.
  // Only read the skills leaf while actively selecting — preserves render-count discipline.
  const slash = splitSlashDraft(draft);
  const selecting = slash !== null && !slash.hasSpace && !popupDismissed;
  const matches = selecting ? (s.skills.get() as ISkill[]).filter((sk) => sk.name.startsWith(slash!.skillName)) : [];
  const popupOpen = selecting && matches.length > 0;

  const accept = (name: string) => {
    setDraft(`/${name} `);
    setHighlight(0);
    setPopupDismissed(false);
  };

  const runProse = (name: string, prose: string) => {
    runSkill(name, {}, prose);
    setDraft('');
    setTyping(false);
  };

  const onComposerKeyDown = (e: React.KeyboardEvent) => {
    if (popupOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => moveHighlight(h, 1, matches.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => moveHighlight(h, -1, matches.length));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopupDismissed(true);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        accept(matches[clampHighlight(highlight, matches.length)].name);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const decision = decideEnter(draft, matches, highlight);
      if (decision.kind === 'accept') accept(decision.name);
      else if (decision.kind === 'run') runProse(decision.name, decision.prose);
      else if (decision.kind === 'form') setFormSkillName(decision.name);
      else submit(); // 'send'
    }
  };

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
      {formSkill ? (
        <SkillForm
          skill={formSkill}
          onSubmit={(args) => {
            runSkill(formSkill.name, args, '');
            setFormSkillName(null);
            setDraft('');
            setTyping(false);
          }}
          onCancel={() => {
            setFormSkillName(null);
            setDraft('');
            setTyping(false);
          }}
        />
      ) : (
        popupOpen && <SkillAutocomplete matches={matches} highlight={clampHighlight(highlight, matches.length)} onPick={accept} />
      )}
      <div className="flex gap-2">
        <Input
          data-testid="chat-composer"
          value={draft}
          placeholder="Message…"
          className="flex-1"
          onChange={(e) => {
            setDraft(e.target.value);
            setTyping(e.target.value.length > 0);
            setPopupDismissed(false);
            setHighlight(0);
          }}
          onKeyDown={onComposerKeyDown}
        />
        <Button data-testid="chat-send" size="icon" aria-label="Send" onClick={submit}>
          <ArrowUp className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
