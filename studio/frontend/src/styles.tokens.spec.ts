// studio/frontend/src/styles.tokens.spec.ts
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

const EXPECTED: Record<string, string> = {
  '--canvas': '#08090a',
  '--surface': '#131417',
  '--raised': '#1b1c1f',
  '--raised-hover': '#232427',
  '--hairline': 'rgba(255, 255, 255, 0.07)',
  '--hairline-strong': 'rgba(255, 255, 255, 0.12)',
  '--text-1': '#ededef',
  '--text-2': '#9b9ba4',
  '--text-3': '#62626b',
  '--accent': '#f0641e',
  '--accent-hover': '#ff7a33',
  '--accent-text': '#ff8a4d',
  '--accent-fg': '#160a02',
  '--selection': 'rgba(240, 100, 30, 0.14)',
  '--success': '#3ec28b',
  '--warning': '#e7b549',
  '--danger': '#f0574d',
};

describe('design-language token layer', () => {
  for (const [name, value] of Object.entries(EXPECTED)) {
    it(`declares ${name}: ${value}`, () => {
      // Match `  --name: value;` allowing any whitespace run after the colon.
      const re = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*${value.replace(/[().]/g, (m) => '\\' + m)}\\s*;`);
      expect(css).toMatch(re);
    });
  }

  it('re-points the legacy shadcn names onto the new ramp', () => {
    expect(css).toMatch(/--background:\s*var\(--surface\)\s*;/);
    expect(css).toMatch(/--border:\s*var\(--hairline\)\s*;/);
    expect(css).toMatch(/--primary:\s*var\(--accent\)\s*;/);
    expect(css).toMatch(/--destructive:\s*var\(--danger\)\s*;/);
    expect(css).toMatch(/--muted-foreground:\s*var\(--text-2\)\s*;/);
  });
});
