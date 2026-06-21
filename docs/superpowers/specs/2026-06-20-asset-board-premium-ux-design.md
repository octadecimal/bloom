# Asset Board — Premium UX + End-to-End Validation

**Date:** 2026-06-20
**Status:** Design (approved, pre-plan)
**Scope:** `studio/frontend` (assets plugin + shared UI), `studio/backend` (games endpoint), e2e suite

## Problem

The game-assets subsystem passes its headless replay e2e (`studio/frontend/e2e/assets.spec.ts`)
but fails the human test:

- The Asset Board pane is raw/unstyled (inline styles, no design tokens, no card
  chrome). It is an outlier only in being the pane the user happened to open — chat
  and settings are equally raw — but it is the one we are shipping.
- The **Generate** control is not discoverable. A real screenshot of the running app
  shows an asset card rendering its header only ("Cool Text · schnell-transparent")
  with no visible Generate/Delete buttons, even though `AssetCard.tsx` renders them
  unconditionally (lines 60–65). Whether they are buried by the total absence of
  styling or absent from the DOM is exactly what the first e2e run must reveal.
- A fresh user hits a **dead end**: games exist only as a side effect of creating a
  chat room (`studio/backend/app/store.py:67`); the board's `GET /games` can only
  _list_ games. Open the board first and the dropdown is empty, the asset form is
  hidden, and there is no in-pane way forward.

The existing e2e gives **false confidence**: it locates controls via ARIA role in a
headless replay run, asserting structure but never discoverability or polish. This is
the test/real-parity failure mode the repo explicitly warns against — green in test,
broken for the human.

## Goals

Deliver, test-first:

1. An **exhaustive replay e2e** asserting the _human_ contract: controls visible,
   enabled, and in-viewport; a real image actually rendered; coherent empty / loading
   / generating / done / error states. Authored first so it reproduces today's failure
   (RED) before any fix.
2. A **premium redesign** of the Asset Board + Asset Card on the design system the app
   already owns (CSS-variable tokens + `components/ui`), making it the first
   properly-designed pane and a pattern others can follow.
3. A small **`POST /games`** endpoint plus an inline **New Game** flow so the board is
   fully self-contained (open board → create game → add asset → generate).
4. The same spec wired to run on the **live tier** (real ComfyUI on :8188) so
   replay-green and live-green stay in lockstep.

## Non-goals (YAGNI)

- Redesigning the chat or settings panes (we establish the reusable pattern; we do not
  retrofit them here).
- Changing the ComfyUI protocol, the `AssetHub` generation pipeline, or the workflow
  graph patching.
- Authentication, asset categories/tagging, multi-game parallel generation changes.

## Current architecture (reference)

Unchanged by this work except where noted.

- **Frontend assets plugin:** `studio/frontend/src/plugins/assets/`
  - `AssetBoardPane.tsx` — game select, refresh, new-asset form, asset grid.
  - `AssetCard.tsx` — per-asset card; unconditionally renders Generate + Delete.
  - `actions.ts` — `loadGames`, `openGame`, `createAsset`, `generateAsset` (Socket.IO
    emit), `selectGeneration`, `deleteAsset`.
  - `restClient.ts`, `socketClient.ts`, `state.ts`, `reducers.ts`.
- **Shared UI:** `studio/frontend/src/components/ui/` — `button.tsx` (CVA variants),
  `dialog.tsx`, `menubar.tsx`, `command.tsx`, `sonner.tsx`. `lib/utils.ts` exports `cn()`.
- **Design tokens:** `studio/frontend/src/styles.css` — `--background`, `--foreground`,
  `--primary`, `--muted`, `--accent`, `--border`, `--input`, etc., with `.dark` overrides
  and `@theme inline` exposing `bg-*`/`text-*`/`border-*` utilities. Dark mode toggled by
  `app/useApplyTheme.ts`.
- **Backend:** `studio/backend/app/assets/` (rest, sockets, hub, comfy, graph, store,
  media). `GameStore.create_game(name)` exists in `app/games.py` but is **not** exposed
  over REST. Provider seam: `LiveComfyProvider` (real :8188) vs `ReplayComfyProvider`
  (fixtures under `studio/backend/tests/fixtures/replay/comfy/`), selected by
  `PROVIDER_MODE`.

## Design

### Backend — expose game creation

Add `POST /games` to `studio/backend/app/assets/rest.py`:

- Request body: `{ "name": str }` (non-empty after trim → 422 otherwise).
- Calls `request.app.state.game_store.create_game(name)`.
- Returns `201` with `game_wire(game)` (same shape `GET /games` returns).

No new store logic — `GameStore.create_game` already exists. This is the only backend
change.

### Frontend — data layer

- `restClient.ts`: add `createGame(name: string): Promise<IGame>` calling `POST /games`.
- `actions.ts`: add `createGame(name)` that POSTs, inserts the game into state, and
  auto-selects it (reusing the `openGame` path so assets/socket room are joined).
- Keep all existing actions intact.

### Frontend — shared UI primitives

The board needs card chrome and styled inputs; both are reusable and currently missing.
Add two thin, token-based primitives to `components/ui` (shadcn-style, `cn()` + tokens):

- `card.tsx` — `Card` / `CardHeader` / `CardContent` / `CardFooter` using
  `bg-background border border-border rounded-lg`, subtle shadow, consistent padding.
- `input.tsx` — `Input` using `border-input bg-background` with focus ring (`ring`),
  matching `Button` sizing (`h-9`).

Keep them minimal — only the variants the board uses. No new dependencies.

### Frontend — Asset Board pane redesign

`AssetBoardPane.tsx` becomes token-styled and state-aware. States:

