# Studio Panes — Premium UX (Shared Design System)

**Date:** 2026-06-21
**Status:** Design (approved, pre-plan)
**Scope:** `studio/frontend` only — shared `components/ui`, design tokens, the
llm-chat panes (`ChatRoomPane`, `SettingsPane`), the `RoomPicker` route, the
`Workbench` header, and a small toast-feedback pass. No backend changes.

## Problem

PR #31 brought the **Asset Board** to a premium, token-based, `components/ui`-driven
finish (`AssetBoardPane.tsx`, `AssetCard.tsx`). The rest of the studio did not follow:
the most-used panes are still raw and inline-styled, so the product feels half-shipped —
one polished pane surrounded by prototypes.

Concretely, today:

- **`ChatRoomPane.tsx`** — the centerpiece of the app — is entirely inline-styled.
  Messages are plain `<li><strong>author:</strong> content</li>` rows; the composer is a
  bare `<input>`; the error banner hardcodes `#b00020` (a raw hex, violating the
  repo's tokens-only rule); connection / AI-status / presence are unstyled text.
- **`SettingsPane.tsx`** — a bare `<select>` in an inline-flex `<div>`, no card chrome,
  no loading/empty states.
- **`RoomPicker.tsx`** (`app/routes/`) — inline-styled list + form, unstyled native
  controls, ad-hoc loading/error/empty states.
- **`Workbench.tsx`** header — inline-styled app chrome with no separating border or
  consistent rhythm, so the shell doesn't frame the panes as one product.

There is also drift in the design system itself: the Asset Board reached for
`text-red-500` (a Tailwind color, not a token) for its error text, and inlined a
`selectClass` string for native selects. There is no `destructive` token, no quiet
(`ghost`) or compact (`sm`) button affordance, and no shared `Select` primitive — so
each new pane re-improvises these.

## Goals

Bring the Asset Board's premium treatment to the remaining panes **on a shared design
system**, so the whole studio reads as one shipped product:

1. **Harden the design system** with the few primitives every pane needs but lacks: a
   `destructive` token, `ghost`/`destructive` button variants, an `sm` button size, and
   a `Select` primitive — establishing one source of truth for pane styling.
2. **Redesign the chat pane** (`ChatRoomPane` + message bubbles) as the centerpiece,
   using an **author-labeled feed** that scales to Bloom's multi-party rooms.
3. **Redesign Settings, RoomPicker, and the Workbench header** on the same tokens and
   primitives.
4. **Make action feedback consistent** via the existing `notify`/Sonner seam (delete,
   room-create, generation-failure), closing the Asset Board's deferred delete-toast.
5. Preserve every load-bearing test hook and the render-isolation architecture, with
   TDD at the unit level and an exhaustive replay e2e as the behavioral contract.

## Non-goals (YAGNI)

- No backend changes. (The Asset Board spec added `POST /games`; nothing here needs a
  new endpoint.)
- No new chat/asset features — no message editing, threading, reactions, avatars from
  uploaded images, asset categories, etc. Avatars are deterministic color+initial only.
- No change to the Socket.IO/REST protocols, Hookstate slice shapes, reducers, or the
  render-count subscription strategy.
- No theme/visual-identity redesign beyond adding the `destructive` token; the existing
  palette and dark-mode story stand.
- No router/navigation restructure; `RoomPicker` keeps its route and flow.

## Current architecture (reference)

Unchanged except where noted.

- **Design system:** `studio/frontend/src/components/ui/` — `button.tsx` (CVA;
  variants `default`/`outline`, sizes `default`/`icon`), `input.tsx`, `card.tsx`,
  `dialog.tsx`, `menubar.tsx`, `command.tsx`, `sonner.tsx`. `lib/utils.ts` exports
  `cn()`. `lib/notify.ts` wraps Sonner (`notify.error/info`); `<Toaster>` mounted in
  `main.tsx`.
- **Design tokens:** `studio/frontend/src/styles.css` — `--background`, `--foreground`,
  `--primary(-foreground)`, `--border`, `--popover(-foreground)`, `--muted(-foreground)`,
  `--accent(-foreground)`, `--ring`, `--input`, each with `.dark` overrides and a
  matching `--color-*` in `@theme inline`. **No `--destructive`.**
- **Chat plugin:** `studio/frontend/src/plugins/llm-chat/` — `ChatRoomPane.tsx`
  (shell + `MessageList` + `ChatMessageBubble` + `ConnectionIndicator` / `AiStatusLine`
  / `TypingLine` / `PresenceLine` / `ErrorBanner`), `SettingsPane.tsx`, `state.ts`,
  `actions.ts`, `reducers.ts`, `restClient.ts`, `socketClient.ts`. `bumpRenderCount`
  drives the render-isolation tests.
- **Room picker:** `studio/frontend/src/app/routes/RoomPicker.tsx` — uses
  `restClient.getRooms/createRoom` and `notify.error`.
- **App shell:** `studio/frontend/src/app/Workbench.tsx` — header (leading slot, title,
  `AppMenubar`, `ModeBadge`, `SwitchUser`, `ThemeToggle`) over a `DockviewReact` host.
- **Asset Board exemplar:** `studio/frontend/src/plugins/assets/AssetBoardPane.tsx`,
  `AssetCard.tsx` — the premium pane/card pattern (token classes, `h-full overflow-auto`
  scroll pane, empty/loading/error states, prominent primary actions, `Card`/`Input`).

## Design

### 1. Shared design-system additions

All in `components/ui/` + `styles.css`. Tokens-only; no new dependencies. These land
first; everything else consumes them.

**`styles.css` — destructive token.** Add to `:root` and `.dark`:

- `--destructive` (light: a clear red, e.g. `oklch(0.58 0.22 27)`; dark: a touch
  lighter for contrast on the dark surface).
- `--destructive-foreground` (near-white, like `--primary-foreground`).
- Expose both in `@theme inline` as `--color-destructive` /
  `--color-destructive-foreground`, enabling `bg-destructive`, `text-destructive`,
  `text-destructive-foreground`, and `/NN` opacity variants.

**`button.tsx` — variants + size.** Extend the CVA map:

- variant `ghost`: `bg-transparent hover:bg-accent` (quiet actions, e.g. room rows).
- variant `destructive`: `bg-destructive text-destructive-foreground hover:opacity-90`.
- size `sm`: `h-8 px-3 text-xs` (dense controls / icon-adjacent buttons).
- Keep `default`/`outline` and `default`/`icon`. `IButtonProps` stays `I`-prefixed.

**`select.tsx` — new primitive.** A thin token-styled native `<select>` mirroring
`Input`: `h-9 rounded-md border border-input bg-background px-3 text-sm` + focus ring,
forwarding props/`className` via `cn()`. This replaces the inline `selectClass` string.

**Asset Board migration (consistency).** Migrate the two native selects in
`AssetBoardPane.tsx` (`game-select`, `asset-workflow`) and its error text
(`text-red-500` → `text-destructive` in `AssetCard.tsx`) onto the new primitive/token.
Low-risk, removes duplication, and proves the primitives against the exemplar. Testids
unchanged.

### 2. Chat redesign — `ChatRoomPane.tsx` (centerpiece)

Author-labeled feed (Slack/Discord/ChatGPT style): all messages left-aligned with a
colored avatar + author name + role chip, content below. Chosen over two-sided
messenger because rooms are multi-party (multiple humans + the AI; presence + members
list), where a binary left/right split breaks down.

**Critical invariant — render isolation.** Keep the exact component split
(`ChatRoomPane` → `MessageList` → `ChatMessageBubble`, plus the status sub-components)
and the `bumpRenderCount` calls with their current names. `MessageList` subscribes to
`messages.length` only; `ChatMessageBubble` subscribes to its own node's leaves. The
existing unit test asserting "a token append re-renders only the bubble, not the shell"
MUST stay green — no new pane-level subscription to message content (avatar color is
derived inside the bubble from `author`, a leaf the bubble already reads).

Component-by-component:

- **Pane shell (`chat-room-pane`):** `flex h-full flex-col` with token bg + padding and
  internal `gap`. A header region holds `ConnectionIndicator` + `AiStatusLine` as small
  pill badges (status dot + muted text), with `PresenceLine` as a subtle line beneath.
- **Empty state (`chat-empty`):** centered headline + one-line explainer, mirroring the
  Asset Board's empty state. Testid preserved.
- **`MessageList` (`chat-messages`):** `flex-1 overflow-auto` scroll region,
  `flex flex-col gap-3`. Still keyed by index, still length-only subscription.
- **`ChatMessageBubble` (`chat-msg-${id}`):** row = avatar + (`author` name + role chip
  + content). Avatar background is a deterministic color derived from `author` (small
  hash → fixed token-ish palette); the assistant uses the primary color and shows an
  "ai" role chip. A **streaming caret** renders while `data-status="streaming"` and is
  dropped on `complete`. **Preserves** `data-testid`, `data-role`, `data-status`, and
  per-leaf reads. (No Hookstate reserved-key collision: fields are
  `id/author/role/content/status`; `s.lastError` is read normally, not as `error`.)
- **Composer:** bare `<input>` → `Input` primitive (`flex-1`), keeping
  `data-testid="chat-composer"`, placeholder `Message…`, the typing-on-change behavior,
  and Enter-to-send. `chat-send` stays a `Button`.
- **`ErrorBanner` (`chat-error`, `role="alert"`):** replace `#b00020` with
  `text-destructive` on a subtle `bg-destructive/10 border border-destructive/30
  rounded-md` block. Inline only — no toast (it is already visible).
- **`TypingLine` (`chat-typing`):** styled italic muted text.

### 3. Settings, RoomPicker, Workbench header

**`SettingsPane.tsx` (`chat-settings-pane`, `settings-model`).** Wrap the content in a
`Card` with a labeled section ("Model (active room)"); replace the raw `<select>` with
the `Select` primitive; add subtle loading ("Loading models…") and empty states.
Testids preserved; the existing `getByText(label)` option assertions still hold.

**`RoomPicker.tsx` (`room-picker`).** Centered card layout. Create form uses `Input` +
`Button`. Loading / error(+Retry) / empty states styled on tokens (error uses the
destructive token). Room list rendered as full-width `ghost`/`outline` buttons.
**E2e contract preserved exactly:** placeholder still matches `/new room/i`, the create
button still matches `role=button name=/create/i`, room items remain clickable by their
exact name text, `room-picker` testid stays. (See §5.)

**`Workbench.tsx` (`workbench`).** Convert the header's inline styles to token utility
classes; add `border-b border-border`, a consistent height, and padding so the chrome
frames the panes. Title → `text-base font-semibold`. All header widgets (leading slot,
`AppMenubar`, `ModeBadge`, `SwitchUser`, `ThemeToggle`) and the `DockviewReact` host are
unchanged in behavior.

### 4. Toast feedback (consistent across panes)

Through the existing `notify` seam — never importing `sonner` directly:

- **Asset delete** → `notify.info` confirmation (closes the Asset Board's deferred
  follow-up). In `plugins/assets/actions.ts` (the `deleteAsset` path).
- **Room create success** → `notify.info` (a global toast; survives the navigation
  because `<Toaster>` is app-level). In `RoomPicker.onCreate`.
- **Generation failed** → `notify.error` in the assets generation-failure path, in
  addition to the existing inline `asset-error` card state.
- **No chat toast** — the inline `ErrorBanner` already surfaces chat errors.

## E2E test plan (source of truth)

Primary tier **replay** (`just e2e`; start `just backend-serve-replay` first). Same
specs runnable on the **live** tier (`just e2e-live`) on demand. Browser e2e is
local-only per the repo CI-cost policy.

Regression (must stay green, unchanged behavior):

1. `llm-chat.spec.ts` — create room → send → assistant streams to `complete`;
   two-client presence + shared stream. Relies on `/new room/i`, `/create/i`,
   `chat-room-pane`, `chat-composer`, `chat-send`, `chat-messages`,
   `[data-role="assistant"]` + `data-status`, `chat-presence` — all preserved.
2. `routing.spec.ts`, `layout*.spec.ts`, `dockview.spec.ts` — shell/navigation intact.

New / expanded assertions for the premium treatment:

3. **Chat polish** — after sending, the latest bubble (`chat-msg-*`) is visible and
   shows its author label; the composer resolves to the styled `Input`; `chat-messages`
   is a scrollable region (`overflow-auto`). While the assistant streams
   (`data-status="streaming"`) a caret element is present and is gone at `complete`.
4. **Chat error state** — drive an error → `chat-error` (`role="alert"`) is visible and
   uses the destructive token treatment (asserted via a stable class/testid hook, not a
   color value).
5. **Settings** — open Settings → `settings-model` is the styled select inside card
   chrome; options render by label.
6. **Room picker** — loading → ready → empty/list states render styled; create flow
   still navigates; a create-success toast appears.

## Testing strategy

- **Unit (vitest, TDD, CI):** new `button` variants/sizes and the `Select` primitive
  render the correct token classes; updated `ChatRoomPane` tests (render isolation
  intact, testids, `data-role`/`data-status`, streaming caret present/absent);
  `SettingsPane` via `Select` + loading/empty; `RoomPicker` state rendering; `notify`
  spy assertions for the three toasts. `Card`/`Input` already covered.
- **E2e (Playwright):** the scenarios above are the behavioral contract; exhaustive per
  AGENTS.md. Local-only.
- **Verification before completion:** `prettier --check .`, nx typecheck, vitest, build,
  backend pytest, then `just e2e` (replay) green — output shown before any completion
  claim. (Per the frontend CI gates: prettier + typecheck + test + build must all pass,
  not just vitest.)

## Execution approach

- **TDD throughout** — failing unit test before implementation at each layer; e2e
  expanded to encode the new contract.
- **subagent-driven-development** (repo default) — fresh implementer subagent per task,
  a task review after each, a whole-branch review at the end.
- **Build order:** (1) DS additions + Asset Board migration → (2) chat → (3) settings →
  (4) room-picker → (5) header → (6) toasts → (7) e2e sweep.
- **Branch/PR:** `feat/studio-pane-premium-ux`; semantic commits; squash-merge via PR
  (main is protected).

## Open risks

- **Render-isolation regression.** The chat redesign is the main risk: a careless
  refactor could make the pane shell subscribe to message content and break the
  re-render guarantee. Mitigation — keep the component split and `bumpRenderCount`
  names; the existing unit test is the guard and must stay green.
- **E2e selector drift.** RoomPicker's e2e selects by placeholder/role/exact-text, not
  testids. Mitigation — the redesign explicitly preserves those selectors; verify with a
  replay run before completion.
- **Token contrast.** New `--destructive` values must read well in both light and dark;
  eyeball both themes during implementation and adjust the oklch lightness if needed.
