import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { rootStore } from './rootStore';
import { makePluginHooks } from './makePluginHooks';

interface ICounter { count: number }

describe('makePluginHooks', () => {
  afterEach(() => { rootStore.plugins.set({}); });

  it('reads and writes the plugin-scoped slice', () => {
    rootStore.plugins.merge({ probe: { count: 0 } });
    const { usePluginState } = makePluginHooks<ICounter>('probe');
    const { result } = renderHook(() => usePluginState());
    expect(result.current.count.get()).toBe(0);
    act(() => result.current.count.set(3));
    expect((rootStore.plugins.get() as Record<string, ICounter>).probe.count).toBe(3);
  });
});
