import { describe, it, expect } from 'vitest';
import { ModuleRegistry } from './registry';
import type { IGameModule, IModuleHost } from './module';

const fakeHost = {} as IModuleHost;

function stubModule(id: string, type: string): IGameModule {
  return {
    id,
    type,
    configSchema: {},
    project() {},
    mount() {},
    update() {},
    dispose() {},
  };
}

describe('ModuleRegistry', () => {
  it('creates a module via its registered type factory', () => {
    const reg = new ModuleRegistry();
    reg.register('reels', ({ id, host }) => stubModule(id, 'reels'));
    expect(reg.has('reels')).toBe(true);
    const m = reg.create('reels', { id: 'r1', host: fakeHost });
    expect(m.type).toBe('reels');
    expect(m.id).toBe('r1');
  });

  it('throws a clear error for an unknown type', () => {
    const reg = new ModuleRegistry();
    expect(() => reg.create('missing', { id: 'x', host: fakeHost })).toThrow(/unknown module type: missing/);
  });

  it('throws when registering a duplicate type', () => {
    const reg = new ModuleRegistry();
    reg.register('reels', ({ id }) => stubModule(id, 'reels'));
    expect(() => reg.register('reels', ({ id }) => stubModule(id, 'reels'))).toThrow(/already registered/);
  });
});
