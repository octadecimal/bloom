import { describe, it, expect } from 'vitest';
import { engineOrigin, ENGINE_PORT } from './config';

describe('engineOrigin', () => {
  it('derives the engine origin from the current host + engine port', () => {
    // jsdom default location is http://localhost
    expect(engineOrigin()).toBe(`http://localhost:${ENGINE_PORT}`);
  });
  it('defaults the engine port to 4300', () => {
    expect(ENGINE_PORT).toBe('4300');
  });
});
