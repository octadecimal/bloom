// @vitest-environment node
// studio/frontend/src/design-language.guard.spec.ts
import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, it, expect } from 'vitest';

const srcDir = dirname(fileURLToPath(new URL('./design-language.guard.spec.ts', import.meta.url)));

// Raw color literals that must not appear in component code (tokens live in styles.css).
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNC = /\b(?:rgb|rgba|hsl|hsla)\s*\(/;

function listSources(): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: srcDir })
    .filter((p) => !p.endsWith('styles.css'))
    .filter((p) => !p.endsWith('.guard.spec.ts'))
    .filter((p) => !p.endsWith('styles.tokens.spec.ts'));
}

describe('no raw colors outside the token layer', () => {
  it('every component sources its color from a token utility', () => {
    const offenders: string[] = [];
    for (const rel of listSources()) {
      const text = readFileSync(`${srcDir}/${rel}`, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (line.includes('design-allow-color')) return; // explicit escape hatch
        if (HEX.test(line) || FUNC.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `Raw colors found (use a token utility or add // design-allow-color):\n${offenders.join('\n')}`).toEqual([]);
  });
});
