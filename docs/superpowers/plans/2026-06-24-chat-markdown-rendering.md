# Markdown Rendering Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render llm-chat assistant/message content and the GDD document body as proper markdown, behind a one-file swappable seam.

**Architecture:** A single `<Markdown source={string} />` component wraps `react-markdown` + `remark-gfm` — the only place the library is named. Markdown element styling lives in a `.bloom-md` token-only CSS block in `styles.css`. Three render call sites swap a raw-text expression for `<Markdown>`.

**Tech Stack:** React 18.3, TypeScript, Vite/nx, Vitest + @testing-library/react, react-markdown v9, remark-gfm v4, Tailwind v4 design tokens.

> **Deviation from spec (intentional):** the spec tentatively placed the seam at `plugins/llm-chat/Markdown.tsx`. Because **two** plugins (llm-chat + gdd) consume it, the plan places it at the shared `studio/frontend/src/components/ui/Markdown.tsx` — matching the existing shared-primitive convention (`Button`, `StatusPill`, `card`) and avoiding a cross-plugin relative import. Content is otherwise identical to the spec.

## Global Constraints

- **Security:** NO `rehype-raw`, NO `dangerouslySetInnerHTML`, NO raw-HTML passthrough. react-markdown's default (raw HTML inert) is the security boundary.
- **Design tokens only:** no raw hex / `rgb()` / `hsl()` in any `.ts`/`.tsx` file (enforced by `studio/frontend/src/design-language.guard.spec.ts`). All markdown colors come from `var(--…)` tokens in `styles.css` only.
- **Dependencies:** `react-markdown@^9`, `remark-gfm@^4`, added to the root `package.json` (single-package nx workspace).
- **Test runner:** `npx nx test frontend -- --run <pattern>` (Vitest, jsdom).
- **Commit trailer:** every commit ends with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P53jankLaX8jfhYbyWvv6H
  ```
- **Branch:** `feat/chat-markdown` (worktree `C:/code/bloom.wt/gdd-structured-content`).

---

### Task 1: The `<Markdown>` seam + unit tests

**Files:**
- Modify: `package.json` (add the two deps)
- Create: `studio/frontend/src/components/ui/Markdown.tsx`
- Test: `studio/frontend/src/components/ui/Markdown.spec.tsx`

**Interfaces:**
- Consumes: nothing (leaf component).
- Produces: `export function Markdown({ source }: { source: string }): JSX.Element` — renders a `<div className="bloom-md">` wrapping `react-markdown` with `remark-gfm`; links get `target="_blank" rel="noopener noreferrer"`. Imported elsewhere as `@/components/ui/Markdown`.

- [ ] **Step 1: Install the dependencies**

Run:
```bash
npm install react-markdown@^9 remark-gfm@^4
```
Expected: both added to `package.json` `dependencies`, exit 0.

- [ ] **Step 2: Write the failing test**

Create `studio/frontend/src/components/ui/Markdown.spec.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './Markdown';

