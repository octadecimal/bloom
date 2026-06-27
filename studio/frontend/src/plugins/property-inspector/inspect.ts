import type { ISceneDocument, JsonValue, NodeType } from '../../scene/types';
import { valueTypeOf, type ScalarType } from './edit';

export interface IPropRow {
  path: string; // unique, stable: 'name' | 'tint.r' | 'frames.0' — React key + collapse key
  key: string; // the prop key or array index segment
  depth: number;
  kind: 'scalar' | 'object' | 'array';
  display?: string; // formatted scalar, or '{}' / '[]' for an empty branch
  hasChildren: boolean;
  count?: number; // entry count for a non-empty branch
  valueType?: ScalarType; // scalar rows only — drives the editable widget
  raw?: JsonValue; // scalar rows only — the unformatted value the widget binds to
}

export interface IInspectorView {
  id: string;
  type: NodeType;
  rows: IPropRow[];
}

function isPlainObject(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function formatScalar(v: JsonValue): string {
  // Strings are quoted ("hero"); number/boolean/null shown verbatim (120, true, null).
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

// Resolve the selected node and flatten its props into a pre-order, depth-tagged
// row list. Returns null when nothing is selected or the id is absent from the
// document (a stale selection). Pure: no React/hookstate. `collapsed[path] === true`
// hides a branch's descendants (the branch row is still emitted). Absent => expanded.
export function inspectSelection(doc: ISceneDocument, selectedId: string | null, collapsed: Record<string, boolean> = {}): IInspectorView | null {
  if (selectedId === null) return null;
  const node = doc.nodes[selectedId];
  if (!node) return null;

  const rows: IPropRow[] = [];
  // Guard against cyclic / malformed in-flight values so the walk always
  // terminates. Valid JSON-over-the-wire is acyclic, so this only triggers on
  // degenerate runtime data; mirrors buildTree's visited-set robustness.
  const visited = new Set<object>();

  const walk = (key: string, path: string, value: JsonValue, depth: number): void => {
    const arr = Array.isArray(value);
    const obj = isPlainObject(value);
    if (arr || obj) {
      const entries: [string, JsonValue][] = arr ? (value as JsonValue[]).map((v, i) => [String(i), v]) : Object.entries(value as { [k: string]: JsonValue });
      const kind = arr ? 'array' : 'object';
      if (entries.length === 0) {
        rows.push({ path, key, depth, kind, display: arr ? '[]' : '{}', hasChildren: false });
        return;
      }
      if (visited.has(value as object)) {
        rows.push({ path, key, depth, kind, display: '…', hasChildren: false });
        return;
      }
      visited.add(value as object);
      rows.push({ path, key, depth, kind, hasChildren: true, count: entries.length });
      if (collapsed[path] === true) return;
      for (const [childKey, childVal] of entries) {
        walk(childKey, `${path}.${childKey}`, childVal, depth + 1);
      }
      return;
    }
    rows.push({
      path,
      key,
      depth,
      kind: 'scalar',
      display: formatScalar(value),
      hasChildren: false,
      valueType: valueTypeOf(value),
      raw: value,
    });
  };

  for (const [key, value] of Object.entries(node.props)) {
    walk(key, key, value, 0);
  }

  return { id: node.id, type: node.type, rows };
}
