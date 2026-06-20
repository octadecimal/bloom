import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLayoutPresetsService, type ILayoutPresetsDeps } from './layoutPresets';
import { savePersisted } from '../state/persistence';

beforeEach(() => localStorage.clear());

function makeDeps(over: Partial<ILayoutPresetsDeps> = {}) {
  const api = {
    toJSON: vi.fn(() => ({ panels: { 'llm-chat/room': {} } })),
    fromJSON: vi.fn(),
    clear: vi.fn(),
  };
  const known = new Set(['llm-chat/room', 'llm-chat/settings']);
  const builtinChat = vi.fn();
  const deps: ILayoutPresetsDeps = {
    getApi: () => api,
    paneRegistry: { get: (id: string) => (known.has(id) ? { id } : undefined) },
    builtins: { Chat: builtinChat },
    notify: { error: vi.fn() },
    ...over,
  };
  return { deps, api, builtinChat };
}

describe('layoutPresets.saveAs', () => {
  it('captures api.toJSON() under the name and lists it as a user preset', () => {
    const { deps, api } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.saveAs('My view')).toBe(true);
    expect(api.toJSON).toHaveBeenCalledTimes(1);
    expect(svc.list()).toContainEqual({ name: 'My view', kind: 'user' });
  });

  it('overwrites an existing user preset of the same name', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    svc.saveAs('dup');
    expect(svc.saveAs('dup')).toBe(true);
    expect(svc.list().filter((p) => p.name === 'dup')).toHaveLength(1);
  });

  it('rejects an empty/whitespace name and notifies', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.saveAs('   ')).toBe(false);
    expect(deps.notify.error).toHaveBeenCalled();
    expect(svc.list().some((p) => p.kind === 'user')).toBe(false);
  });

  it('rejects a name colliding with a built-in and notifies', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.saveAs('Chat')).toBe(false);
    expect(deps.notify.error).toHaveBeenCalled();
  });
});

describe('layoutPresets.apply', () => {
  it('applies a built-in by clearing then running its builder', () => {
    const { deps, api, builtinChat } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.apply('Chat')).toBe(true);
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(builtinChat).toHaveBeenCalledWith(api, deps.paneRegistry);
    expect(api.fromJSON).not.toHaveBeenCalled();
  });

  it('applies a user preset via fromJSON when all panes are known', () => {
    const { deps, api } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    svc.saveAs('ok');
    expect(svc.apply('ok')).toBe(true);
    expect(api.fromJSON).toHaveBeenCalledTimes(1);
  });

  it('refuses a user preset that references an unknown pane', () => {
    savePersisted('layoutPresets', 1, { bad: { panels: { 'gone/x': {} } } });
    const { deps, api } = makeDeps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = createLayoutPresetsService(deps);
    expect(svc.apply('bad')).toBe(false);
    expect(api.fromJSON).not.toHaveBeenCalled();
    expect(deps.notify.error).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses an unknown name and notifies', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.apply('nope')).toBe(false);
    expect(deps.notify.error).toHaveBeenCalled();
  });
});

describe('layoutPresets.onPresetsChange', () => {
  it('fires after a successful saveAs', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    const cb = vi.fn();
    svc.onPresetsChange(cb);
    svc.saveAs('New view');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires after a delete that removes an existing user preset', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    svc.saveAs('temp');
    const cb = vi.fn();
    svc.onPresetsChange(cb);
    svc.delete('temp');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on a no-op delete (built-in or missing name)', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    const cb = vi.fn();
    svc.onPresetsChange(cb);
    svc.delete('Chat'); // built-in — no-op
    svc.delete('ghost'); // missing — no-op
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT fire on a rejected saveAs (empty name)', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    const cb = vi.fn();
    svc.onPresetsChange(cb);
    svc.saveAs('');
    expect(cb).not.toHaveBeenCalled();
  });

  it('stops firing after the returned unsubscribe function is called', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    const cb = vi.fn();
    const unsub = svc.onPresetsChange(cb);
    unsub();
    svc.saveAs('after unsub');
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('layoutPresets.list / delete', () => {
  it('lists built-ins first, then user presets alphabetically', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    svc.saveAs('zeta');
    svc.saveAs('alpha');
    expect(svc.list()).toEqual([
      { name: 'Chat', kind: 'builtin' },
      { name: 'alpha', kind: 'user' },
      { name: 'zeta', kind: 'user' },
    ]);
  });

  it('deletes a user preset; built-in and missing names are no-ops', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    svc.saveAs('temp');
    svc.delete('temp');
    svc.delete('Chat'); // built-in — no throw, no removal
    svc.delete('ghost'); // missing — no throw
    expect(svc.list()).toEqual([{ name: 'Chat', kind: 'builtin' }]);
  });

  it('falls back to an empty user map on a version mismatch', () => {
    savePersisted('layoutPresets', 99, { stale: {} });
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.list().some((p) => p.kind === 'user')).toBe(false);
  });
});