- **No games** → centered empty state: headline ("No games yet"), one-line explainer,
  prominent primary **`+ New Game`** button (`data-testid="new-game"`). No dead end.
- **New Game** → inline name entry (small `Dialog` or inline row with `Input` +
  confirm). On submit: `createGame(name)` → game auto-selected.
- **Game selected, no assets** → game header (name + game switcher `select` + `New Game`
  - Refresh) and a styled **"Add your first asset"** form (`Input` for name/prompt,
    `select` for workflow, primary `Add asset` button). Empty-grid hint below.
- **Assets present** → responsive grid (`flex flex-wrap gap`) of `AssetCard`s.

Preserve the render-count discipline: the board subscribes only to the asset **count**,
so a progress tick re-renders one card, not the board (existing comment at
`AssetBoardPane.tsx:16`).

### Frontend — Asset Card redesign

`AssetCard.tsx` rebuilt on `Card` with explicit, styled states (controls always present
and discoverable):

- **idle** → muted image placeholder, name + workflow, **prominent visible enabled
  `Generate` primary button**, Delete as a quiet `outline`/icon button.
- **queued** → "Queued…" badge; Generate disabled.
- **generating** → progress bar (`asset-progress`) + "Generating…" caption; Generate
  disabled.
- **done** → rendered selected image fills the card; candidate thumbnail strip
  (`asset-candidates`) below with selected outline; Generate re-enabled ("Generate
  again"); Delete available.
- **error** → styled inline error with the backend message (`asset-error`); Generate
  re-enabled to retry.

Keep the scoped-subscription pattern (card subscribes to its own asset node) so a
progress tick re-renders only this card.

Use **Sonner** toasts for create-game / delete / generation-failure feedback.

All existing `data-testid`s are preserved; new ones added (`new-game`,
`new-game-name`, `new-game-submit`, `assets-empty`, `games-empty`).

## E2E test plan (source of truth)

Primary tier **replay** (`just e2e`, deterministic — start `just backend-serve-replay`
first). The same specs run on the **live** tier (`just e2e-live`,
`BLOOM_E2E_TIER=live`) against real ComfyUI on demand. `studio/frontend/e2e/assets.spec.ts`
is expanded; helpers updated for the new self-contained flow.

Scenarios:

1. **Self-contained journey** — open app → open Asset Board → the **No games** empty
   state's `new-game` button is `toBeVisible()` + `toBeEnabled()` + `toBeInViewport()`
   → create a game inline → game becomes selected → asset form appears → add an asset.
2. **Discoverability (the assertion the old suite lacked)** — after adding an asset, the
   card's `Generate` button is `toBeVisible()` **and** `toBeEnabled()` **and**
   `toBeInViewport()`. Not merely present in the DOM. This is the linchpin assertion.
3. **Generate + real image** — click `Generate` → generating/progress state visible →
   `asset-selected-image` appears with `naturalWidth > 64` and `naturalHeight > 64`
   (rejects 1×1 placeholders) → `Generate` re-enabled after completion.
4. **Candidates** — `Generate` again → `asset-candidates` has ≥ 2 thumbnails → click a
   thumbnail → selected image updates to that candidate.
5. **Error state** — drive a generation failure (replay error fixture) → card shows the
   styled `asset-error` state and Generate is re-enabled for retry.
6. **Multi-client realtime** — Alice generates; Bob (same game, second context) sees the
   image appear live. Kept from the current suite and re-asserted against the redesigned
   card.

**RED-first diagnostic:** Scenario 2 is run against the _current_ (un-redesigned) app
first. Its failure mode tells us whether the missing Generate button is "in the DOM but
not visible/in-viewport" (styling) or "absent" (logic), and that observation drives the
fix. We do not edit `AssetCard` until we have watched the assertion fail.

**Error fixture:** add a replay path that yields a generation error so scenario 5 is
deterministic (e.g. a fixture/flag the `ReplayComfyProvider` honors to raise mid-stream).
Kept minimal and offline.

## Testing strategy

- **Backend (pytest, TDD):** `POST /games` — happy path returns 201 + wire shape;
  empty/whitespace name → 422; created game then appears in `GET /games`. Runs in CI.
- **Frontend unit (vitest, TDD):** `createGame` action (POST + insert + auto-select);
  `restClient.createGame`; any reducer change. New `Card`/`Input` primitives covered via
  the pane/card render tests. Runs in CI.
- **E2e (Playwright):** the scenarios above are the behavioral contract. Local only per
  repo CI-cost policy. Replay tier is the dev loop; live tier validated before "done".
- **Parity gate:** `just preflight` (fails if backend in replay) before any human
  session; a live-tier e2e run honors `[[test-real-parity]]` so replay-green ⇒ live-green.

## Execution approach

- **TDD throughout** — failing test before implementation at every layer; e2e authored
  first as the contract.
- **subagent-driven-development** (repo default) — fresh implementer subagent per task,
  a task review after each, a whole-branch review at the end.
- **Verification before completion** — `prettier --check .`, nx typecheck, frontend unit,
  build, backend pytest, then `just e2e` (replay) green and a live-tier run, with output
  shown, before any completion claim or PR.
- **Branch/PR** — `feat/asset-board-premium-ux`; semantic commits; squash-merge via PR
  (main is protected).

## Open risks

- **Root cause of the missing button is unconfirmed** until the RED run. The redesign
  rebuilds the card regardless, but if a runtime error (not styling) suppresses render,
  the RED run surfaces it and we fix the cause, not just the looks.
- **Replay error fixture** is a small new surface in the provider seam; keep it behind
  the existing `ReplayComfyProvider` so live mode is untouched.
- **Live-tier flakiness/perf** (real generation latency) — keep live runs on-demand with
  generous timeouts; never gate CI on them.
