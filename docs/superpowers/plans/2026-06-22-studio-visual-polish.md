# Studio Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-generic the shipped dark-editor UI — monochrome chat chips (no rainbow avatars), rationed accent (one filled primary per surface), and real Dockview group slabs — without changing any behavior.

**Architecture:** Targeted re-skin on top of PR #38. Add one `Button` variant and lift `Card` to a raised surface; rebuild `ChatMessageBubble`'s presentation (deleting the `avatarHue` rainbow); swap accent usages (Generate→outline, Delete→ghost, Send→icon); and style the real Dockview `.dv-groupview` group containers so panels read as separated slabs. Render isolation and every test hook are preserved.

**Tech Stack:** React 18, TypeScript, Tailwind v4 (`@theme inline`), Vitest + Testing Library, Dockview v6, `lucide-react`, Playwright (local-only e2e).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-22-studio-visual-polish-design.md`. Spec wins on disagreement.
- **No backend/protocol/state/reducer/render-strategy changes.** `studio/frontend` only.
- **Preserve every test hook & behavior:** all `data-testid`, `data-role`, `data-status`, `data-state`, `role`/ARIA, placeholders, option labels. Existing unit + Playwright specs stay green unless this plan says to update one.
- **Render isolation (chat):** keep the `ChatRoomPane → MessageList → ChatMessageBubble` split and every `bumpRenderCount('…')` name. No new pane/list-level subscription to message content; `MessageList` stays `messages.length`-only. The "appending a token re-renders only that bubble" test must stay green.
- **Tokens-only:** no raw hex / Tailwind palette colors in components. Utilities must resolve to a token in `styles.css`.
- **`I`-prefix** on interfaces.
- **Tooling/PATH:** Node is not always on the Git Bash PATH — prepend `export PATH="/c/Program Files/nodejs:$PATH"` in every command. Run from repo root `C:/code/bloom`.
- **Per-task hygiene:** `npx prettier --write <changed files>` before each commit; Conventional Commits; branch `feat/studio-visual-polish`. `main` is protected — land via squash PR.
- **Test commands:** single file `npx nx test frontend -- <pathFromRepoRoot>`; whole suite `npx nx test frontend`; typecheck `npx nx run frontend:typecheck`; build `npx nx build frontend`; e2e (replay, local-only) `just e2e`; `prettier --check .` is run **from the repo root** (CI covers `docs/`).

---

## Task 0: Branch

- [ ] **Step 1: Create the working branch from the spec branch**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
git checkout docs/studio-visual-polish
git checkout -b feat/studio-visual-polish
```

(The spec lives on `docs/studio-visual-polish`; branching from it keeps spec + plan with the code for one PR.)

---

## Task 1: `Button` — `accentOutline` variant

**Files:**

- Modify: `studio/frontend/src/components/ui/button.tsx`
- Test: `studio/frontend/src/components/ui/button.spec.tsx`

**Interfaces:**

- Produces: `Button` gains `variant="accentOutline"` (`border border-primary/45 bg-transparent text-accent-text hover:bg-primary/10`). `IButtonProps` unchanged. Consumed by Tasks 4 (AssetCard `Generate`).

- [ ] **Step 1: Add a failing test to `button.spec.tsx`**

```tsx
it('renders the accentOutline variant', () => {
  const { getByRole } = render(<Button variant="accentOutline">Generate</Button>);
  const cls = getByRole('button').className;
  expect(cls).toContain('border-primary/45');
  expect(cls).toContain('text-accent-text');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/button.spec.tsx
```

Expected: FAIL — `accentOutline` is not a known variant (renders default classes).

- [ ] **Step 3: Add the variant in `button.tsx`**

In the `variants.variant` map (after `destructive`), add:

```tsx
      accentOutline: 'border border-primary/45 bg-transparent text-accent-text hover:bg-primary/10',
```

- [ ] **Step 4: Run to verify pass**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/button.spec.tsx
```

Expected: PASS (existing variant/size tests + the new one).

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/components/ui/button.tsx studio/frontend/src/components/ui/button.spec.tsx
git add studio/frontend/src/components/ui/button.tsx studio/frontend/src/components/ui/button.spec.tsx
git commit -m "feat(studio): Button accentOutline variant"
```

---

## Task 2: `Card` — lift to the raised surface

**Files:**

- Modify: `studio/frontend/src/components/ui/card.tsx`
- Test: `studio/frontend/src/components/ui/card.spec.tsx`

- [ ] **Step 1: Update the failing assertion in `card.spec.tsx`**

