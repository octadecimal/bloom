# Asset Board: workspace-game binding + full-size image viewer

**Date:** 2026-06-21
**Status:** Design (approved for planning)
**Scope:** `studio/frontend` (as designed). A follow-up bugfix (PR #36) also added a
small backend change — see "Error handling" — to backfill `game_id` on legacy rooms.

## Problem

The full paned workspace is conceptually tied to a **single game** — we never
operate on multiple games at once. The backend already enforces this: a workspace
is a room (`/room/:roomId` → Workbench) and **every room is bound to exactly one
game**. When a room is created with no `game_id`, the backend auto-creates a game
named after the room and links it (`studio/backend/app/store.py:66-68`); the link
is carried everywhere as `Room.game_id` / `IRoom.gameId`.

Despite this, the Asset Board (`studio/frontend/src/plugins/assets/AssetBoardPane.tsx`)
keeps its **own** `activeGameId` and exposes a game `<Select>`, a `+ New Game`
button, and a `↻ Refresh` button. That is a second, contradictory way to pick _any_
game inside a workspace that is supposed to be pinned to one. It must go.

Separately, generated images can only be viewed at thumbnail/preview size. Clicking
a generated image should let you view it at full size.

## Goals

1. The Asset Board always reflects **the game of the currently-open workspace
   (room)** — no in-board game selection of any kind.
2. Clicking a generated **preview** image opens a **full-size in-app viewer**
   (lightbox), without disturbing the existing "click a candidate thumbnail to
   select that generation" behavior.

## Non-goals (YAGNI)

- Renaming games, multi-game workspaces, or a game-management UI.
- A read-only game-name label in the board (explicitly dropped — keep the board clean).
- Backend changes. The room↔game binding already exists and is sufficient.
- Zooming/panning inside the viewer, galleries, or keyboard navigation between
  images beyond what the dialog provides (Esc / backdrop / close button).

## Feature 1 — Asset Board bound to the workspace game

### Approach: the route owns the game lifecycle (symmetric with rooms)

`RoomRoute` (`studio/frontend/src/app/routes/RoomRoute.tsx`) is already the
workspace lifecycle owner: it fetches the rooms, calls `openRoom(roomId)` on enter
and `closeRoom()` on unmount, and renders the `Workbench` inside an
`ActiveRoomProvider`. It already has the matched room object (with `gameId` and
`name`). We add the mirror for assets:

- **On enter:** call `openGame(room.gameId)` alongside `openRoom(roomId)`.
- **On exit (unmount):** call a new `closeGame()` alongside `closeRoom()`.
- Exiting the workspace continues to navigate back to the picker page (`/`) via the
  existing `← Rooms` link; `closeGame()` firing on unmount lands cleanly there.

This keeps the assets plugin decoupled from the chat plugin's internals. The route
already depends on both plugins' actions, so centralizing the workspace lifecycle
there is the consistent seam.

**Alternative considered & rejected:** have the Asset Board read the chat plugin's
`rooms` / `activeRoomId` state to derive the game. Rejected — it couples the assets
plugin to chat-plugin state.

### New action: `closeGame()`

In `studio/frontend/src/plugins/assets/actions.ts`, mirroring `closeRoom()`:

- Leave the active game's socket room (`sock().leaveGame(activeGameId)`), if any.
- Clear `activeGameId` → `null`, `assets` → `[]`, `assetsStatus` → `idle`.

### Asset Board becomes presentational w.r.t. game

In `AssetBoardPane.tsx`:

- **Remove:** the `Game:` `<Select>` (`game-select`), both `+ New Game` buttons
  (`new-game`, `new-game-submit`), `↻ Refresh` (`refresh-games`), the
  `new-game-row`, the "No games yet" empty state (`games-empty`), and the
  `creating` / `gameName` local state and `submitNewGame` / `newGameRow`.
- **Remove imports** that become unused: `openGame`, `createGame`, `loadGames`,
  `Select`, and the `games` / `gamesStatus` reads.
- **Keep:** the new-asset form (`new-asset-form`) and the asset grid
  (`asset-grid` / `AssetCard`). The board renders these whenever `activeGameId` is
  set (which the route guarantees on entry).
- The "no assets yet" hint (`assets-empty`) stays.

### Init cleanup

`initAssets()` (`actions.ts`) keeps `ensureConnected()` (socket must stay
connected) and **drops the now-unused `loadGames()`** call. The games list and
`gamesStatus` state become dead and are removed if nothing else reads them
(`state.ts`).

## Feature 2 — Full-size image viewer (lightbox)

### Component: `ImageLightbox`

New component in the assets plugin (e.g.
`studio/frontend/src/plugins/assets/ImageLightbox.tsx`) built on the existing
`@/components/ui/dialog` (shadcn Dialog — **no new dependency**).

- Props: `src`, `alt`, `open`, `onOpenChange`.
- Renders the image at full resolution, `object-contain`, in a large modal over a
  dark backdrop.
- Dismiss via Esc, backdrop click, or a close button — all provided by Dialog.
- Accessibility: image `alt` = asset name; the dialog has an accessible title
  (visually hidden is fine).
- Test ids: `image-lightbox` (dialog), `image-lightbox-img` (the full image).

### Wiring in `AssetCard`

In `studio/frontend/src/plugins/assets/AssetCard.tsx`:

- The **selected preview** image (`asset-selected-image`) becomes clickable
  (`cursor-zoom-in`); clicking sets local `open` state that drives `ImageLightbox`
  with the selected generation's full image URL (`${BACKEND_URL}${selected.imageRef}`).
- **Candidate thumbnails are unchanged** — a click still calls
  `selectGeneration(...)`. No collision: only the large preview opens the viewer.

## Data flow

```
enter /room/:roomId
  └─ RoomRoute: getRooms() → match room
       ├─ openRoom(roomId)          (existing)
       ├─ openGame(room.gameId)     (new) → joins game socket room, loads assets
       └─ ActiveRoomProvider(roomId) → Workbench → AssetBoardPane
                                          └─ reads activeGameId / assets, renders grid

click selected preview in AssetCard
  └─ open ImageLightbox(src = full image) → Esc/backdrop/close → onOpenChange(false)

leave workspace (unmount → navigate to "/")
  └─ RoomRoute cleanup: closeRoom() (existing) + closeGame() (new)
```

## Error handling

- Unchanged asset/generation error surfaces (`asset-error`) remain.
- A room must always have a `gameId` for the board to bind. New rooms get one at
  creation, but **legacy rooms created before per-room games existed had none**, and
  `RoomRoute`'s `if (room.gameId)` guard then left the board stuck at the
  `board-no-game` ("Opening game…") fallback forever. Fixed in PR #36 (a follow-up to
  this spec): `ConversationStore.list_rooms` / `get_room` now lazily create + link a
  game for any room missing one, so every room the frontend sees carries a `gameId`.
  This added a backend change the original scope didn't anticipate (it assumed every
  room already had a `gameId`); see the Scope note at the top.

