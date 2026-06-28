# Brand-matched Favicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic Bloom Studio favicon with one that reproduces the header `BrandMark` glyph — an orange rounded tile with a bold lowercase `b` drawn as an exact IBM Plex Sans Bold vector outline.

**Architecture:** Two static assets under `studio/frontend/public/` (an `favicon.svg` vector plus a regenerated `favicon.ico` fallback) wired into `studio/frontend/index.html` via two `<link rel="icon">` tags. A node-environment vitest guard locks the markup-and-asset contract. No runtime, bundler, or build-pipeline code changes; no shipped font dependency.

**Tech Stack:** SVG, HTML, Vitest (node environment), nx, Vite. One-time asset authoring uses the already-vendored `@fontsource/ibm-plex-sans` font, the repo's Playwright (rasterize), and a throwaway Pillow venv (ICO packing).

## Global Constraints

- TypeScript interfaces use an `I` prefix (none introduced here, but follow if adding any). — from `docs/coding-standards.md`.
- Raw color literals (`#rrggbb`, `rgb(...)`, etc.) are forbidden in `.ts`/`.tsx` files under `studio/frontend/src/` by `studio/frontend/src/design-language.guard.spec.ts`, which scans every `.ts`/`.tsx` **except** files ending `.guard.spec.ts`. The new test file MUST therefore be named `favicon.guard.spec.ts` so its `#f0641e` assertion literal is not flagged. SVG/HTML files are out of the guard's scope.
- Brand colors (verbatim, from `studio/frontend/src/styles.css`): tile `#f0641e` (`--accent` / `--primary`), glyph `#160a02` (`--accent-fg` / `--primary-foreground`).
- Frontend CI gates that MUST pass before commit/PR: `prettier --check .`, `nx typecheck`, `nx test`, `nx build`. Use the repo-pinned prettier at `node_modules/.bin/prettier` (NOT `npx prettier`, which resolves a newer version that disagrees on markdown).
- `main` is protected; this work lands via PR from branch `feat/favicon` (worktree `C:\code\bloom.wt\favicon`).

---

## Task 1: SVG favicon, HTML links, and guard test

**Files:**

- Create: `studio/frontend/public/favicon.svg`
- Modify: `studio/frontend/index.html:9`
- Test: `studio/frontend/src/favicon.guard.spec.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: the file `studio/frontend/public/favicon.svg` (an `<svg>` with a `<rect>` tile and a `<path>` glyph, no `<text>`) and two `<link rel="icon">` tags in `index.html` — `type="image/svg+xml" href="/favicon.svg"` and `sizes="any" href="/favicon.ico"`. Task 2 relies on the `/favicon.ico` link already being present.

- [ ] **Step 1: Write the failing guard test**

Create `studio/frontend/src/favicon.guard.spec.ts` (named `.guard.spec.ts` so the design-language color guard skips its hex literal):

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `studio/frontend`):

```bash
npx vitest run src/favicon.guard.spec.ts
```

Expected: FAIL — `favicon.svg` does not exist yet (`ENOENT`), and the SVG-link regex does not match the current single `x-icon` link.

- [ ] **Step 3: Create the SVG favicon**

Create `studio/frontend/public/favicon.svg` with exactly this content (the `<path>` is the IBM Plex Sans Bold `b` outline extracted from `@fontsource/ibm-plex-sans`, affine-transformed into a 32×32 viewBox: scaled to the header's 13/20 em ratio, Y-flipped for SVG, and geometric-centered; the tile `rx`/`ry` of 9.6 is the header's 6px-on-20px corner ratio):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <!-- tile fill tracks --accent / --primary (#f0641e); glyph tracks --accent-fg / --primary-foreground (#160a02) -->
  <rect width="32" height="32" rx="9.6" ry="9.6" fill="#f0641e" />
  <path d="M10.842 23.571V8.179H13.92V14.482H14.024Q14.253 13.566 15.074 12.984Q15.896 12.402 16.957 12.402Q18.35 12.402 19.276 13.057Q20.202 13.712 20.68 14.981Q21.158 16.25 21.158 18.101Q21.158 19.952 20.68 21.231Q20.202 22.51 19.276 23.166Q18.35 23.821 16.957 23.821Q15.896 23.821 15.074 23.228Q14.253 22.635 14.024 21.741H13.92V23.571ZM15.938 21.325Q16.811 21.325 17.383 20.701Q17.955 20.077 17.955 19.058V17.165Q17.955 16.125 17.383 15.511Q16.811 14.898 15.938 14.898Q15.355 14.898 14.898 15.085Q14.44 15.272 14.18 15.636Q13.92 16 13.92 16.499V19.723Q13.92 20.222 14.18 20.586Q14.44 20.95 14.898 21.138Q15.355 21.325 15.938 21.325Z" fill="#160a02" />
</svg>
```

