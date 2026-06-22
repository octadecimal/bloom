# Studio Visual Polish — De-generic Craft Pass

**Date:** 2026-06-22
**Status:** Design (approved, pre-plan)
**Scope:** `studio/frontend` only — the chat feed, the `Button` primitive + its
accent usages, the `Card` surface, and the **Dockview group framing** in `styles.css`.
No backend/protocol/state/reducer changes.

## Problem

The dark game-editor identity (PR #38) re-skinned the studio, but the live result still
reads as "AI-generated" because the **composition and detailing** are generic. Concretely,
from the shipped UI:

1. **Rainbow letter-in-a-circle avatars** (`ChatMessageBubble`) — per-author HSL hues via
   `avatarHue` + a solid-orange assistant disk repeated down the column. This is the single
   most overused generated-chat trope and the biggest tell.
2. **Accent overuse** — every button is a bright-orange fill (`Add asset`, `Generate`,
   `Send`), plus the orange AI avatars. The accent should be rare; right now it is
   everywhere.
3. **Flat hierarchy** — author name and message body are near-equal weight/brightness; the
   feed reads as a wall of identical chips rather than a scannable transcript.
4. **Panels don't read as panels** — the Dockview groups render edge-to-edge with a
   near-invisible hairline. The first redesign themed only the **tabs** (`--dv-*`) and added
   an in-pane `PanelHeader`; it never styled the Dockview **group containers**, so the slab
   framing the design intends never reached the real layout.

## Goals

Bring craft to the existing identity so the studio reads as a designed tool:

1. **Chat feed** — replace rainbow disks with restrained monochrome chips, sharpen the
   type hierarchy (metadata recedes, content leads), mark the assistant with a faint tint +
   thin accent rule instead of a loud disk, and tighten the rhythm.
2. **Ration the accent** — one filled primary per surface; the repeated card action drops
   to an accent outline; quiet/secondary actions go ghost; the composer Send becomes a
   compact accent icon.
3. **Defined panel slabs** — style the real Dockview group containers so each group reads as
   a separated, bordered, slightly-lifted slab on the gutter; lift cards off their pane.
4. Preserve every test hook, the render-isolation architecture, and all behavior.

## Non-goals (YAGNI)

- No backend/protocol/state/reducer/render-strategy changes.
- No new chat/asset features (no threading, reactions, uploaded avatars, message editing).
- No new layout/navigation, no Dockview behavior changes (drag/drop/resize/tabs unchanged —
  **theming only**).
- No palette change beyond what's listed; the slate + fire-orange identity stands.
- No new density toggle; compact baseline stays.

## Current architecture (reference)

- **Chat:** `plugins/llm-chat/ChatRoomPane.tsx` — `ChatRoomPane → MessageList →
ChatMessageBubble` + `ConnectionIndicator`/`AiStatusLine`/`TypingLine`/`PresenceLine`/
  `ErrorBanner`. `ChatMessageBubble` reads its own message node's leaves and calls
  `bumpRenderCount('ChatMessageBubble')`; `MessageList` subscribes to `messages.length`
  only. Avatar background uses `avatarHue(author)` (HSL) for humans and `bg-primary` for the
  assistant; a bordered `ai` chip follows the name; the streaming caret is `bg-primary`.
- **`avatarColor.ts`** (`avatarHue`) — used ONLY by `ChatRoomPane.tsx` and
  `avatarColor.spec.ts` (verified by grep).
- **`Button`** (`components/ui/button.tsx`) — CVA; variants `default`/`outline`/`ghost`/
  `destructive`; sizes `default` (h-7) / `sm` (h-6) / `icon` (h-7 w-7). `lucide-react` is
  available (already used in `command.tsx`/`dialog.tsx`).
- **`Card`** (`components/ui/card.tsx`) — `rounded-md border border-border bg-surface`
  (same color as the pane → no lift). Used by Settings, RoomPicker, AssetBoard form,
  AssetCard.
- **Asset card** (`plugins/assets/AssetCard.tsx`) — `Generate` = `default` (filled),
  `Delete` = `outline`.
- **Dockview theme** (`styles.css` `.dockview-theme-bloom`) — themes `--dv-*` tab/group
  color vars + the active-tab cap. Group containers: `.dv-groupview`, `.dv-view`,
  `.dv-view-container`, `.dv-active-group`/`.dv-inactive-group`, separated by `.dv-sash`.
  Group view background = `var(--surface)`; gutter background = `var(--bg)`.

## Design

### 1. Chat feed — `ChatMessageBubble` (and `MessageList` density)

**Critical invariant — render isolation.** Keep the component split and every
`bumpRenderCount` name. Avatar/role styling derives from `role`/`author` (leaves the bubble
already reads) — **no new pane/list-level subscription**. The existing test "appending a
token re-renders only that bubble" must stay green. `MessageList` keeps its `messages.length`
-only subscription.

Per element:

- **Remove the rainbow.** Delete the `avatarHue` import and the inline `style` background.
  Replace the 26px round disk with an **18px monochrome rounded-square chip**
  (`h-[18px] w-[18px] rounded-[5px] border border-border bg-raised text-muted-foreground`),
  a **lowercase** initial in `font-mono text-[9px]`. The **assistant** variant is the only
  accented one: `text-accent-text border-primary/30` (still no fill).
- **Author name recedes.** `text-[10.5px] font-semibold`, humans `text-muted-foreground`,
  assistant `text-accent-text/90` (warm-dim). **Drop the bordered `ai` chip** — the chip
  color + name tint already signal the assistant.
- **Content leads.** `text-[13px] leading-snug text-foreground` (brighter than metadata).
- **Assistant marker (replaces the disk).** The assistant message row gets a faint tint +
  thin accent rule: `bg-primary/[0.04] border-l-2 border-primary/50 rounded-r pl-2`. Human
  rows have no tint.
- **Tighten rhythm.** `MessageList` gap `gap-3` → `gap-1.5`; bubble row stays
  `flex gap-2`.
- **Caret** stays `bg-primary` (a streaming indicator is a legitimate accent).
- **Preserve** `data-testid="chat-msg-${id}"`, `data-role`, `data-status`,
  `data-testid="chat-caret"`, and the author-name text (e2e asserts the author label is
  visible).
- **Delete** `avatarColor.ts` + `avatarColor.spec.ts` once `ChatRoomPane` no longer imports
  `avatarHue` (grep-confirm no other consumer).

### 2. Accent rationing — `Button` variant + usages

- **New `Button` variant `accentOutline`:** `border border-primary/45 bg-transparent
text-accent-text hover:bg-primary/10`. (CVA map addition; `IButtonProps` unchanged.)
- **Usages:**
  - `AssetCard` — `Generate` → `variant="accentOutline"` (it repeats per card, so it must
    not be a bright fill); `Delete` → `variant="ghost"`.
  - `ChatRoomPane` — `Send` → an **icon button**: `size="icon"` `variant="default"`
    (the single filled accent on that surface), rendering a `lucide-react` arrow
    (`ArrowUp`), with `aria-label="Send"`. **Keep `data-testid="chat-send"`** and the click
    handler. (Still `h-7 w-7 bg-primary` → `styling.spec` stays green.)
  - `AssetBoardPane` `Add asset` and `RoomPicker` `Create` stay `default` (filled) — each is
    the singular primary of its surface.

### 3. Defined panel slabs — Dockview group framing (`styles.css`)

Theming only — no Dockview behavior change. Make each group read as a separated slab on the
gutter:

- On the group container (`.dockview-theme-bloom .dv-groupview`, the box whose background is
  `--surface`): add `border: 1px solid var(--border-strong)`, `border-radius: 6px`, and a
  subtle `box-shadow: 0 1px 2px rgb(0 0 0 / 0.4)`, so it floats on the `--bg` gutter.
- **Gutter gap:** create visible separation between groups. Preferred: a small inset so the
  `--bg` shows around each group (e.g. group container `inset`/margin, or widen the
  `.dv-sash` hit area while keeping it transparent on `--bg`). **If margins/insets disturb
  Dockview's absolute grid layout**, fall back to the border + radius + inset shadow alone
  (still a clear slab edge) and a slightly stronger sash color. The implementer discovers the
  exact reachable seam from the installed `dockview.css` (as in the connected-tab task) and
  **verifies resize sashes, tab drag, and panel drop still work**.
- **Lift cards off the pane:** `Card` → `bg-raised` (was `bg-surface`), keeping
  `rounded-md border border-border` and no shadow. Cards now sit a step above the pane
  surface (`--surface` → `--raised`). Update the `card.spec.tsx` assertion
  (`bg-surface` → `bg-raised`; still asserts no `shadow`).

### 4. Hierarchy & density polish (cross-cutting)

Sweep the re-skinned surfaces so metadata recedes and content leads: presence/`In room`,
status pill labels, panel sub-ids, and secondary labels use `--muted`/`--faint`; primary
content uses `--foreground`. Tighten vertical rhythm in the chat feed and list rows to match
the compact scale. No new tokens required (use existing `muted-foreground`/`faint`/
`accent-text`).

## E2E & test plan (source of truth)

Per AGENTS.md the Playwright suite is the behavioral contract and is **local-only**; it
**must be run (replay tier) before any PR** (project rule). The change is visual, so the
contract is preservation + small additions:

- `llm-chat.spec.ts` — the "premium author-labeled feed" test must stay green: author label
  still visible, `chat-composer` + `chat-send` present and functional, stream → complete,
  presence. `chat-send` is now an icon button (same testid, `aria-label="Send"`).
- `styling.spec.ts` — `chat-send` stays `bg-primary` + `h-7` (icon size) so the
  Button-utilities test passes; Settings select border test unchanged.
- New assertions (keyed to stable hooks, never colors): the assistant bubble carries a
  stable marker (class/`data-role="assistant"`) distinct from human bubbles; a representative
  Dockview group exposes the slab framing via a stable class hook.
- Run the full suite against a **replay** backend on :8000; restore live afterward.

## Testing strategy

- **Unit (vitest, TDD, CI):** `Button` `accentOutline` variant renders the right token
  classes; `Card` renders `bg-raised` and no shadow; `ChatRoomPane` tests
  (render-isolation count, testids, `data-role`/`data-status`, caret present/absent) stay
  green — update only assertions that referenced the removed `ai` chip or the `avatarHue`
  inline style. `avatarColor.spec.ts` is deleted with its module.
- **E2e (Playwright):** the contract above; exhaustive; local-only; run before PR.
- **Verification before completion:** `prettier --check .` (repo root), nx typecheck,
  vitest, build, backend pytest, then `just e2e` (replay) green — evidence shown before any
  completion claim, then **restore the live backend**.

## Execution approach

- **TDD** at the unit level; subagent-driven-development (fresh implementer per task, review
  after each, whole-branch review at the end).
- **Build order:** (1) `Button` `accentOutline` + `Card` `bg-raised` → (2) chat feed
  redesign + delete `avatarColor` → (3) accent-usage swaps (AssetCard, Send icon) →
  (4) Dockview group slabs + card-lift verification → (5) hierarchy/density sweep →
  (6) e2e (replay) + visual screenshot check.
- **Branch/PR:** `feat/studio-visual-polish`; semantic commits; squash-merge via PR after
  all gates + e2e green.

## Open risks

- **Dockview group-slab CSS is the main risk** — the gap/inset may fight Dockview's absolute
  grid; mitigate with the border+radius+inset-shadow fallback and an early layout/sash/drop
  check (build step 4) before the rest.
- **Render isolation** — the chat refactor must not add a list/pane content subscription;
  the existing unit test is the guard.
- **Send as icon** — keep `data-testid="chat-send"` + `aria-label`; confirm the e2e click +
  `styling.spec` height/bg still pass.
- **Dim-name contrast** — muted author names at 10.5px must still clear contrast on
  `--surface`; eyeball and nudge if needed.
- **Card `bg-raised` everywhere** — verify Settings/RoomPicker cards still read well on their
  panes (they now lift); adjust if a card-on-gutter case looks off.
