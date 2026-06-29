import { describe, it, expect } from 'vitest';
import { resolveRuntimeServerUrl } from './runtimeServerUrl';

describe('resolveRuntimeServerUrl', () => {
  it('uses an explicit ?server= override verbatim (trailing slash trimmed)', () => {
    const url = resolveRuntimeServerUrl(new URLSearchParams('server=http://10.0.0.5:9001/'), { hostname: 'ignored' }, { defaultPort: 9000 });
    expect(url).toBe('http://10.0.0.5:9001');
  });

  it('derives from the page hostname + default port when no override', () => {
    const url = resolveRuntimeServerUrl(new URLSearchParams(''), { hostname: '192.168.1.20' }, { defaultPort: 9001 });
    expect(url).toBe('http://192.168.1.20:9001');
  });

  it('never emits localhost when the page host is not localhost', () => {
    const url = resolveRuntimeServerUrl(new URLSearchParams('play'), { hostname: 'dev-host.local' }, { defaultPort: 9000 });
    expect(url).not.toContain('localhost');
    expect(url).toBe('http://dev-host.local:9000');
  });
});
