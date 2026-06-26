import type { JsonValue } from '../model/document';

export type ConfigFieldType = 'number' | 'integer' | 'string' | 'boolean' | 'stringArray';

export interface IConfigField {
  type: ConfigFieldType;
  default: JsonValue;
  /** Inclusive numeric bounds (number/integer only). */
  min?: number;
  max?: number;
  /** Node prop this field maps to — a hint for the property inspector. */
  binding?: string;
}

export type IConfigSchema = Record<string, IConfigField>;

export interface IValidationResult<T> {
  ok: boolean;
  /** Defaults applied; valid provided values kept; invalid fields fall back to default. */
  value: T;
  errors: string[];
}

function checkField(name: string, field: IConfigField, raw: JsonValue, errors: string[]): JsonValue {
  switch (field.type) {
    case 'number':
    case 'integer': {
      if (typeof raw !== 'number' || Number.isNaN(raw)) {
        errors.push(`${name}: expected ${field.type}`);
        return field.default;
      }
      if (field.type === 'integer' && !Number.isInteger(raw)) {
        errors.push(`${name}: expected an integer`);
        return field.default;
      }
      if (field.min !== undefined && raw < field.min) {
        errors.push(`${name}: ${raw} < min ${field.min}`);
        return field.default;
      }
      if (field.max !== undefined && raw > field.max) {
        errors.push(`${name}: ${raw} > max ${field.max}`);
        return field.default;
      }
      return raw;
    }
    case 'string':
      if (typeof raw !== 'string') {
        errors.push(`${name}: expected string`);
        return field.default;
      }
      return raw;
    case 'boolean':
      if (typeof raw !== 'boolean') {
        errors.push(`${name}: expected boolean`);
        return field.default;
      }
      return raw;
    case 'stringArray':
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
        errors.push(`${name}: expected an array of strings`);
        return field.default;
      }
      return raw;
    default:
      return field.default;
  }
}

export function validateConfig<T = Record<string, JsonValue>>(schema: IConfigSchema, raw: Record<string, JsonValue>): IValidationResult<T> {
  const errors: string[] = [];
  const value: Record<string, JsonValue> = {};
  for (const [name, field] of Object.entries(schema)) {
    value[name] = name in raw ? checkField(name, field, raw[name], errors) : field.default;
  }
  return { ok: errors.length === 0, value: value as T, errors };
}
