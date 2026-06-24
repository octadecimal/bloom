import { useState } from 'react';
import type { IRunStep } from './state';
import { parseQuestion } from './state';
import { resolveQuestion } from './actions';
import { moveHighlight } from './slashParse';
import { Button } from '../../components/ui/button';

export function QuestionCard({ runId, step }: { runId: string; step: IRunStep }) {
  const q = parseQuestion(step);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(0);
  if (!q) return null;

  const resolved = step.status === 'complete' || !!q.answer;
  if (resolved) {
    const value = q.answer?.value ?? '(you decide)';
    return (
      <div data-testid="question-card" className="rounded-md border border-hairline bg-surface p-2">
        <p className="text-sm text-text-2">{q.question}</p>
        <p className="mt-1 text-sm text-text-1">→ {value}</p>
      </div>
    );
  }

  const n = q.suggestions.length;
  const pick = (i: number) => resolveQuestion(runId, { type: 'suggestion', value: q.suggestions[i] });

  // Keyboard selection over the suggestion chips, mirroring the skill-autocomplete
  // affordances (ArrowUp/Down wrap, Enter activates). Number keys 1..9 jump to a
  // chip by index. Events originating in the free-text <input> are ignored so the
  // user can type freely (arrows/Enter/digits remain normal text/submit there).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (n === 0) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return; // don't hijack free-text typing
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocused((f) => moveHighlight(f, 1, n));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocused((f) => moveHighlight(f, -1, n));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      pick(focused);
      return;
    }
    if (/^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      if (idx < n) {
        e.preventDefault();
        pick(idx);
      }
    }
  };

  return (
    <div data-testid="question-card" className="rounded-md border border-hairline bg-surface p-2" tabIndex={0} onKeyDown={onKeyDown}>
      <p className="text-sm text-text-1">{q.question}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {q.suggestions.map((s, i) => (
          <Button
            key={s}
            aria-selected={i === focused}
            data-focused={i === focused || undefined}
            className={i === focused ? 'ring-1 ring-accent-text' : undefined}
            onClick={() => resolveQuestion(runId, { type: 'suggestion', value: s })}
          >
            {s}
          </Button>
        ))}
      </div>
      {q.allowFreeText && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) resolveQuestion(runId, { type: 'freetext', value: text.trim() });
          }}
        >
          <input
            className="flex-1 rounded border border-hairline bg-raised px-2 py-1 text-sm text-text-1"
            placeholder="Type your own…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" variant="ghost">
            Send
          </Button>
        </form>
      )}
      {q.allowDelegate && (
        <Button variant="ghost" className="mt-2 text-accent-text" onClick={() => resolveQuestion(runId, { type: 'delegate' })}>
          You decide
        </Button>
      )}
    </div>
  );
}
