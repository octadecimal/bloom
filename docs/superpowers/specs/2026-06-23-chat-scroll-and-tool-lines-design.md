# Design — llm-chat scroll & tool-line polish

**Date:** 2026-06-23
**Status:** approved (brainstorming), pending implementation plan
**Scope:** `studio/frontend/src/plugins/llm-chat` — view layer only

## Summary

Two independent UX refinements to the Studio chat, both confined to the
frontend view layer. No changes to the socket wire protocol, reducers, plugin
state, or the backend.

- **A. Sticky-bottom auto-scroll** — the message feed should follow new
  content while the user is at the bottom, leave them alone when they have
  scrolled up to read history, and offer a "jump to latest" affordance to
  return.
- **B. Collapsed borderless tool lines** — a tool currently renders as two
  bordered, uppercase-labelled cards (`tool_call` + `tool_result`). Collapse
  each call/result pair into **one** subtle, borderless line of text with a
  clear running indicator.

Either change can ship on its own; they share no code.

## Context (current behaviour)

- `MessageList` in `ChatRoomPane.tsx` renders
  `<ul data-testid="chat-messages" class="… flex-1 overflow-auto">` with **no
  scroll logic at all**. Streaming content never follows the viewport.
- Memoised `ChatMessageBubble` / `RunTurnBlock` subscribe to their own state
  nodes; a streaming token replaces a node's identity in place and re-renders
  only that bubble, **not** the `MessageList` shell. Any scroll solution must
  preserve this render-count discipline.
- `RunStepCard` in `RunTurnBlock.tsx` renders each tool step as a bordered card
  (`rounded-md border p-2`) with an uppercase `TOOL CALL` / `TOOL RESULT`
  label, a static dot when running, and the tool name on its own line.
- The backend emits `tool_call` and `tool_result` as **separate steps**, each
  with its own `index`, arriving in order (call then result). `IRunStep.status`
  is `running | complete | error`. Pairing is therefore a pure view-layer fold;
  no wire change is needed.

## Feature A — Sticky-bottom auto-scroll + jump button

### Approach

Introduce a small dedicated `MessageScroller` component that owns the scroll
container ref and a single `showJump` boolean. `MessageList` builds the feed and
creates the child bubble/run elements as today, then passes them as `children`
into `<MessageScroller>`. Because the bubbles are passed as `children`, the
scroller's own state changes (`showJump` toggling) do **not** re-render them —
render-count discipline is preserved.

### Behaviour

- **Pinned tracking.** A pure helper
  `isAtBottom({ scrollTop, clientHeight, scrollHeight }, threshold = 48)`
  decides whether the viewport is "near the bottom." An `onScroll` handler
  updates a `pinnedRef` (a ref, not state, so scrolling does not re-render) and
  calls `setShowJump` **only when the boolean actually flips**, avoiding
  per-event state churn.
- **Following content.** A `ResizeObserver` on the `<ul>` fires on both new
  entries and streaming token growth (the latter never re-renders the list
  shell, so a length-keyed effect would miss it). When it fires and
  `pinnedRef.current` is `true`, set `scrollTop = scrollHeight`. This is what
  keeps a streaming reply stuck to the bottom without extra React renders.
- **Jump button.** Rendered only when `showJump` is true (i.e. the user has
  scrolled up). A small floating chevron (`lucide ArrowDown`) anchored
  bottom-right of the feed. Click → scroll to bottom and re-pin. Styled per the
  design language: raised/ghost surface, hairline border, accent on hover. Plain
  chevron — no unread count (YAGNI).

### Testing

- **Unit.** The pure `isAtBottom` helper, including boundary cases (exactly at
  bottom, within threshold, above threshold, zero-height container).
- **E2E (authoritative).** A Playwright spec (extend `llm-chat.spec.ts` or add
  `chat-scroll.spec.ts`): fill the feed past one viewport, scroll up → assert the
  jump button appears; click it → assert the feed returns to the bottom and the
  button disappears; with the feed pinned, send another message → assert it stays
  pinned to the bottom. jsdom has no layout, so the real behaviour lives here.

## Feature B — Collapsed borderless tool lines

### Approach

A pure transform `foldToolSteps(steps: IRunStep[])` pairs each `tool_result`
with the **nearest preceding unmatched `tool_call`** (robust to the same tool
being invoked twice in a row). It returns an ordered list of render entries:

- `thinking` / `final` → pass through unchanged (streamed text).
- `approval` / `question` → pass through unchanged (existing cards).
- `tool_call` (+ optional paired `tool_result`) → a single merged **tool**
  entry carrying `{ kind: 'tool', toolName, status, callIndex }`.

Merged status:

- `error` if the call **or** the result has status `error`;
- `complete` once a paired result arrives with status `complete`;
- otherwise `running` (a call with no result yet, regardless of the call step's
  own `complete` status — the tool is still in flight until its result lands).

A `tool_result` with no matching preceding call (defensive / out-of-order) is
rendered as its own tool entry rather than dropped.

### Line appearance (spinner + shimmer)

One borderless, muted, single line. No `border`, no background fill.

- **running** — `lucide Loader2` spinner (`animate-spin`, `text-accent-text`) +
  the tool name rendered with a **shimmer** animation.
- **complete** — static `lucide Check` glyph + steady muted tool name
  (`text-muted-foreground`). Calm, not green — `--success` stays rationed.
- **error** — `lucide X` glyph + tool name, both in `--danger`. Drops today's
  red bordered card entirely.

The shimmer is a **token-only** keyframe added to `styles.css` (a moving
`linear-gradient(--text-3 → --text-1 → --text-3)` clipped to the text via
`background-clip: text`), so the no-raw-color guard
(`design-language.guard.spec.ts`) still passes — no raw colours leave
`styles.css`. A `prefers-reduced-motion: reduce` media query disables both the
shimmer and the spinner animation, falling back to a static glyph.

### Stable test hooks

The merged tool line keeps `data-testid="run-step-${callIndex}"` (so existing
selectors and the `RunTurnBlock` unit test stay valid) and gains
`data-state="running | complete | error"` for assertions.

### Testing

- **Unit — `foldToolSteps`.** Pairing of adjacent call/result; the same tool
  name called twice (correct, non-greedy pairing); a lone call → `running`;
  error propagation from either side; non-tool steps pass through untouched;
  a result with no matching call renders defensively.
- **Unit — `RunTurnBlock`.** One line per tool with the correct `data-state`;
  no border classes on the tool line; thinking/final still render as text.
- **E2E.** Existing `skill-run.spec.ts` asserts
  `chat-messages` `toContainText('generate_asset')` — still passes, since the
  tool name renders once in the collapsed line. No e2e change required for the
  happy path; optionally assert `data-state="complete"` on the settled line.

## Out of scope (YAGNI)

- Click-to-expand tool args / results.
- Persisting scroll position or collapse state across reloads.
- Any change to the socket wire protocol, reducers, or backend.
- Unread-count badge on the jump button.
- Restyling thinking / final / approval / question rendering.
