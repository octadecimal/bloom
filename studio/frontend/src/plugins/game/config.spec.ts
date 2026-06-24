import { describe, it, expect } from 'vitest';
import { engineOrigin, ENGINE_PORT, backendOrigin, BACKEND_PORT } from './config';

describe('engineOrigin', () => {
  it('derives the engine origin from the current host + engine port', () => {
    // jsdom default location is http://localhost
    expect(engineOrigin()).toBe(`http://localhost:${ENGINE_PORT}`);
  });
  it('defaults the engine port to 4300', () => {
    expect(ENGINE_PORT).toBe('4300');
  });
});

describe('backendOrigin', () => {
  it('derives the backend origin from the current host + backend port', () => {
    // jsdom default location is http://localhost
    expect(backendOrigin()).toBe(`http://localhost:${BACKEND_PORT}`);
  });
  it('defaults the backend port to 8000', () => {
    expect(BACKEND_PORT).toBe('8000');
  });
});
