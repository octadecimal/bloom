import { describe, it, expect } from 'vitest';
import { bloomTheme } from './bloomTheme';

describe('bloomTheme', () => {
  it('is the floating-card model: 8px gap between groups', () => {
    expect(bloomTheme.gap).toBe(8);
  });
  it('uses the wrapped active-tab indicator', () => {
    expect(bloomTheme.tabGroupIndicator).toBe('wrap');
  });
  it('targets our CSS via the dockview-theme-bloom class and is dark', () => {
    expect(bloomTheme.className).toBe('dockview-theme-bloom');
    expect(bloomTheme.colorScheme).toBe('dark');
  });
});