Change the surface-token test body to expect `bg-raised`:

```tsx
it('uses the raised surface token and drops the drop-shadow', () => {
  const { container } = render(<Card>x</Card>);
  const cls = (container.firstChild as HTMLElement).className;
  expect(cls).toContain('bg-raised');
  expect(cls).not.toContain('shadow');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/card.spec.tsx
```

Expected: FAIL — Card currently renders `bg-surface`.

- [ ] **Step 3: Update `Card` in `card.tsx`**

Change only the `Card` root className (leave Header/Content/Footer untouched):

```tsx
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-md border border-border bg-raised', className)} {...props} />;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/card.spec.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/components/ui/card.tsx studio/frontend/src/components/ui/card.spec.tsx
git add studio/frontend/src/components/ui/card.tsx studio/frontend/src/components/ui/card.spec.tsx
git commit -m "feat(studio): lift Card onto the raised surface"
```

---

## Task 3: Chat feed — monochrome chips, hierarchy, density

Rebuild `ChatMessageBubble`'s presentation and tighten `MessageList`. Delete the `avatarHue` rainbow. **Keep render isolation, all testids, `data-role`/`data-status`, and the caret.**

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`
- Test: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx` (append assertions)
- Delete: `studio/frontend/src/plugins/llm-chat/avatarColor.ts`, `studio/frontend/src/plugins/llm-chat/avatarColor.spec.ts`

- [ ] **Step 1: Add failing presentation assertions to `ChatRoomPane.spec.tsx`**

Append inside `describe('ChatRoomPane', …)`:

```tsx
it('renders a monochrome avatar chip with no rainbow inline style', () => {
  chatSlice().messages.set([msg({ id: 'h1', author: 'Alice', role: 'user', content: 'hey' })]);
  render(<ChatRoomPane />);
  const chip = screen.getByTestId('chat-msg-h1').querySelector('[aria-hidden]') as HTMLElement;
  expect(chip).toBeTruthy();
  expect(chip.getAttribute('style')).toBeNull(); // avatarHue HSL removed
  expect(chip.textContent).toBe('a'); // lowercased initial
});

it('marks the assistant bubble with an accent rule and an "ai" chip', () => {
  chatSlice().messages.set([msg({ id: 'a9', author: 'assistant', role: 'assistant', content: 'hi' })]);
  render(<ChatRoomPane />);
  const bubble = screen.getByTestId('chat-msg-a9');
  expect(bubble.className).toContain('border-primary/50');
  const chip = bubble.querySelector('[aria-hidden]') as HTMLElement;
  expect(chip.textContent).toBe('ai');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx nx test frontend -- studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
```

Expected: FAIL — the current avatar is a round disk with an inline HSL style and uppercase initial; assistant has no `border-primary/50` rule.

- [ ] **Step 3: Replace `ChatMessageBubble` and remove the `avatarHue` import**

Delete the import line `import { avatarHue } from './avatarColor';` and replace the whole `ChatMessageBubble` function with:

```tsx
function ChatMessageBubble({ index }: { index: number }) {
  const s = llmChatHooks.usePluginState();
  const m = s.messages[index];
  bumpRenderCount('ChatMessageBubble');

  const id = m.id.get();
  const author = m.author.get();
  const role = m.role.get();
  const status = m.status.get();
  const content = m.content.get();
  const isAssistant = role === 'assistant';
  const initial = (author.trim()[0] ?? '?').toLowerCase();

  return (
    <li
      data-testid={`chat-msg-${id}`}
      data-role={role}
      data-status={status}
      className={`flex gap-2 rounded-r ${isAssistant ? 'border-l-2 border-primary/50 bg-primary/[0.04] pl-2' : ''}`}
    >
      <div
        aria-hidden
        className={`mt-px flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border bg-raised font-mono text-[9px] ${
          isAssistant ? 'border-primary/30 text-accent-text' : 'border-border text-muted-foreground'
        }`}
      >
        {isAssistant ? 'ai' : initial}
      </div>
      <div className="min-w-0">
        <div className={`text-[10.5px] font-semibold leading-tight ${isAssistant ? 'text-accent-text/90' : 'text-muted-foreground'}`}>{author}</div>
        <div className="text-[13px] leading-snug text-foreground">
          {content}
          {status === 'streaming' && (
            <span data-testid="chat-caret" className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 rounded-sm bg-primary align-baseline" />
          )}
        </div>
      </div>
    </li>
  );
}
```

- [ ] **Step 4: Tighten `MessageList` rhythm**

