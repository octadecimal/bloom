import { useState } from 'react';
import type { IRunStep } from './state';
import { parseQuestion } from './state';
import { resolveQuestion } from './actions';
import { Button } from '../../components/ui/button';

export function QuestionCard({ runId, step }: { runId: string; step: IRunStep }) {
  const q = parseQuestion(step);
  const [text, setText] = useState('');
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

  return (
    <div data-testid="question-card" className="rounded-md border border-hairline bg-surface p-2">
      <p className="text-sm text-text-1">{q.question}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {q.suggestions.map((s) => (
          <Button key={s} onClick={() => resolveQuestion(runId, { type: 'suggestion', value: s })}>
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
          <Button type="submit" variant="ghost">Send</Button>
        </form>
      )}
      {q.allowDelegate && (
        <Button
          variant="ghost"
          className="mt-2 text-accent-text"
          onClick={() => resolveQuestion(runId, { type: 'delegate' })}
        >
          You decide
        </Button>
      )}
    </div>
  );
}
