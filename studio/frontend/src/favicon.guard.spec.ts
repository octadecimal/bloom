// @vitest-environment node
// studio/frontend/src/favicon.guard.spec.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(new URL('./favicon.guard.spec.ts', import.meta.url)));
const indexHtml = () => readFileSync(join(here, '..', 'index.html'), 'utf8');
const faviconSvg = () => readFileSync(join(here, '..', 'public', 'favicon.svg'), 'utf8');

describe('brand favicon', () => {
  it('index.html links the SVG favicon as the preferred icon', () => {
    const html = indexHtml();
    expect(html).toMatch(/<link[^>]*rel="icon"[^>]*type="image\/svg\+xml"[^>]*href="\/favicon\.svg"/);
  });

  it('index.html keeps the .ico fallback link', () => {
    expect(indexHtml()).toMatch(/<link[^>]*rel="icon"[^>]*href="\/favicon\.ico"/);
  });

  it('favicon.svg paints the brand tile and renders the glyph as a vector path', () => {
    const svg = faviconSvg();
    expect(svg).toContain('#f0641e'); // brand tile — tracks --accent
    expect(svg).toContain('<path'); // glyph is an outline, not a font glyph
    expect(svg).not.toContain('<text'); // never depend on a system font
  });
});