In `MessageList`, change the `<ul>` vertical gap to `gap-1.5` (it is currently `gap-2.5`). The full className becomes:

```tsx
    <ul data-testid="chat-messages" className="m-0 flex flex-1 list-none flex-col gap-1.5 overflow-auto p-0">
```

- [ ] **Step 5: Delete the now-unused avatar module**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
grep -rn "avatarHue\|avatarColor" studio/frontend/src   # expect: no matches now
git rm studio/frontend/src/plugins/llm-chat/avatarColor.ts studio/frontend/src/plugins/llm-chat/avatarColor.spec.ts
```

- [ ] **Step 6: Run the chat spec — all green**

```bash
npx nx test frontend -- studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
```

Expected: PASS — the two new assertions plus all existing tests (empty state, send, connection, **render-isolation count**, author label, caret present/absent, destructive error).

- [ ] **Step 7: Typecheck (catch the dropped import)**

```bash
npx nx run frontend:typecheck
```

Expected: PASS (no dangling `avatarHue` reference).

- [ ] **Step 8: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
git add -A studio/frontend/src/plugins/llm-chat
git commit -m "feat(studio): monochrome chat chips + sharpened hierarchy (drop rainbow avatars)"
```

---

## Task 4: Ration the accent — Generate / Delete / Send

**Files:**

- Modify: `studio/frontend/src/plugins/assets/AssetCard.tsx`, `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`
- Tests (must stay green): `studio/frontend/src/plugins/assets/AssetCard.spec.tsx`, `ChatRoomPane.spec.tsx`

- [ ] **Step 1: AssetCard — `Generate` → accentOutline, `Delete` → ghost**

In `AssetCard.tsx`, change the two footer buttons (keep testids + handlers):

```tsx
<CardFooter className="justify-between">
  <Button data-testid="asset-generate" variant="accentOutline" onClick={() => generateAsset(id)} disabled={busy}>
    {generations.length > 0 ? 'Generate again' : 'Generate'}
  </Button>
  <Button variant="ghost" onClick={() => void deleteAsset(id)}>
    Delete
  </Button>
</CardFooter>
```

- [ ] **Step 2: ChatRoomPane — `Send` → filled accent icon button**

Add the icon import at the top of `ChatRoomPane.tsx`:

```tsx
import { ArrowUp } from 'lucide-react';
```

Replace the Send button (keep `data-testid="chat-send"` + `onClick={submit}`; add `aria-label`):

```tsx
<Button data-testid="chat-send" size="icon" aria-label="Send" onClick={submit}>
  <ArrowUp className="h-4 w-4" />
</Button>
```

- [ ] **Step 3: Run the affected specs — green**

```bash
npx nx test frontend -- studio/frontend/src/plugins/assets/AssetCard.spec.tsx
npx nx test frontend -- studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
```

Expected: PASS. The chat spec's send test clicks `chat-send` by testid (unaffected by the text→icon change). If `AssetCard.spec.tsx` asserted the Delete button's `outline` variant class, update it to `ghost`; if it selected Generate by text it still matches.

- [ ] **Step 4: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/assets/AssetCard.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx
git add studio/frontend/src/plugins/assets/AssetCard.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx
git commit -m "feat(studio): ration the accent (Generate outline, Delete ghost, Send icon)"
```

---

## Task 5: Defined panel slabs — Dockview group framing

CSS-only (no unit test); verified by build + the controller's visual check in Task 6. The group container must read as a separated, bordered, lifted slab. Start from the guaranteed baseline (border + radius + shadow), then attempt a gutter gap with the documented fallback.

**Files:**

- Modify: `studio/frontend/src/styles.css` (append to the `.dockview-theme-bloom` section)

- [ ] **Step 1: Confirm the real group class name**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
grep -oE '\.dv-(groupview|view|view-container|active-group|inactive-group|sash)\b' node_modules/dockview-core/dist/styles/dockview.css | sort -u
```