## Testing

TDD for the pure/component logic; Playwright e2e is the authoritative behavioral
contract.

### Unit / component (RED → GREEN → REFACTOR)

- `AssetBoardPane` renders **no** `game-select` and renders the asset grid from the
  active game (context/state-provided), with the new-asset form present.
- `closeGame()` leaves the socket room and clears `activeGameId` / `assets`.
- `ImageLightbox` opens when `open` is true, renders the full image, and calls
  `onOpenChange(false)` on close.
- `AssetCard`: clicking the selected preview opens the lightbox; clicking a
  candidate thumbnail calls `selectGeneration` and does **not** open the lightbox.

### E2e (Playwright — authoritative)

- Entering a room shows that room's game's assets with **no game picker** present
  anywhere on the board.
- Clicking the selected preview opens a full-size viewer (`image-lightbox`
  visible); Esc and backdrop click both close it.
- Clicking a candidate thumbnail still selects that generation (selection outline
  moves) and does **not** open the viewer.
- Leaving the workspace (`← Rooms`) returns to the picker page.

## Files touched

- `studio/frontend/src/app/routes/RoomRoute.tsx` — open/close the game with the room.
- `studio/frontend/src/app/routes/activeRoom.ts` — (only if needed) extend context;
  with the route-owns-lifecycle approach the board reads `activeGameId` from plugin
  state, so context may not need changes.
- `studio/frontend/src/plugins/assets/actions.ts` — add `closeGame()`; trim
  `initAssets()`.
- `studio/frontend/src/plugins/assets/AssetBoardPane.tsx` — remove all game-management UI.
- `studio/frontend/src/plugins/assets/AssetCard.tsx` — clickable preview → lightbox.
- `studio/frontend/src/plugins/assets/ImageLightbox.tsx` — new.
- `studio/frontend/src/plugins/assets/state.ts` — remove dead `games` / `gamesStatus`
  if unused after the change.
- Specs/tests: corresponding `*.spec.tsx` and Playwright specs.
