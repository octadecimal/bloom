import { describe, it, expect } from 'vitest';
import { backendUrl, BACKEND_URL } from './config';

describe('backendUrl', () => {
  it('derives the backend origin from the current host when there is no env override', () => {
    // Browsing from a LAN machine: the backend must be reached at that same host,
    // never a hardcoded localhost (which would point at the viewer's own machine).
    expect(backendUrl({ protocol: 'http:', hostname: '192.168.1.240' } as Location, undefined)).toBe('http://192.168.1.240:8000');
  });

  it('honors an explicit env override verbatim', () => {
    expect(backendUrl({ protocol: 'http:', hostname: 'whatever' } as Location, 'http://api.example:9000')).toBe('http://api.example:9000');
  });

  it('exposes a host-derived BACKEND_URL (jsdom host is localhost)', () => {
    expect(BACKEND_URL).toBe('http://localhost:8000');
  });
});