describe('Markdown seam', () => {
  it('renders a heading as <h1>', () => {
    const { container } = render(<Markdown source="# Title" />);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
  });

  it('renders an unordered list as <li> items', () => {
    const { container } = render(<Markdown source={'- one\n- two'} />);
    const items = container.querySelectorAll('li');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe('one');
  });

  it('renders a fenced code block as <pre><code>', () => {
    const { container } = render(<Markdown source={'```js\nconst x = 1;\n```'} />);
    expect(container.querySelector('pre code')?.textContent).toContain('const x = 1;');
  });

  it('renders inline code as <code> outside any <pre>', () => {
    const { container } = render(<Markdown source="use `npm test` now" />);
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('npm test');
    expect(code?.closest('pre')).toBeNull();
  });

  it('renders a link that opens safely in a new tab', () => {
    const { container } = render(<Markdown source="[docs](https://example.com)" />);
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toContain('noopener');
  });

  it('renders a GFM table', () => {
    const { container } = render(<Markdown source={'| a | b |\n| - | - |\n| 1 | 2 |'} />);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('tbody tr').length).toBe(1);
  });

  it('does not execute embedded raw HTML (no injection hole)', () => {
    const { container } = render(<Markdown source={'<script>alert(1)</script><img src=x onerror="alert(2)">'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders partial/streaming markdown without throwing', () => {
    expect(() => render(<Markdown source={'# Head\n\n```js\nconst x = '} />)).not.toThrow();
    expect(() => render(<Markdown source={'**bold and '} />)).not.toThrow();
  });

  it('wraps output in the .bloom-md styling hook', () => {
    const { container } = render(<Markdown source="hi" />);
    expect(container.querySelector('.bloom-md')).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx nx test frontend -- --run Markdown`
Expected: FAIL — `Failed to resolve import "./Markdown"` (component not created yet).

- [ ] **Step 4: Write the minimal implementation**

Create `studio/frontend/src/components/ui/Markdown.tsx`:
```tsx
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Thin, swappable seam: the ONLY place the markdown library is named. Raw HTML is
// inert (no rehype-raw / dangerouslySetInnerHTML) — that default is the security
// boundary. Visual styling lives in the `.bloom-md` token block in styles.css.
const components: Components = {
  // Open links in a new tab safely. `node` (the hast node) must be stripped so it
  // is not spread onto the DOM <a>; `void node` keeps the lint clean.
  a({ node, ...props }) {
    void node;
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
  },
};

export function Markdown({ source }: { source: string }) {
  return (
    <div className="bloom-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx nx test frontend -- --run Markdown`
Expected: PASS — 9 tests green.

- [ ] **Step 6: Confirm the design-token guard still passes**

Run: `npx nx test frontend -- --run design-language.guard`
Expected: PASS (Markdown.tsx carries no raw colors).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json studio/frontend/src/components/ui/Markdown.tsx studio/frontend/src/components/ui/Markdown.spec.tsx
git commit
```
Commit message:
```
feat(ui): markdown render seam (react-markdown + remark-gfm) [#73]

One-file <Markdown> wrapper — the only place the lib is named. Raw HTML
inert (no rehype-raw / dangerouslySetInnerHTML). GFM tables/lists/code,
links open safely in a new tab. Styling hook only (.bloom-md); visuals
land in styles.css next.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P53jankLaX8jfhYbyWvv6H
```

---

### Task 2: `.bloom-md` token-only styling

**Files:**
- Modify: `studio/frontend/src/styles.css` (append one additive block)

**Interfaces:**
- Consumes: the `.bloom-md` wrapper class emitted by Task 1's `Markdown`.
- Produces: legible, token-only styling for every markdown element under `.bloom-md`. No JS interface.

- [ ] **Step 1: Append the styling block to `styles.css`**

Add at the end of `studio/frontend/src/styles.css`:
```css
/* === Markdown content (chat + GDD) — token-only; pairs with the swappable
   seam in components/ui/Markdown.tsx. Tuned tight to the 13px chat density. === */
.bloom-md {
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.5;
}
.bloom-md > :first-child {
  margin-top: 0;
}
.bloom-md > :last-child {
  margin-bottom: 0;
}
.bloom-md p {
  margin: 0.5em 0;
}
.bloom-md h1,
.bloom-md h2,
.bloom-md h3,
.bloom-md h4 {
  color: var(--text-1);
  font-weight: 600;
  line-height: 1.3;
  margin: 0.8em 0 0.4em;
}
.bloom-md h1 {
  font-size: 1.3em;
}
.bloom-md h2 {
  font-size: 1.15em;
}
.bloom-md h3 {
  font-size: 1.05em;
}
.bloom-md h4 {
  font-size: 1em;
}
.bloom-md ul,
.bloom-md ol {
  margin: 0.4em 0;
  padding-left: 1.4em;
}
.bloom-md li {
  margin: 0.15em 0;
}
.bloom-md li > ul,
.bloom-md li > ol {
  margin: 0.15em 0;
}
.bloom-md a {
  color: var(--accent-text);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.bloom-md a:hover {
  color: var(--accent-hover);
}
.bloom-md code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--raised);
  border: 1px solid var(--hairline);
  border-radius: 4px;
  padding: 0.05em 0.3em;
}
.bloom-md pre {
  background: var(--raised);
  border: 1px solid var(--hairline);
  border-radius: 6px;
  padding: 0.6em 0.8em;
  overflow-x: auto;
  margin: 0.5em 0;
}
.bloom-md pre code {
  background: none;
  border: none;
  border-radius: 0;
  padding: 0;
  color: var(--text-1);
}
.bloom-md blockquote {
  margin: 0.5em 0;
  padding-left: 0.8em;
  border-left: 2px solid var(--hairline-strong);
  color: var(--text-2);
}
.bloom-md table {
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.95em;
}
.bloom-md th,
.bloom-md td {
  border: 1px solid var(--hairline);
  padding: 0.3em 0.6em;
  text-align: left;
}
.bloom-md th {
  background: var(--raised);
  color: var(--text-1);
  font-weight: 600;
}
.bloom-md hr {
  border: none;
  border-top: 1px solid var(--hairline);
  margin: 0.8em 0;
}
.bloom-md strong {
  color: var(--text-1);
  font-weight: 600;
}
.bloom-md em {
  font-style: italic;
}
.bloom-md img {
  max-width: 100%;
}
```

- [ ] **Step 2: Verify the build compiles the CSS**

Run: `npx nx build frontend`
Expected: build succeeds (CSS is valid; no token typos break the bundle).

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/src/styles.css
git commit
```
Commit message:
```
style(ui): token-only .bloom-md markdown styling [#73]

Headings/lists/code/tables/links/blockquote styled from design tokens
(var(--text-*/raised/hairline/accent-text/font-mono)). Tuned to 13px
chat density. CSS-only; no component changes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P53jankLaX8jfhYbyWvv6H
```

---

### Task 3: Wire the three render call sites

**Files:**
- Modify: `studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx` (line 44 region + import)
- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx` (line 55 region + import)
- Modify: `studio/frontend/src/plugins/gdd/GddViewerPane.tsx` (line 46 region + import)
- Test: existing `RunTurnBlock.spec.tsx`, `ChatRoomPane.spec.tsx`, `GddViewerPane.spec.tsx` must stay green.

**Interfaces:**
- Consumes: `import { Markdown } from '@/components/ui/Markdown';` (Task 1).
- Produces: no new interface; three text expressions become `<Markdown source=… />`.

- [ ] **Step 1: Confirm the existing specs are green BEFORE the change (regression baseline)**

Run: `npx nx test frontend -- --run RunTurnBlock ChatRoomPane GddViewer`
Expected: PASS (30 tests). This is the baseline these edits must preserve.

- [ ] **Step 2: Wire `RunTurnBlock.tsx`**

Add the import near the top (after the existing `./toolFold` import):
```tsx
import { Markdown } from '@/components/ui/Markdown';
```
Replace the `RunStepCard` text render. Change:
```tsx
    <div data-testid={`run-step-${index}`} className="text-[13px] leading-snug text-foreground">
      {step.content}
      {isRunning && (
```
to:
```tsx
    <div data-testid={`run-step-${index}`} className="text-[13px] leading-snug text-foreground">
      <Markdown source={step.content} />
      {isRunning && (
```

- [ ] **Step 3: Wire `ChatRoomPane.tsx`**

Add the import near the top (after the `./fuzzySkills` import):
```tsx
import { Markdown } from '@/components/ui/Markdown';
```
Replace the message-bubble text render. Change:
```tsx
        <div className="text-[13px] leading-snug text-foreground">
          {content}
          {status === 'streaming' && (
```
to:
```tsx
        <div className="text-[13px] leading-snug text-foreground">
          <Markdown source={content} />
          {status === 'streaming' && (
```

- [ ] **Step 4: Wire `GddViewerPane.tsx`**

Add the import near the top of the file (alongside its existing imports):
```tsx
import { Markdown } from '@/components/ui/Markdown';
```
Replace the body render. Change:
```tsx
        <pre className="whitespace-pre-wrap text-sm text-text-1">{current?.body || ''}</pre>
```
to:
```tsx
        <Markdown source={current?.body || ''} />
```

- [ ] **Step 5: Run the affected specs**

Run: `npx nx test frontend -- --run RunTurnBlock ChatRoomPane GddViewer`
Expected: PASS (30 tests). The existing assertions are `textContent`-based (`getByText('Done.')`, etc.) and survive the `<p>` wrap react-markdown adds. If a spec asserts an exact element shape that the `<p>` wrap breaks, update that single assertion to a `textContent`/`getByText` check — do NOT loosen a security or behavior assertion.

- [ ] **Step 6: Run the full frontend suite + typecheck + guard**

Run:
```bash
npx nx test frontend -- --run
```
Expected: entire suite PASS (new Markdown spec + all existing).

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/gdd/GddViewerPane.tsx
git commit
```
Commit message:
```
feat(chat,gdd): render message + GDD body as markdown [#73]

Swap the three raw-text render sites for the <Markdown> seam: chat run
steps, chat message bubbles, and the GDD viewer body. Streaming caret
stays a sibling after the markdown block.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P53jankLaX8jfhYbyWvv6H
```

---

### Task 4: Full CI gate + manual verification

**Files:** none (verification only).

- [ ] **Step 1: Prettier**

Run: `npx prettier --check .`
Expected: pass. If it reports the new files, run `npx prettier --write .` on them and amend/extend the prior commit.

- [ ] **Step 2: Typecheck**

Run: `npx nx typecheck frontend` (or `npx tsc -p studio/frontend/tsconfig.app.json --noEmit` if no typecheck target).
Expected: 0 errors.

- [ ] **Step 3: Build**

Run: `npx nx build frontend`
Expected: build succeeds.

- [ ] **Step 4: Full vitest run**

Run: `npx nx test frontend -- --run`
Expected: all suites pass.

- [ ] **Step 5: e2e against replay backend**

This worktree was created with bare `git worktree add`, so it has no assigned `BLOOM_PORT_OFFSET`. Assign a free offset first (mirror `just wt-new`):
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File tools/wt-assign-offset.ps1 .
```
Then, in a backend shell:
```bash
just backend-serve-replay   # honors BLOOM_PORT_OFFSET from this worktree's .env
```
And run the deterministic e2e:
```bash
just e2e
```
Expected: e2e green. (If another session holds the default ports, the offset keeps this run isolated — see the `worktree-independent-ports` note.)

- [ ] **Step 6: Manual eyeball (optional but recommended)**

Serve the frontend (`just serve-frontend`) against a live or replay backend and confirm a markdown-rich assistant message + the GDD body render with headings/lists/code/tables on-token, and that a streaming message doesn't flicker or crash on half-formed syntax. Per the visual-fidelity note, confirm it matches the studio look (no oversized default margins).

---

## Self-Review

**Spec coverage:**
- Seam (one file, library named once) → Task 1 ✓
- Security (no rehype-raw / dangerouslySetInnerHTML / raw HTML) → Task 1 impl + Task 1 Step-2 injection test ✓
- GFM (tables/lists/code/links) → Task 1 tests ✓
- Streaming graceful partial render → Task 1 streaming test ✓
- Token-only styling in CSS → Task 2 + guard check (Task 1 Step 6) ✓
- Three call sites wired (chat run step, chat bubble, GDD body) → Task 3 ✓
- Existing specs stay green → Task 3 Steps 1/5/6 ✓
- CI gates (prettier, typecheck, build, vitest, e2e) → Task 4 ✓

**Placeholder scan:** every code/CSS/test step shows complete content; no TBD/TODO. The only conditional ("if a spec asserts exact element shape…") includes the concrete corrective action. ✓

**Type consistency:** `Markdown({ source }: { source: string })` is defined in Task 1 and consumed identically in Task 3 (`<Markdown source={…} />`), imported from `@/components/ui/Markdown` everywhere. ✓