Expected: includes `.dv-groupview` (the group's view box). Use the names that actually appear; the baseline below targets `.dv-groupview`.

- [ ] **Step 2: Add the slab framing (baseline) to `styles.css`**

Append inside the `.dockview-theme-bloom` block area (after the existing `--dv-*` rules):

```css
/* Panel slabs: each Dockview group reads as a separated, lifted slab on the gutter. */
.dockview-theme-bloom .dv-groupview {
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
}
```

- [ ] **Step 3: Attempt a gutter gap (best-effort, with fallback)**

Make the resize sash read as gutter so groups visually separate. Add:

```css
.dockview-theme-bloom .dv-sash {
  background: var(--bg);
}
```

Then run the app (Step 5) and check the groups separate without layout breakage. **If the groups overlap, clip, or the sash/resize/drag-drop misbehaves**, remove this `.dv-sash` rule and rely on the Step 2 border+radius+shadow alone (still a clear slab edge) — note in the report which path you kept and why.

- [ ] **Step 4: Build**

```bash
npx nx build frontend
```

Expected: build succeeds.

- [ ] **Step 5: Manual layout check**

```bash
npx nx serve frontend
```

With a multi-pane layout open: confirm each group is a bordered, slightly-raised slab on the darker gutter; the cards (now `bg-raised`) lift off the pane; and resize sashes + tab drag + panel drop still work. Adjust the border/shadow/gap to taste; keep the fallback if the gap breaks layout. Stop the server.

- [ ] **Step 6: Commit**

```bash
npx prettier --write studio/frontend/src/styles.css
git add studio/frontend/src/styles.css
git commit -m "feat(studio): defined Dockview group slabs over the gutter"
```

---

## Task 6: Verify + e2e + review + PR

**Files:** none (verification only).

- [ ] **Step 1: Full frontend gate (all must pass)**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
npx prettier --check .
npx nx run frontend:typecheck
npx nx test frontend
npx nx build frontend
```

Expected: all green. Fix any failure before proceeding.

- [ ] **Step 2: Browser e2e (replay tier) — required before PR**

Per the repo rule, run the Playwright suite against a **replay** backend on :8000, then restore live. If a live backend occupies :8000, swap it (kill the `--reload` worker AND its inherited-socket `multiprocessing` child), run replay, then restore live (`uvicorn app.main:app --reload --port 8000`, default = live) and verify `/health` = live via `http://127.0.0.1:8000/health`.

```bash
# (replay backend on :8000 first)
just e2e
```

Expected: full suite green. `llm-chat.spec` (author-labeled feed, `chat-send` click) and `styling.spec` (`chat-send` is `bg-primary` + `h-7` icon) stay green. If any spec asserts removed structure (e.g. a literal "Send" label), update it to the new contract (icon + `aria-label`) and re-run.

- [ ] **Step 3: Visual screenshot check**

Drive a logged-in workbench (chat + asset board) and screenshot it. Confirm: no rainbow avatars (monochrome chips), assistant marked by tint+rule not a disk, dim author names / bright content, only the singular primary buttons are filled orange, and the panels read as separated lifted slabs. Fix any token/contrast issue.

- [ ] **Step 4: Whole-branch review**

Use **superpowers:requesting-code-review** against the full branch diff (base = the commit `feat/studio-visual-polish` started from). Address Critical/Important findings.

- [ ] **Step 5: Open the PR and merge after CI**

```bash
git push -u origin feat/studio-visual-polish
gh pr create --base main --fill --title "feat(studio): visual polish — de-generic craft pass"
# after CI is green:
gh pr merge --squash --delete-branch
```

---

## Self-Review (author checklist — completed)

**1. Spec coverage:**

- Chat feed: mono chips / hierarchy / assistant tint+rule / density / delete avatarColor → Task 3. ✓
- Accent rationing: `accentOutline` variant + Generate/Delete/Send → Tasks 1, 4. ✓
- Panel slabs: Dockview `.dv-groupview` framing + gutter + card lift (`bg-raised`) → Tasks 5, 2. ✓
- Hierarchy/density sweep → folded into Task 3 (chat) + Task 2 (card lift); other surfaces already use `muted-foreground` for metadata. ✓
- Testing: TDD units (Tasks 1–3) + preserved e2e run before PR + restore live → Task 6. ✓
- Risks: Dockview gap fallback (Task 5 Step 3), render isolation (Task 3 constraint + test), Send icon (Task 4 + Task 6 Step 2). ✓

**2. Placeholder scan:** Every code step shows full code; no "handle X"/TODO. Task 5 is CSS with an explicit baseline + fallback, not a placeholder. ✓

**3. Type consistency:** `accentOutline` defined in Task 1, consumed in Task 4. `bg-raised`/`text-accent-text`/`border-primary/*`/`bg-primary/[0.04]` all resolve to tokens defined in `styles.css` (`--raised`, `--accent-text`, `--primary`). `lucide-react` `ArrowUp` is a real export (package already used for `Search`/`X`). Testids (`chat-send`, `asset-generate`, `chat-msg-*`, `chat-caret`) unchanged. ✓
