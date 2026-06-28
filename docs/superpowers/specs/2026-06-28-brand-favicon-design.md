# Brand-matched favicon — design

**Date:** 2026-06-28
**Status:** Approved (design), pending implementation plan
**Scope:** `studio/frontend`

## Goal

Give Bloom Studio a favicon that visually matches the **`b`** monogram in the app
header/title, so the browser tab carries the same brand mark as the in-app
`BrandMark`.

## Context

The header monogram is rendered by
[`studio/frontend/src/app/BrandMark.tsx`](../../../studio/frontend/src/app/BrandMark.tsx):

- A 20×20 px tile (`h-5 w-5`) with `rounded-[6px]` corners.
- Background `bg-primary` → `--primary` → `--accent` = `#f0641e` (orange).
- A bold lowercase `b` at 13px, color `text-primary-foreground` → `--accent-fg` =
  `#160a02` (near-black), in **IBM Plex Sans Bold** (`--font-sans`, weight 700).

The current favicon is a generic `studio/frontend/public/favicon.ico`, referenced by a
single `<link rel="icon" type="image/x-icon" href="/favicon.ico" />` in
`studio/frontend/index.html`.

## Design

A full-bleed reproduction of the monogram glyph (tile + `b`, **no** wordmark), where
the rounded orange tile fills the icon and the `b` sits centered. Proportions mirror the
header glyph (≈30% corner-radius ratio, glyph height ≈65% of the tile).

### Files

Pure static assets — **no** runtime code, bundler, or build-pipeline changes.

1. **`studio/frontend/public/favicon.svg`** (new) — the vector favicon:
   - A `<rect>` for the rounded tile, fill `#f0641e`.
   - A `<path>` for the `b`, fill `#160a02`.
   - Colors hardcoded, with a comment noting the design tokens they track
     (`--accent` / `--accent-fg`) so a future token change is easy to find.

2. **`studio/frontend/public/favicon.ico`** (regenerated) — fallback for browsers
   without SVG-favicon support, rendered from the same design at 16/32/48 px.

3. **`studio/frontend/index.html`** — replace the single icon link with two:

   ```html
   <link rel="icon" type="image/svg+xml" href="/favicon.svg" /> <link rel="icon" sizes="any" href="/favicon.ico" />
   ```

   SVG-capable browsers prefer the first; older browsers fall back to the `.ico`.

### Glyph extraction (one-time authoring step)

The exact `b` outline is extracted **once** from the IBM Plex Sans Bold font already
vendored at
`node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-normal.woff2`
(e.g. via `fonttools` or `opentype.js`), then hardcoded as static `<path d="…">` data in
`favicon.svg`.

- The extraction tool is used **only during implementation** to produce the path string.
- **No** font file is shipped and there is **no** runtime or build dependency on the
  font.
- This makes the favicon font-independent: it renders pixel-identically to the header
  on every browser/OS, instead of an SVG `<text>` element that would fall back to a
  system sans-serif where IBM Plex Sans isn't installed. This matches the studio's
  visual-fidelity standard.

### Color tokens

`#f0641e` and `#160a02` are hardcoded in `favicon.svg`. This is acceptable: the
design-language raw-color guard
(`studio/frontend/src/design-language.guard.spec.ts`) scans only `.ts`/`.tsx` files
under `src/` — `public/*.svg` and `index.html` are out of its scope. A comment in the
SVG records the token each color tracks.

## Testing (TDD)

A cheap node-environment vitest guard, written RED-first:

- **`index.html`** contains both icon `<link>` tags — the SVG link
  (`type="image/svg+xml"`, `href="/favicon.svg"`) and the `.ico` fallback link
  (`href="/favicon.ico"`).
- **`public/favicon.svg`** exists, contains the brand orange `#f0641e`, and renders the
  glyph as a `<path>` — asserting there is **no** `<text>` element, locking in the
  font-independent decision.

This is a static-asset / markup contract, so a unit-level guard is the correct altitude.
No Playwright is needed; browser e2e stays out of CI per repo policy.

## Out of scope (YAGNI)

- No PWA web-app manifest.
- No `apple-touch-icon` or maskable/rounded platform variants.
- No theme-reactive (light/dark) favicon.
- No dynamic/runtime favicon generation.

A single static brand favicon only.
