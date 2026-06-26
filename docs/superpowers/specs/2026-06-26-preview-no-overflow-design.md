# Design: Seal the runtime preview against overflow scrollbars

**Date:** 2026-06-26
**Status:** Approved (brainstorming)
**Scope:** `runtime/client` only

## Problem

After landing responsive root scaling (PR #109), the live scene preview still
shows scrollbars inside the game-engine iframe (the preview pane) in Studio.
Hiding the scrollbars outright would be wrong if the underlying layout is
genuinely overflowing — the goal is for the preview to be exactly the size of
its host, with no overflow possible.

## Root-cause analysis

The fit **math is correct** and is _not_ the cause. `computeViewport`
(`runtime/client/src/render/viewport.ts`) sizes the canvas to exactly
`host.clientWidth × clientHeight`, and `applyViewport`
(`runtime/client/src/render/pixiRenderer.ts`) resizes the Pixi renderer to those
exact dimensions. The scrollbars come from the **DOM/CSS around the canvas**, not
the scaling logic. Three contributing causes, none currently addressed anywhere
in the codebase (no `canvas { display: block }`, no `overflow` rule exist):

1. **Inline canvas baseline gap.** A `<canvas>` defaults to `display: inline`.
   Inline elements sit on the text baseline, reserving ~4–5px of descender space
   _below_ the element. So even when the canvas is exactly `100vh` tall, the
   `#stage` content box becomes `100vh + ~5px` → a vertical scrollbar. This is
   the classic "canvas in a full-height div" overflow.

2. **`100vw` on `#stage`** (`runtime/client/index.html`). `100vw` includes the
   vertical-scrollbar gutter. Once cause #1 produces a vertical scrollbar,
   `100vw` is wider than the remaining content area → a horizontal scrollbar too.
   The two feed each other.

3. **Sub-pixel rounding on fractional DPR.** On 1.25×/1.5× displays, Pixi's
   `autoDensity` can set the canvas CSS size to a sub-pixel value (e.g.
   `800.5px`), which can overflow its container by <1px and trip a scrollbar even
   after #1 and #2 are fixed. This is a rasterization rounding artifact, not a
   logic error — no amount of correct math eliminates it.

## Solution

Seal the container in CSS in `runtime/client/index.html`. This removes the two
structural root causes (#1, #2) declaratively and adds one honest backstop for
the unavoidable rounding artifact (#3):

```css
html,
body {
  margin: 0;
  height: 100%;
  overflow: hidden; /* backstop for sub-pixel rounding on fractional DPR (#3) */
  background: #0b0b0c;
}
#stage {
  width: 100%; /* not 100vw — excludes scrollbar gutter and matches the
                  clientWidth the ViewportController measures (#2) */
  height: 100%;
}
#stage canvas {
  display: block; /* kill the inline baseline descender gap (#1) */
}
```

Why `100%` over `100vw/100vh`: `ViewportController` measures `el.clientWidth /
clientHeight`. `width: 100%` makes the `#stage` layout box agree exactly with
that measurement, so the canvas is sized to precisely fill its box — measurement
and layout are the same number, with no scrollbar gutter in the mix.

Why `overflow: hidden` is justified and not "hiding the bug": once #1 and #2 are
removed, the fit logic _is_ airtight; the only remaining overflow source is the
<1px fractional-DPR rounding in #3, which is a rendering artifact rather than a
logic flaw and cannot be removed by better math.

### Alternatives considered

- **Fix the canvas in JS at mount** (`app.canvas.style.display = 'block'` in
  `pixiRenderer.mount()`): same effect for #1 but scatters layout concerns into
  render code and still needs the `index.html` changes for #2/#3. No advantage.
- **Pure-math only, no `overflow: hidden`**: leaves the fractional-DPR sub-pixel
  scrollbar visible to real users on 1.25×/1.5× displays — a cosmetic regression
  for no benefit.

## Testing

End-to-end is the authoritative contract for client behavior, so add a
**no-overflow e2e assertion** to `runtime/client/e2e/` (alongside the existing
`viewport.e2e.spec.ts`). Load the runtime page at a couple of viewport
sizes/orientations and assert the document never scrolls:

```
scrollingElement.scrollHeight <= clientHeight  &&  scrollWidth <= clientWidth
```

This encodes "the preview never scrolls" as a permanent contract — a future
change that reintroduces overflow fails the suite rather than silently shipping.

## Out of scope

- The studio outer shell / Dockview layout (the user confirmed the scrollbars are
  inside the preview iframe, not the outer Studio window).
- Any change to the viewport fit math — it is correct and untouched.
