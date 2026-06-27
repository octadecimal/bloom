import { useState, useRef, useEffect } from 'react';
import type { JsonValue } from '../../scene/types';
import { type ScalarType, parseEditInput, toInputText } from './edit';
import { commitSetProp } from './commit';

interface IEditableValueProps {
  nodeId: string;
  path: string;
  valueType: ScalarType;
  raw: JsonValue;
}

export function EditableValue({ nodeId, path, valueType, raw }: IEditableValueProps) {
  const [text, setText] = useState(() => toInputText(valueType, raw));
  const focused = useRef(false);
  // The committed value when editing began — Escape re-commits this (undo).
  const originalOnFocus = useRef<JsonValue>(raw);

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
        originalOnFocus.current = raw;
      }}
      onBlur={() => {
        focused.current = false;
        setText(toInputText(valueType, raw));
      }}
      onChange={(e) => {
        const next = e.currentTarget.value;
        setText(next);
        const parsed = parseEditInput(valueType, next);
        if (parsed.ok) commitSetProp(nodeId, path, parsed.value as JsonValue);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Undo: re-commit the focus-time value so the live game reverts too.
          commitSetProp(nodeId, path, originalOnFocus.current);
          setText(toInputText(valueType, originalOnFocus.current));
          e.currentTarget.blur();
        } else if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
    />
  );
}
