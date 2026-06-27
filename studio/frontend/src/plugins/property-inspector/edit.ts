import type { JsonValue } from '../../scene/types';

export type ScalarType = 'number' | 'string' | 'boolean' | 'null';

export function valueTypeOf(v: JsonValue): ScalarType {
  if (v === null) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'string';
}

// The text a widget shows for a raw scalar. null renders as empty (placeholder).
export function toInputText(type: ScalarType, raw: JsonValue): string {
  if (type === 'null') return '';
  return String(raw);
}

export interface IParseResult {
  ok: boolean; // false => don't emit (incomplete/invalid intermediate state)
  value?: JsonValue;
}

// Parse a text input back into a typed JsonValue for a given scalar slot,
// preserving the slot's runtime type so setProp never changes a value's type.
export function parseEditInput(type: ScalarType, text: string): IParseResult {
  switch (type) {
    case 'number': {
      if (text.trim() === '') return { ok: false };
      const n = Number(text);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case 'boolean':
      return { ok: true, value: text === 'true' };
    case 'null':
      return text === '' ? { ok: true, value: null } : { ok: true, value: text };
    case 'string':
    default:
      return { ok: true, value: text };
  }
}