- [ ] **Step 4: Wire the icon links into index.html**

In `studio/frontend/index.html`, replace the single existing icon link (line 9):

```html
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
```

with these two lines (SVG preferred, `.ico` fallback):

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" /> <link rel="icon" sizes="any" href="/favicon.ico" />
```

- [ ] **Step 5: Run the test to verify it passes**

Run (from `studio/frontend`):

```bash
npx vitest run src/favicon.guard.spec.ts
```

Expected: PASS — all three tests green.

- [ ] **Step 6: Format the changed text files with the pinned prettier**

Run (from repo root `C:\code\bloom.wt\favicon`):

```bash
node_modules/.bin/prettier --write studio/frontend/index.html studio/frontend/src/favicon.guard.spec.ts
```

Expected: prettier reports the files (re)formatted or unchanged. (Prettier has no SVG parser, so `favicon.svg` is left as-authored.)

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/public/favicon.svg studio/frontend/index.html studio/frontend/src/favicon.guard.spec.ts
git commit -m "feat(studio): brand-matched SVG favicon + guard"
```

---

## Task 2: Regenerate the .ico fallback from the SVG

**Files:**

- Modify (replace binary): `studio/frontend/public/favicon.ico`

**Interfaces:**

- Consumes: `studio/frontend/public/favicon.svg` from Task 1 (rasterized into the `.ico`); the `/favicon.ico` link already present in `index.html` from Task 1.
- Produces: a multi-resolution `studio/frontend/public/favicon.ico` containing native 16×16, 32×32, and 48×48 frames rendered from the brand SVG.

This task replaces a binary asset, so it is verified by the generator's reported output and a visual check rather than a new failing unit test. The Task 1 guard (the `/favicon.ico` link) stays green throughout.

- [ ] **Step 1: Write the raster script**

Save to the scratchpad as `gen-ico-frames.mjs` (uses the repo's already-installed Playwright to rasterize the final SVG at three sizes with a transparent background):

```js
import pkg from 'file:///C:/code/bloom/node_modules/playwright-core/index.js';
const { chromium } = pkg;
import { readFileSync } from 'node:fs';

const svgPath = process.argv[2]; // path to favicon.svg
const outDir = process.argv[3]; // scratchpad dir for frame PNGs
const svg = readFileSync(svgPath, 'utf8').replace(/width="32" height="32"/, '');

const browser = await chromium.launch();
for (const px of [16, 32, 48]) {
  const page = await browser.newPage({ viewport: { width: px, height: px } });
  await page.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${px}" height="${px}" `)}</body>`);
  await page.locator('svg').screenshot({ path: `${outDir}/frame-${px}.png`, omitBackground: true });
  await page.close();
}
await browser.close();
console.log('frames done');
```

- [ ] **Step 2: Write the ICO packing script**

Save to the scratchpad as `pack-ico.py` (packs the three native PNG frames into one multi-resolution `.ico` via Pillow):

