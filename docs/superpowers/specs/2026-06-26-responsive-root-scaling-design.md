# Responsive root scaling with orientation-aware safe area

**Status:** Design approved — ready for implementation planning
**Date:** 2026-06-26
**Area:** `runtime/client` (Pixi node-graph engine)

## 1. Overview & goal

The client runtime currently mounts a Pixi `Application` at a fixed pixel size
(the Root node's `width`/`height` props, default `800×600`) and never adapts to
the viewport. This design makes the renderer **scale a single root transform so
the active safe area always fits the viewport**, in both portrait and landscape,
with background free to bleed past the safe area and **no over-rendering** (the
canvas is sized to the real viewport, not a fixed design buffer).

It is entirely **engine-internal**: it works identically embedded in the studio
or running a shipped game standalone (`?doc=…`). The studio does nothing and is
unaware of it.

### Behavioral model (settled during brainstorming)

- **Fit the safe area, let background bleed (contain-the-core + cover-the-edges).**
  The safe area is always fully visible; background fills the rest of the screen
  so there are no letterbox bars.
- **The safe area differs by orientation** — there are two safe rects (portrait
  and landscape); the active one is chosen from the viewport's aspect ratio.
- **Only the root is transformed.** No other object computes its own scale.

## 2. Coordinate & fit model

Option 1 — _the active safe area **is** the reference frame_ — plus bleed.

- Content is authored in safe-area logical units, **origin at the safe area's
  top-left** (consistent with existing node coordinates).
- Two safe rects, one per orientation, e.g. `landscape 1280×720`,
  `portrait 720×1280`.
- Orientation = `hostW >= hostH ? 'landscape' : 'portrait'` (square →
  `landscape`, deterministic tiebreak).
- `scale = min(hostW / safeW, hostH / safeH)` → the entire safe area is visible;
  the smaller axis is filled, the larger axis has bleed room.
- `offset = ( (hostW - safeW*scale) / 2, (hostH - safeH*scale) / 2 )` → the safe
  area is centered in the viewport.
- **Only the root container** receives `scale` and `position = offset`. Every
  child inherits that transform; no child computes scale.
- **Bleed:** background sprites are authored oversized (extending past the safe
  rect). They scale with the root; whatever falls outside the canvas is clipped
  by the canvas bounds → fills the screen, no letterbox bars.

```
 viewport (landscape, wide)
┌───────────────────────────────────────┐
│      bleed (background fills here)     │
│   ┌───────────────────────────────┐   │
│   │   SAFE AREA = reference frame  │   │  ← scaled to fit the smaller axis,
│   │   (all gameplay UI lives here) │   │    centered; background bleeds L/R
│   └───────────────────────────────┘   │
│      bleed (background fills here)     │
└───────────────────────────────────────┘
```

## 3. Data & schema — where the safe areas come from

The Root node gains a `safeArea` prop, delivered through the existing
document/protocol:

```jsonc
// Root node props
{
  "safeArea": {
    "landscape": { "width": 1280, "height": 720 },
    "portrait": { "width": 720, "height": 1280 },
  },
}
```

**Fallback chain (back-compat):**

1. If `safeArea` is present, use its `landscape` / `portrait` rects.
2. If only one orientation is defined, use it for **both**.
3. If `safeArea` is absent, fall back to the existing Root `width`/`height` props
   as a single orientation-agnostic safe rect (used for both orientations).
4. If those are absent too, default to `800×600`.

So existing documents keep working unchanged. The Root's `width`/`height` are now
**reinterpreted** as that fallback safe rect — they no longer size the Pixi
canvas (the canvas is the viewport). This is the one behavioral change to an
existing prop; it must be noted in the schema/docs.

`safeArea` may be updated live via `setProp` on the Root; the controller re-reads
and recomputes.

## 4. Components (Approach 1 — pure function + thin controller + renderer seam)

### `computeViewport(host, safeAreas)` — pure function (`render/viewport.ts`)

- **In:** `{ width, height }` host size + resolved `{ landscape, portrait }` safe
  rects.
- **Out:** `IViewport = { orientation, safeArea: { width, height }, scale,
offset: { x, y }, canvas: { width, height }, dpr }`.
- Zero Pixi. This is the entire fit/center/orientation math — the primary
  unit-test target.

### `ViewportController` (`render/viewportController.ts`)

- Owns a `ResizeObserver` on the host element; coalesces fires to a single
  `requestAnimationFrame`.
- On each settled change: read host size → `computeViewport` →
  `renderer.applyViewport(vp)` → if **orientation or safe-area shape** changed,
  `bus.emit('viewport:changed', vp)`.
- `current(): IViewport` getter (tests / standalone observability via
  `__engine*`).
- `setSafeAreas(defs)` lets the reconciler push live Root-prop updates.
- `dispose()` disconnects the observer and cancels any pending frame.

### `IRenderer.applyViewport(vp)` — new interface method (one method on the seam)

- `PixiRenderer`: `app.renderer.resize(canvas.width, canvas.height)`; size the
  canvas CSS to fill the host; apply `scale` / `position` to the root container;
  manage DPR via `resolution`.
- `MockRenderer`: pushes `['applyViewport', vp]` onto `calls` — lets units assert
  exactly what the controller pushed, with no Pixi.

### DPR cap

`dpr = min(window.devicePixelRatio ?? 1, 2)` so retina displays don't 4× the
framebuffer — "only as big as it needs to be".

## 5. Data flow / wiring

1. `createEngine` constructs the `ViewportController` (given renderer, bus, host
   element) and returns it alongside `host` / `model` / `modules`.
2. `reconciler.created()` for the Root reads `safeArea` (with the §3 fallback
   chain) and hands the resolved defs to the controller; `mount` no longer fixes
   a design-size canvas.
3. The controller runs the **first** compute synchronously right after mount (so
   there is never an unsized frame); the `ResizeObserver` drives all subsequent
   updates.
4. A Root `setProp` for `safeArea` → `controller.setSafeAreas(...)` → recompute.
5. `main.ts` exposes `controller.current()` on `window.__engine*` for standalone
   / e2e observability.

## 6. Edge cases & error handling

- **Zero / degenerate host size** (`0×0`, e.g. a hidden pane): skip compute, keep
  the last good viewport, recompute when it becomes non-zero. Never divide by
  zero.
- **Square host** (`hostW === hostH`): deterministic tiebreak → `landscape`.
- **Missing / partial `safeArea`:** fallback chain from §3; never throws.
- **`ResizeObserver` unavailable** (old / test env): fall back to a `window`
  `resize` listener plus one initial compute; behavior degrades gracefully (only
  the studio dock-resize case is lost).
- **rAF coalescing:** multiple observer fires within a frame collapse to one
  compute; `dispose()` cancels any pending frame.
- **Orientation unchanged, size changed:** recompute scale/offset and push to the
  renderer, but **do not** emit `viewport:changed` unless orientation or
  safe-area shape actually changed (avoids reflow churn on every drag pixel).

## 7. Testing (TDD + e2e as source of truth)

**Unit (Vitest, pure):**

- `computeViewport`: landscape / portrait pick incl. square tiebreak; `scale =
min` ratio; centered offset; correct bleed axis; DPR cap; fallback chain;
  zero-size guard.
- `ViewportController` with `MockRenderer` + a fake host: rAF coalescing,
  `applyViewport` payload, `viewport:changed` emitted **only** on orientation /
  shape change, `setSafeAreas` recompute, `dispose`.

**E2e (Playwright, authoritative):**

- Load a doc with distinct portrait / landscape safe areas. Resize the page wide
  → assert canvas = viewport size, root `scale` / `position` match the expected
  fit, a known safe-area-corner node lands at the right on-screen pixel, and the
  background bleeds to the edges (no bars).
- Resize tall → assert the orientation flips, the active safe area swaps, and
  `viewport:changed` fires once.
- Tiny / zero pane → no crash; recovers when resized.

## 8. Scope / non-goals

**In scope:** root scale-to-fit; orientation-dependent safe area; bleed;
viewport-sized canvas + DPR cap; `ResizeObserver` wiring; the `viewport:changed`
bus signal + `current()` getter; the fallback chain.

**Out of scope (deferred seams):**

- Actual per-orientation **reflow** of module / content layout. This slice only
  _exposes_ the `viewport:changed` signal; `ReelsModule` keeps its current
  single-frame layout (it still scales correctly because it is a root child).
- CSS `env()` device-notch insets.
- An outbound protocol `viewport` message to the studio.
- Letterbox-bar styling (we bleed instead).
