import { describe, it, expect } from 'vitest';
import { resolvePorts } from './ports';

describe('resolvePorts', () => {
  it('returns the current defaults when the offset is unset', () => {
    expect(resolvePorts({})).toEqual({
      offset: 0,
      backend: 8000,
      frontend: 4200,
      runtime: 4300,
      backendUrl: 'http://localhost:8000',
    });
  });

  it("treats explicit '0' identically to unset", () => {
    expect(resolvePorts({ BLOOM_PORT_OFFSET: '0' })).toEqual({
      offset: 0,
      backend: 8000,
      frontend: 4200,
      runtime: 4300,
      backendUrl: 'http://localhost:8000',
    });
  });

  it('derives every port from a single offset', () => {
    expect(resolvePorts({ BLOOM_PORT_OFFSET: '1' })).toEqual({
      offset: 1,
      backend: 8001,
      frontend: 4201,
      runtime: 4301,
      backendUrl: 'http://localhost:8001',
    });
  });

  it('lets explicit per-service ports override the offset', () => {
    const p = resolvePorts({
      BLOOM_PORT_OFFSET: '2',
      VITE_BLOOM_BACKEND_PORT: '9000',
      BLOOM_FRONTEND_PORT: '5000',
      BLOOM_RUNTIME_PORT: '6000',
    });
    expect(p.backend).toBe(9000);
    expect(p.frontend).toBe(5000);
    expect(p.runtime).toBe(6000);
    expect(p.backendUrl).toBe('http://localhost:9000');
  });

  it('honors VITE_FRONTEND_PORT as the frontend alias', () => {
    expect(resolvePorts({ BLOOM_PORT_OFFSET: '3', VITE_FRONTEND_PORT: '4250' }).frontend).toBe(4250);
  });

  it('prefers BLOOM_FRONTEND_PORT over VITE_FRONTEND_PORT', () => {
    expect(resolvePorts({ BLOOM_FRONTEND_PORT: '5000', VITE_FRONTEND_PORT: '5001' }).frontend).toBe(5000);
  });

  it('uses VITE_BLOOM_BACKEND_URL verbatim but still derives the proxy port', () => {
    const p = resolvePorts({ BLOOM_PORT_OFFSET: '1', VITE_BLOOM_BACKEND_URL: 'http://192.168.1.5:8000' });
    expect(p.backendUrl).toBe('http://192.168.1.5:8000');
    expect(p.backend).toBe(8001);
  });

  it('ignores blank / non-numeric values and falls back to derived', () => {
    expect(resolvePorts({ BLOOM_PORT_OFFSET: '1', VITE_BLOOM_BACKEND_PORT: '' }).backend).toBe(8001);
    expect(resolvePorts({ BLOOM_PORT_OFFSET: 'abc' }).offset).toBe(0);
  });
});
