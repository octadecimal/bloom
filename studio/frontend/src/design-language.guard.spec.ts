// @vitest-environment node
// studio/frontend/src/design-language.guard.spec.ts
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

const srcDir = dirname(fileURLToPath(new URL('./design-language.guard.spec.ts', import.meta.url)));

// Raw color literals that must not appear in component code (tokens live in styles.css).
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNC = /\b(?:rgb|rgba|hsl|hsla)\s*\(/;

// Dependency-free recursive walk — `node:fs` globSync is Node 22+, but CI runs an
// older Node, so we cannot rely on it. readdirSync is available on every version.
function listSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(relative(srcDir, full).split('\\').join('/'));
      }
    }
  };
  walk(srcDir);
  return out.filter((p) => !p.endsWith('.guard.spec.ts')).filter((p) => !p.endsWith('styles.tokens.spec.ts'));
}

describe('no raw colors outside the token layer', () => {
  it('every component sources its color from a token utility', () => {
    const files = listSources();
    expect(files.length, 'Guard must scan at least 1 source file — check glob/cwd').toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const rel of files) {
      const text = readFileSync(`${srcDir}/${rel}`, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (line.includes('design-allow-color')) return; // explicit escape hatch
        if (HEX.test(line) || FUNC.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `Raw colors found (use a token utility or add // design-allow-color):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the detector regexes actually match raw colors (self-test)', () => {
    expect(HEX.test('#1b1c1f')).toBe(true);
    expect(FUNC.test('rgba(0,0,0,0.5)')).toBe(true);
    // non-literals must NOT match
    expect(HEX.test('currentColor') || FUNC.test('currentColor')).toBe(false);
    expect(HEX.test('transparent') || FUNC.test('transparent')).toBe(false);
  });
});