```python
import sys
from PIL import Image, IcoImagePlugin

frames_dir, out_ico = sys.argv[1], sys.argv[2]
f48 = Image.open(f"{frames_dir}/frame-48.png").convert("RGBA")
f32 = Image.open(f"{frames_dir}/frame-32.png").convert("RGBA")
f16 = Image.open(f"{frames_dir}/frame-16.png").convert("RGBA")
f48.save(out_ico, format="ICO", append_images=[f32, f16])

check = IcoImagePlugin.IcoFile(open(out_ico, "rb"))
print("embedded sizes:", sorted(check.sizes()))
```

- [ ] **Step 3: Run the raster script**

Replace `<SCRATCH>` with the session scratchpad path. Run (from repo root):

```bash
node <SCRATCH>/gen-ico-frames.mjs studio/frontend/public/favicon.svg <SCRATCH>
```

Expected: `frames done`, and `frame-16.png` / `frame-32.png` / `frame-48.png` exist in `<SCRATCH>`.

- [ ] **Step 4: Pack the frames into favicon.ico**

Create a throwaway venv with Pillow (Pillow is not a project dependency — keep it out of the repo), then pack directly into the public asset:

```bash
python -m venv <SCRATCH>/icovenv
<SCRATCH>/icovenv/Scripts/python.exe -m pip install -q pillow
<SCRATCH>/icovenv/Scripts/python.exe <SCRATCH>/pack-ico.py <SCRATCH> studio/frontend/public/favicon.ico
```

Expected final line: `embedded sizes: [(16, 16), (32, 32), (48, 48)]`.

- [ ] **Step 5: Verify the favicon renders in the running app**

Bring up the studio (worktree ports: backend 8001 / frontend 4201, per its `.env` `BLOOM_PORT_OFFSET=1`) and confirm the browser tab shows the orange `b` tile:

```bash
just backend-serve-replay   # serves on :8001 for this worktree
just frontend-serve         # serves on :4201
```

Open `http://localhost:4201`, and confirm the browser tab icon is the orange rounded `b` (force-reload to bypass a cached favicon). Stop the servers when done.

Expected: tab favicon matches the header `BrandMark` glyph at both the SVG (modern browser) and `.ico` (e.g. an SVG-favicon-disabled browser) paths.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/public/favicon.ico
git commit -m "feat(studio): regenerate brand favicon.ico fallback"
```

---

## Task 3: Full gate sweep and PR

**Files:** none (verification + integration only).

**Interfaces:**

- Consumes: all artifacts from Tasks 1–2.
- Produces: a green gate run and an open PR on `feat/favicon`.

- [ ] **Step 1: Run the frontend CI gates**

Run (from repo root). `nx test` green alone is insufficient — run all four, since vitest can pass while types fail:

```bash
node_modules/.bin/prettier --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
```

Expected: all four exit 0. `prettier --check .` passes (SVG/ICO are ignored or have no parser; `index.html` and the spec were formatted in Task 1).

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/favicon
gh pr create --fill
```

Expected: PR created against `main`.

- [ ] **Step 3: Hand off to completion ritual**

Once CI is green, finish via `/bloom:complete-work` (merge `--squash --delete-branch`, restart the live backend so the new asset is served, clean up this worktree/branch per repo convention).

---

## Notes for the implementer

- The SVG `<path>` is final, verified output — do not regenerate it unless the brand tile color or glyph changes. If the IBM Plex Sans weight or the header's tile/glyph ratio changes, re-extract: load `node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-normal.woff2` with `fontTools`, draw the `b` glyph through a `TransformPen` (matrix `(s, 0, 0, -s, tx, ty)` with `s = 13/20 * 32/1000`, geometric-centering the ink bounds), and emit via `SVGPathPen`.
- Why a vector path and not `<text>`: an SVG `<text>` element falls back to a system sans-serif on any machine without IBM Plex Sans installed, drifting from the header. The baked outline renders identically everywhere.
- Why both `.svg` and `.ico`: all current browsers prefer the SVG; the `.ico` covers legacy/SVG-disabled browsers. No PWA manifest or `apple-touch-icon` is in scope (YAGNI).
