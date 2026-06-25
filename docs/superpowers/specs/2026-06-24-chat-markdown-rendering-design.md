# Markdown rendering seam for chat + GDD

**Todo:** octadecimal/bloom #73
**Date:** 2026-06-24
**Branch:** `feat/chat-markdown`

## Problem

Assistant/chat output and the GDD document body currently render as **raw plain
text**. Headings, lists, code blocks, inline code, tables, and links all show as
literal markdown source:

- `studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx:44` — `{step.content}`
  straight into a `<div>`.
- `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx:55` — `{content}`
  straight into the message bubble.
- `studio/frontend/src/plugins/gdd/GddViewerPane.tsx:46` — body rendered inside a
  `<pre className="whitespace-pre-wrap">`.

No markdown library is installed (greenfield).

## Goal

Render that content as proper markdown — headings, lists, fenced + inline code,
GFM tables, links — behind a **one-file render seam** so the underlying library is
swappable. House principle: _prefer proven libraries behind a thin swappable seam._

## Approach

### 1. The seam — `studio/frontend/src/plugins/llm-chat/Markdown.tsx`

A thin, single-file wrapper around `react-markdown` + `remark-gfm`. The only place
in the app that names the markdown library.

```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ source }: { source: string }) {
  return (
    <div className="bloom-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" /> }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
```

- **Security:** no `rehype-raw`, no `dangerouslySetInnerHTML`. react-markdown
  ignores/escapes raw HTML by default, so embedded `<script>`/`<img onerror>` is
  inert — no HTML-injection hole.
- `remark-gfm` adds tables, strikethrough, task lists, autolinks.
- The single `components` override is **behavior** (open links in a new tab
  safely), not styling — visual styling lives in CSS (decision below).
- Swapping the library = editing this one file.

### 2. Styling — a `.bloom-md` block in `styles.css`

Markdown element styling is a CSS descendant block, not an in-component class map.
`styles.css` already carries the design tokens and is **outside** the
`design-language.guard.spec.ts` scan (which only reads `.ts`/`.tsx`), so colors
sourced via `var(--…)` tokens are clean there.

Rules cover `.bloom-md` descendants — `h1..h3`, `p`, `ul/ol/li`, `a`, `code`
(inline), `pre`/`pre code` (block), `blockquote`, `table/th/td`, `hr`, `strong/em`
— using only design tokens:

- text tiers: `var(--text-1)`, `var(--text-2)`, `var(--text-3)`
- surfaces: `var(--raised)` for code wells
- hairlines: `var(--hairline)` for code/table borders
- accent: `var(--accent-text)` for links
- mono: `var(--font-mono)` for inline + block code, legible against `--raised`

Spacing is tuned tight to match the existing `text-[13px] leading-snug` chat
density (no oversized default heading margins).

### 3. Wiring — three one-line swaps

| Site | Before | After |
|---|---|---|
| `RunTurnBlock.tsx:44` | `{step.content}` | `<Markdown source={step.content} />` |
| `ChatRoomPane.tsx:55` | `{content}` | `<Markdown source={content} />` |
| `GddViewerPane.tsx:46` | `<pre…>{body}</pre>` | `<Markdown source={body} />` |

The streaming caret in the two chat sites stays a sibling `<span>` rendered after
`<Markdown>`. With block-level markdown the trailing block is a `<p>`, so the caret
sits just after it — acceptable for in-flight text.

### 4. Streaming safety

Agent text streams token-by-token, so the seam is frequently handed half-formed
markdown (unclosed ``` fences, dangling `**bold`). react-markdown is best-effort
and renders partial input without throwing; a unit test asserts this.

## Components / boundaries

- **`Markdown` (new):** one input `source: string`; one output, a styled DOM
  subtree. No app state, no store coupling. Independently testable and swappable.
- **Call sites (changed):** each replaces a text expression with `<Markdown>`. No
  other logic changes; surrounding containers, avatars, carets, memoization, and
  render-count discipline are untouched.
- **`styles.css` (changed):** one additive `.bloom-md` block. No existing rule
  changes.

## Data flow

`store content string` → call site → `<Markdown source>` → react-markdown +
remark-gfm parse → token-styled DOM under `.bloom-md`. Unchanged: how content
reaches the call site (websocket stream → store leaf → subscribed bubble/step).

## Error handling

- **Malformed/partial markdown:** rendered best-effort, never throws (test-covered).
- **Unsafe HTML in content:** inert by default (no raw-HTML plugin) — test-covered.
- **Unsafe link protocols** (`javascript:`): react-markdown's default URL
  sanitization drops them.

## Testing (TDD) — `Markdown.spec.tsx`

1. heading `# H` → `<h1>` present
2. unordered list → `<li>` items present
3. fenced code block → `<pre><code>` with the code text
4. inline `` `code` `` → `<code>`
5. link `[t](https://x)` → `<a target="_blank" rel="noopener noreferrer">`
6. GFM table → `<table>` with rows
7. **security:** `<script>alert(1)</script>` in source → no live `<script>` element
   in the DOM (rendered inert/as text)
8. **streaming:** partial source (unclosed fence, dangling `**bold`) → renders
   without throwing, text still present

Existing specs stay green: `RunTurnBlock.spec.tsx` / `ChatRoomPane.spec.tsx` /
`GddViewerPane` assertions are `textContent`-based (e.g. `getByText('Done.')`),
which survive the `<p>` wrap react-markdown adds.

## Dependencies

- `react-markdown` v9
- `remark-gfm` v4

Added to the root `package.json` (single-package nx workspace).

## Out of scope (YAGNI)

- Syntax highlighting of code blocks (plain mono is enough; revisit later).
- Raw-HTML passthrough / sanitizer pipeline (explicitly excluded for security).
- Math/KaTeX, footnotes, custom directives.
- Re-styling non-markdown chat chrome.

## Process

Worktree `feat/chat-markdown` (off `main` @ b796aa3, which includes the merged
#74 keyboard work) → TDD execution → CI gates (prettier `--check .`, nx typecheck,
vitest, build) + `just e2e` against replay backend (use per-worktree
`BLOOM_PORT_OFFSET` for isolated serving) → PR → on merge: `gh issue close 73` +
worktree/branch cleanup.
