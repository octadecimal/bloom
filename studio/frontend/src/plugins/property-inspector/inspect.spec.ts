import { describe, it, expect } from 'vitest';
import { inspectSelection } from './inspect';
import type { ISceneDocument } from '../../scene/types';

const docRaw: ISceneDocument = {
  version: 1,
  nodes: {
    s1: {
      id: 's1',
      type: 'Sprite',
      props: { name: 'hero', x: 120, visible: true, gap: null, tint: { r: 255 } },
    },
  },
  edges: [],
};

describe('inspectSelection raw + valueType', () => {
  it('tags each scalar row with its raw value and type', () => {
    const view = inspectSelection(docRaw, 's1')!;
    const byPath = Object.fromEntries(view.rows.map((r) => [r.path, r]));
    expect(byPath['name']).toMatchObject({ kind: 'scalar', valueType: 'string', raw: 'hero' });
    expect(byPath['x']).toMatchObject({ kind: 'scalar', valueType: 'number', raw: 120 });
    expect(byPath['visible']).toMatchObject({ kind: 'scalar', valueType: 'boolean', raw: true });
    expect(byPath['gap']).toMatchObject({ kind: 'scalar', valueType: 'null', raw: null });
    expect(byPath['tint.r']).toMatchObject({ kind: 'scalar', valueType: 'number', raw: 255 });
  });

  it('leaves branch rows without raw/valueType', () => {
    const view = inspectSelection(docRaw, 's1')!;
    const tint = view.rows.find((r) => r.path === 'tint')!;
    expect(tint.kind).toBe('object');
    expect(tint.raw).toBeUndefined();
    expect(tint.valueType).toBeUndefined();
  });
});

const doc: ISceneDocument = {
  version: 1,
  nodes: {
    s1: {
      id: 's1',
      type: 'Sprite',
      props: {
        name: 'hero',
        x: 120,
        visible: true,
        nothing: null,
        tint: { r: 255, g: 0, b: 0 },
        frames: ['a', 'b'],
        empty: {},
      },
    },
  },
  edges: [],
};

describe('inspectSelection', () => {
  it('returns null when nothing is selected', () => {
    expect(inspectSelection(doc, null)).toBeNull();
  });

  it('returns null for a stale selection absent from nodes', () => {
    expect(inspectSelection(doc, 'gone')).toBeNull();
  });

  it('returns the node id and type for a valid selection', () => {
    const view = inspectSelection(doc, 's1');
    expect(view?.id).toBe('s1');
    expect(view?.type).toBe('Sprite');
  });

  it('formats scalar props (string quoted, number/boolean/null verbatim)', () => {
    const rows = inspectSelection(doc, 's1')!.rows;
    const by = (path: string) => rows.find((r) => r.path === path);
    expect(by('name')).toMatchObject({ key: 'name', depth: 0, kind: 'scalar', display: '"hero"', hasChildren: false });
    expect(by('x')?.display).toBe('120');
    expect(by('visible')?.display).toBe('true');
    expect(by('nothing')?.display).toBe('null');
  });

  it('emits a branch row for a nested object with its children at depth+1', () => {
    const rows = inspectSelection(doc, 's1')!.rows;
    const tint = rows.find((r) => r.path === 'tint');
    expect(tint).toMatchObject({ key: 'tint', depth: 0, kind: 'object', hasChildren: true, count: 3 });
    expect(rows.find((r) => r.path === 'tint.r')).toMatchObject({ key: 'r', depth: 1, display: '255' });
    expect(rows.find((r) => r.path === 'tint.g')).toBeTruthy();
    expect(rows.find((r) => r.path === 'tint.b')).toBeTruthy();
  });

  it('emits indexed rows for an array', () => {
    const rows = inspectSelection(doc, 's1')!.rows;
    expect(rows.find((r) => r.path === 'frames')).toMatchObject({ kind: 'array', hasChildren: true, count: 2 });
    expect(rows.find((r) => r.path === 'frames.0')).toMatchObject({ key: '0', display: '"a"' });
    expect(rows.find((r) => r.path === 'frames.1')).toMatchObject({ key: '1', display: '"b"' });
  });

  it('renders an empty object/array as a childless leaf', () => {
    const rows = inspectSelection(doc, 's1')!.rows;
    expect(rows.find((r) => r.path === 'empty')).toMatchObject({ kind: 'object', hasChildren: false, display: '{}' });
  });

  it("omits a branch's descendants when collapsed", () => {
    const rows = inspectSelection(doc, 's1', { tint: true })!.rows;
    expect(rows.find((r) => r.path === 'tint')).toMatchObject({ hasChildren: true });
    expect(rows.find((r) => r.path === 'tint.r')).toBeUndefined();
  });

  it('does not loop on a cyclic/malformed value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cdoc: ISceneDocument = {
      version: 1,
      nodes: { n: { id: 'n', type: 'Container', props: { c: cyclic as never } } },
      edges: [],
    };
    expect(() => inspectSelection(cdoc, 'n')).not.toThrow();
    expect(inspectSelection(cdoc, 'n')!.rows.find((r) => r.path === 'c')).toBeTruthy();
  });
});
