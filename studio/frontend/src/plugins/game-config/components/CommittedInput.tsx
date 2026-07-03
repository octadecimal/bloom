import { useState } from 'react';

export interface ICommittedInputProps {
  value: string;
  onCommit: (value: string) => void;
  kind: 'text' | 'int';
  testId: string;
  className?: string;
  placeholder?: string;
}

/** Input that holds a local draft while focused and commits on blur/Enter.
 *  This IS the spec's focused-field guard: an external re-hydration replaces the
 *  state behind `value`, but the focused field keeps its draft until blur. */
export function CommittedInput({ value, onCommit, kind, testId, className, placeholder }: ICommittedInputProps) {
  const [draft, setDraft] = useState<string | null>(null);

  function commit(): void {
    if (draft === null) return;
    const next = draft;
    setDraft(null);
    if (next === value) return;
    if (kind === 'int' && !/^-?\d+$/.test(next.trim())) return; // revert garbage
    onCommit(kind === 'int' ? String(parseInt(next.trim(), 10)) : next);
  }

  return (
    <input
      data-testid={testId}
      value={draft ?? value}
      placeholder={placeholder}
      spellCheck={false}
      inputMode={kind === 'int' ? 'numeric' : undefined}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={className ?? 'h-6 rounded border border-border bg-canvas px-1.5 text-xs text-text-1 outline-none focus-visible:ring-2 focus-visible:ring-ring'}
    />
  );
}
