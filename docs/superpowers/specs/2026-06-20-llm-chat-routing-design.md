# LLM Chat — routing, room picker & lightweight login design

- **Date:** 2026-06-20
- **Status:** Design approved (brainstorming complete). Ready for implementation planning.
- **Scope:** `studio/frontend` only. Introduces client-side **routing**, a **room-picker
  screen**, and a **lightweight identity "login"** as the app entry point. Backend (Plan A +
  subsystem 1) is unchanged.
- **Update (2026-06-20):** subsystem 2 (the `llm-chat` plugin) **merged to `main` (PR #24)**
  while this was being designed. This work therefore **refactors the existing, merged
  plugin** rather than preceding it. Key reconciliation: the plugin's whole socket/streaming
  core keys off `slice.activeRoomId` (set by the tested `openRoom` action). Rather than
  rewrite that, the **URL is the source of truth at the system level** — `RoomRoute` drives
  `openRoom(roomId)` from the route param, keeping the slice in sync. The `activeRoomId`
  field remains internally as a route-driven mirror; it is no longer set by user clicks in a
  pane. See the implementation plan for the task-level deltas.
- **Parent specs:**
  - [`2026-06-19-llm-chat-design.md`](./2026-06-19-llm-chat-design.md) — Plan A/B parent.
  - [`2026-06-19-llm-chat-frontend-plugin-design.md`](./2026-06-19-llm-chat-frontend-plugin-design.md)
    — subsystem 2. **This document supersedes its room-selection decisions (§6/§7/§9):**
    the Room List _pane_ and the free-floating `activeRoomId` slice field are replaced by
    a routed picker screen and a URL-derived room id. The streaming/reducers/notifications
    core (§8/§10/§11) is untouched.

## 1. Summary

Today the entire `studio/frontend` app _is_ one Dockview workbench rendered directly by
`main.tsx`; there is no router and "screens" are panes. This change makes the program's
**entry point a dedicated identity + room-selection flow**, and ties the Dockview
**workspace to a single chat room addressed by URL** (`/room/:roomId`), so room links are
**shareable and bookmarkable**.

Three plain routed screens (`/login`, `/` picker) sit _outside_ Dockview; the existing
workbench is mounted _only_ inside `/room/:roomId`, bound to that room via the route param.

Routing library: **React Router v7**, declarative/library mode (`react-router-dom` +
`<BrowserRouter>`) — not the framework/SSR/file-based mode. Chosen as the proven, mature
standard consistent with the repo principle "prefer proven libraries over hand-rolling";
TanStack Router's type-safe params were considered and judged not worth the novelty for
three routes and one param. Only SPA primitives are used (`<BrowserRouter>`, `<Routes>`,
`useParams`, `useNavigate`, a small redirect guard), keeping the router behind a thin seam
so it can be swapped later.

## 2. Motivation & the one justification that matters

URL routing earns its complexity here for exactly one reason: **shareable / bookmarkable
room links.** That alone justifies real routes over pure view-state. Browser
back/forward, deep-linking, and multi-tab-different-rooms come along for free but are not
the driver. No other routing capabilities (loaders, SSR, nested data routes) are adopted.

## 3. Top-level structure (two shells)

```
<BrowserRouter>
  /login          → <LoginScreen/>     plain screen; identity gate
  /               → <RoomPicker/>      plain screen; entry point after login
  /room/:roomId   → <Workbench/>       existing Dockview workbench, bound to :roomId
  *               → redirect to /
</BrowserRouter>
```

Two distinct kinds of top-level UI now coexist:

1. **Plain routed screens** (`/login`, `/`) — ordinary full-screen React views (a form, a
   list of room cards). No panes, no docking, no Dockview.
2. **The Dockview workbench** — mounted _only_ at `/room/:roomId`. Navigating into a room
   mounts it; navigating back to the picker unmounts it.

`main.tsx` changes from rendering `<Workbench/>` directly to rendering the router. A
hard refresh on `/room/abc` must work, so the Vite dev server (and any future static host)
**falls back to `index.html`** for unknown paths.

## 4. Login — identity capture, not authentication

This is **not** auth. There are no passwords, no sessions, no server-side user records,
and no `/login` backend endpoint. "Login" means: **capture a username, persist it, and use
it as the user key and the socket `auth: { displayName }`.**

- **Form:** a single username field, no password. Submitting stores the username and routes
  onward (to the preserved return-URL, else the picker).
- **Persistence:** saved to localStorage. **Supersedes the subsystem-2 `guest-NNNN`
  auto-generated default** — first-run identity now goes through this screen instead of an
  auto-assigned guest name. Returning visits with a stored username **skip** `/login`.
- **Identity use:** the username is the message author / presence key and the Socket.IO
  `auth: { displayName }` value (backend contract unchanged).
- **Switch user / log out:** an affordance (in the workbench header / picker) clears the
  stored username and routes back to `/login`.
- **Settings pane:** drops its display-name field — identity is owned by login + the
  switch-user flow, not an in-workspace editor.

> This is a deliberate front-door philosophy change from subsystem 2 (which chose a
> zero-friction `guest-NNNN` auto-default editable in Settings). The explicit identity gate
> wins because identity is now also the routing/sharing actor.

## 5. Room picker — replaces the "Room List pane"

The subsystem-2 **Room List _pane_ is deleted.** Its behavior moves to a `RoomPicker`
_screen_:

- Lists existing rooms (`GET /rooms`) and a "new room" input (`POST /rooms` →
  `/room/:newId`).
- Selecting an existing room navigates to `/room/:id`.
- It is genuinely outside the workbench — while picking, the user is not in a docked
  workspace at all.
- Inline retry on load error (same UX intent as the prior pane).

## 6. Workbench — bound to the route

- **`activeRoomId` is no longer a free-floating slice field.** The active room is
  **derived from `useParams().roomId`** — the URL is the single source of truth for "which
  room." Subsystem-2 state/reducers that referenced `activeRoomId` read it from the route
  instead; the room-guarding invariant (ignore socket events whose `roomId !== current
route room`) is unchanged.
- **Join/leave is route-driven:** mounting the room route (or changing `:roomId`) triggers
  `leave_room(prev)` → state reset → `GET /rooms/:id/messages` → `join_room(id)`, exactly
  the subsystem-2 `openRoom` sequence, now keyed off the route transition rather than a
  pane click.
- **Shared layout:** the Dockview arrangement is shared across all rooms. The existing
  single `layout` persistence key (`layoutService.ts`) is unchanged — one workbench
  arrangement, pointed at different room data. Per-room layouts (`layout:{roomId}`) are
  explicitly deferred (YAGNI); the key is left easy to shard later if real per-room
  arrangements ever matter.

## 7. Guards & failure cases

Shareable links can go stale or be opened by someone with no stored identity, so the
router needs explicit guard behavior:

- **Deep-link before login.** A fresh browser opening `/room/abc` (no stored username) is
  bounced to `/login` with the **intended destination preserved** (return-URL pattern);
  after entering a username the user continues to `/room/abc`, not merely the picker.
- **Unknown / deleted room.** `/room/:id` where the id is absent from `GET /rooms` (or join
  fails) → redirect to the picker **with a toast** ("That room no longer exists"), rather
  than rendering a broken/empty workbench.
- **Bare `/` when logged in.** Always the picker. No last-room auto-resume.

## 8. Lifecycle — app-level vs route-level

Because the workbench is now route-scoped, registration and connection must move up so
they are not torn down/rebuilt on every room navigation:

- **App-level, once identity is known (post-login):** plugin registration (panes,
  commands, slice seed) and the single Socket.IO **connection** (`auth: { displayName }`).
- **Route-level:** workbench mount, and `join_room` / `leave_room` driven by `:roomId`
  transitions only.

This corrects subsystem 2's "connect eagerly in `init()` during workbench boot" assumption,
which held only while the workbench _was_ the whole app. Socket reconnect/auto-rejoin
semantics from subsystem 2 are otherwise unchanged (on reconnect, re-`join_room` the
current route's room).

## 9. Router seam

Routing is kept behind a thin seam so React Router stays swappable:

- A small set of app-level helpers/hooks expose only what the app needs: current room id,
  navigate-to-room, navigate-to-picker, the login/return-URL guard. Components and plugin
  code depend on these, **not** on `react-router-dom` directly where practical.
- This mirrors the repo's "keep proven libraries behind a thin swappable seam" principle
  (as already applied to `notify`/`sonner` and `socket.io-client`).

## 10. Testing

Per repo policy: TDD at the unit level; Playwright e2e is the authoritative behavioral
contract, runs locally, stays out of CI.

- **vitest (unit, CI):**
  - Guard logic — unauthenticated deep-link → `/login` + return-URL → onward; unknown room
    → picker + toast; bare `/` logged-in → picker.
  - Login prefs — persist username, skip-on-return, switch-user clears it; supersedes
    `guest-NNNN`.
  - Route → room derivation — `activeRoomId` comes from `:roomId`; changing the param fires
    leave→reset→fetch→join in order (subsystem-2 `openRoom` sequence, route-driven).
  - The router seam (mocked) and any app-level lifecycle ordering (register/connect once).
- **Playwright (local-only, against the live backend with `llm_backend=fake`):**
  login with a username → land on picker → create room → URL becomes `/room/:id` →
  workbench mounts → send prompt → streamed tokens. **Bookmark/share:** copy the room URL,
  open in a second context (different username), both see the stream and each other in
  presence (carries over the subsystem-2 two-context test, now via a shared URL).
  **Stale link:** open `/room/<deleted>` → redirected to picker + toast. **Deep-link before
  login:** open `/room/:id` in a fresh context → `/login` → onward to the room.

## 11. Dependencies & configuration

- **Add:** `react-router-dom` (v7).
- **Config:** Vite dev-server SPA fallback to `index.html` for client routes (and the same
  for any future static host). No new env vars; backend base URL config unchanged from
  subsystem 2.

## 12. Out of scope (unchanged)

- Real authentication — passwords, sessions, server-side user records. (This "login" is
  identity capture only.)
- Per-room Dockview layouts; multi-room simultaneous view.
- Retiring the demo plugins.
- Any backend change — the contract (REST + Socket.IO, `auth: { displayName }`) is consumed
  exactly as built.
