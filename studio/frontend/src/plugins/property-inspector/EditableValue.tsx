import { useState, useRef, useEffect, useMemo } from 'react';
import type { JsonValue } from '../../scene/types';
import { type ScalarType, parseEditInput, toInputText, makeDebounced } from './edit';
import { commitSetProp } from './commit';

const DEBOUNCE_MS = 80;

interface IEditableValueProps {
  nodeId: string;
  path: string;
  valueType: ScalarType;
  raw: JsonValue;
}

export function EditableValue({ nodeId, path, valueType, raw }: IEditableValueProps) {
  // Debounced live commit; re-created if the target node/path changes.
  // Note: a pending debounced commit is intentionally NOT cancelled on nodeId/path change —
  // the stale closure captures the prior node's context, so the in-flight edit commits to
  // the node it was made on (correct behavior). Do not "fix" this by cancelling on remount.
  const commit = useMemo(() => makeDebounced((v: JsonValue) => commitSetProp(nodeId, path, v), DEBOUNCE_MS), [nodeId, path]);
  const [text, setText] = useState(() => toInputText(valueType, raw));
  const focused = useRef(false);

  // Reconcile from the authoritative echo — but never while the user is editing
  // this field (that would fight the cursor).
  useEffect(() => {
    if (!focused.current) setText(toInputText(valueType, raw));
  }, [raw, valueType]);

  if (valueType === 'boolean') {
    return (
      <input
        type="checkbox"
        data-testid={`inspector-edit-${path}`}
        checked={raw === true}
        onChange={(e) => commitSetProp(nodeId, path, e.currentTarget.checked)}
      />
    );
  }

  return (
    <input
      data-testid={`inspector-edit-${path}`}
      className="w-full bg-transparent text-foreground outline-none focus:bg-elevated"
      type={valueType === 'number' ? 'number' : 'text'}
      value={text}
      placeholder={valueType === 'null' ? 'null' : undefined}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setText(toInputText(valueType, raw));
      }}
      onChange={(e) => {
        const next = e.currentTarget.value;
        setText(next);
        const parsed = parseEditInput(valueType, next);
        if (parsed.ok) commit(parsed.value as JsonValue);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setText(toInputText(valueType, raw));
          e.currentTarget.blur();
        } else if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
    />
  );
}
