# LLM Chat — layout presets (Plan B, subsystem 3) design

- **Date:** 2026-06-19
- **Status:** Design approved (brainstorming complete). Ready for implementation planning.
- **Scope:** A **shell-level** `layoutPresets` capability for `studio/frontend` —
  save / apply / list / delete named Dockview arrangements, with one or two built-in
  presets, surfaced through a new "Layout" menu and the command palette. **Frontend
  shell only** — no backend, no `IPlugin` contract changes, independent of the
  `llm-chat` plugin.
- **Parent spec:** [`2026-06-19-llm-chat-design.md`](./2026-06-19-llm-chat-design.md)
  (esp. §13.4 — the Plan-B decision this design refines).
- **Sibling spec:** [`2026-06-19-llm-chat-frontend-plugin-design.md`](./2026-06-19-llm-chat-frontend-plugin-design.md)
  (subsystem 2 — built the `notify` seam this design reuses).

## 1. Summary

Subsystem 3 makes Dockview arrangements **nameable and reusable**. A user can save the
current pane arrangement under a name, re-apply any saved or built-in arrangement, and
delete the ones they made. It is built as **shell chrome**, deliberately kept **out of
the `IPlugin` contract** — presets are a workbench concern, not something plugins
consume — consistent with the existing `layoutService` and the §13.4 `layoutPresets`
decision (and the subsystem-2 `notify` philosophy).

Presets are **global**, acting on the single shared Dockview api. Per-room layouts
remain deferred: the workbench is now routed and persists one shared layout key behind
`setupApp`/`layoutService`; this subsystem does not change that.

## 2. Locked context (from the parent spec §13.4 and the current shell)

- **A new `layoutPresets` service under `host/`**, persisting named arrangements to a
  new versioned key `bloom.studio.layoutPresets` = `{ version, data: { [name]: layoutJSON } }`.
- **Operations:** `saveAs(name)` (captures `api.toJSON()`), `apply(name)`, `list()`,
  `delete(name)`.
- **`apply()` reuses the existing validate-or-default guard** (`panelIdsFromLayout` +
  registry check): an arrangement referencing an unknown pane warns and is refused,
  never crashes.
- **Predefined presets:** one or two built-ins, re-seedable / non-deletable.
- **Chrome UI:** a "Layout" menu — _Save arrangement…_ (shadcn dialog), a dynamic list
  of saved/built-in arrangements (click to apply), _Delete arrangement_, and the
  existing _Reset layout_; plus command-palette entries.

### 2.1 Reconciliation with current code (important)

§13.4 describes the built-in "Chat" arrangement as **"Room List + Chat Room +
Settings"**. That wording predates the routing work (PR #26): the **Room List is no
longer a pane** — it became the `RoomPicker` _route_. The `llm-chat` plugin now exposes
exactly **two** panes:

- `llm-chat/room` — **Chat Room**
- `llm-chat/settings` — **Chat Settings**

(`DEFAULT_LAYOUT` places these two side-by-side.) This design therefore defines built-in
presets in terms of the panes that actually exist (see §4).

## 3. Service — `host/layoutPresets.ts`

A factory mirroring `createLayoutService`, with **no plugin coupling**.

```ts
type PresetKind = 'builtin' | 'user';
interface ILayoutPresetInfo {
  name: string;
  kind: PresetKind;
}

interface ILayoutBuilder {
  (api: DockviewApi, paneRegistry: IPaneRegistryLike): void;
}

interface ILayoutPresetsDeps {
  getApi: () => DockviewApi | null; // same late-bound closure the host uses
  paneRegistry: IPaneRegistryLike; // { get(id): IPaneDef | undefined }
  builtins: Record<string, ILayoutBuilder>; // code-defined, never stored
  notify: { error(msg: string): void }; // the subsystem-2 seam
}

interface ILayoutPresetsService {
  saveAs(name: string): boolean; // false if rejected
  apply(name: string): boolean; // false if refused/unknown
  list(): ILayoutPresetInfo[];
  delete(name: string): void;
}
```

- **Persistence.** User presets live in `bloom.studio.layoutPresets` =
  `{ version: 1, data: { [name]: layoutJSON } }` via the existing
  `savePersisted`/`loadPersisted` envelope helpers (`LAYOUT_PRESETS_KEY = 'layoutPresets'`,
  `LAYOUT_PRESETS_VERSION = 1`). A version mismatch falls back to an empty user map.
  **Built-ins are never persisted** — they are code-defined builders resolved at apply
  time, so they cannot go stale if a pane id changes and are inherently non-deletable.
- **`saveAs(name)`** — trim the name; reject empty/whitespace (`notify.error`, return
  `false`). Reject a name that collides with a **built-in** name (reserved /
  non-overwritable → `notify.error`, return `false`). Otherwise capture `api.toJSON()`
  into the user map (an existing **user** name overwrites), persist, return `true`. No-op
  - `false` if `getApi()` is null.
- **`apply(name)`** —
  - **built-in** → `api.clear()` then run `builtins[name](api, paneRegistry)` (full
    replace);
  - **user** → run the **validate-or-refuse guard**: `panelIdsFromLayout(json)` filtered
    against `paneRegistry.get`; any unknown id ⇒ `console.warn('[layout] …')` +
    `notify.error(…)` + **return `false`** (never `fromJSON`); else `api.fromJSON(json)`.
  - **unknown name** → `notify.error`, return `false`.
  - In every successful case the apply trips Dockview's `onDidLayoutChange`, so the
    existing `layoutService` autosaves the result into the `'layout'` key — the applied
    preset becomes the current persisted layout. No extra wiring.
- **`list()`** → built-ins first (insertion order), then user presets (alphabetical),
  each tagged with `kind`.
- **`delete(name)`** — **user presets only**; deleting a built-in or a non-existent name
  is a silent no-op. Removes the entry and persists.

`panelIdsFromLayout` is already exported from `layoutService.ts`; `layoutPresets.ts`
imports it (single source of truth for the guard). The `IPaneRegistryLike` shape is
likewise shared.

## 4. Built-in presets — `app/layoutPresets.builtins.ts`

Code-defined builders following the `DEFAULT_LAYOUT` idiom, referencing only real pane
ids:

- **"Chat"** → Chat Room + Chat Settings side-by-side (the default pairing — mirrors
  `DEFAULT_LAYOUT`).
- **"Focus"** → Chat Room only (single-pane focused view).

These are illustrative and trivially extended as more panes are added. Defining them as
builders (not stored JSON) is what makes them re-seedable and non-deletable for free.

> Note: "Chat" is intentionally close to Reset layout's result; it exists to exercise
> the built-in-preset path and give the menu a meaningful entry. "Focus" demonstrates a
> genuinely different arrangement.

## 5. Wiring — `setupApp.ts`

Create the presets service after `layoutService`, reusing the same late-bound `api`
closure the host already uses:

```ts
const layoutPresets = createLayoutPresetsService({
  getApi: () => api,
  paneRegistry,
  builtins: LAYOUT_BUILTINS,
  notify,
});
setLayoutPresets(layoutPresets);
```

Expose it via a new **`state/layoutPresetsRef.ts`** (`setLayoutPresets` /
`getLayoutPresets`), mirroring `state/hostRef.ts`. This keeps preset operations **off**
`IPluginHost`, so the `IPlugin` contract is unchanged and plugins cannot consume presets
— matching the shell-chrome intent.

Reset layout already exists as `host.resetLayout()` and is unchanged; the new menu simply
relocates its trigger (see §6).

## 6. Chrome UI — "Layout" menu (`app/Menubar.tsx`)

A new `MenubarMenu` inserted between **File** and **View**:

```
Layout ▾
  Save arrangement…            → opens SaveLayoutDialog
  ──────────────
  Chat            (built-in)   → apply('Chat')
  Focus           (built-in)   → apply('Focus')
  My debug view                → apply('My debug view')
  ──────────────
  Delete arrangement ▸         → submenu of USER presets → delete(name)
  Reset layout                 → host.resetLayout()   (moved from File)
```

- The apply list is `getLayoutPresets().list()`; built-ins are visually tagged and shown
  first. Clicking an entry calls `apply(name)`.
- **Delete arrangement** is a submenu listing only user presets (built-ins absent);
  empty/disabled when there are none. Deletion is immediate (cheap, re-saveable — no
  confirm dialog).
- **File menu** loses its _Reset layout_ item (now under Layout). If File would otherwise
  be empty, it is removed; the View menu (auto-listing panes) is unchanged.

**`app/SaveLayoutDialog.tsx`** — a small component using the existing shadcn
`components/ui/dialog`: a text input + Save/Cancel. On submit it calls
`getLayoutPresets().saveAs(name)` and closes on success; an empty/duplicate-builtin name
is rejected by the service (which fires `notify.error`). Open state is local to the
Menubar (a `useState` toggled by the menu item), following the `CommandPalette` pattern.

## 7. Commands (shell-registered, `setupApp.ts`)

Two **static** shell commands registered via `host.registerCommand` so they appear in the
⌘K palette (`CommandPalette` enumerates `host.listCommands()`):

- **`shell/save-layout`** — _"Save arrangement…"_ → opens the same dialog (via a small
  shell event/ref the Menubar listens to, or by routing through `getLayoutPresets`-adjacent
  open state; implementation detail for the plan).
- **`shell/reset-layout`** — _"Reset layout"_ → `host.resetLayout()`.

Per-preset apply stays **menu-driven**: the command registry is populated once at boot,
and presets are dynamic. A future "Apply layout: `<name>`" dynamic-command seam is noted
but **not built** (YAGNI) — it would require the registry to re-sync on save/delete.

> Open detail for the plan: how _Save arrangement…_ is triggered from a command (which
> runs in the host layer) vs. from the Menubar (which owns the dialog's open state). The
> simplest approach is a tiny shell-level "open save-layout dialog" signal (e.g. a
> hookstate flag or a ref-held callback set by the Menubar). Decide during planning.

## 8. Testing

Per repo policy: TDD at the unit level; e2e (Playwright) is the authoritative behavioral
contract and stays out of CI (cost), run locally.

- **vitest (unit, CI) — `host/layoutPresets.spec.ts`:**
  - `saveAs` — captures `api.toJSON()`, persists under the name, overwrites an existing
    user name, **rejects** empty/whitespace and built-in-name collisions (asserts
    `notify.error`), no-op when `getApi()` is null.
  - `apply` — built-in path calls `api.clear()` then the builder; user path calls
    `api.fromJSON(json)`; **unknown-pane** layout is **refused** (no `fromJSON`, warns +
    `notify.error`); unknown name refused.
  - `list` — built-ins first + tagged, user presets alphabetical.
  - `delete` — removes user preset, persists; built-in/non-existent is a no-op.
  - version mismatch / corrupt store → empty user map (fallback).
  - Mocks: a fake `api` (`toJSON`/`fromJSON`/`clear` spies), a `paneRegistry.get` stub, a
    `notify` spy.
- **vitest — `app/layoutPresets.builtins.spec.ts`:** each builder adds the expected pane
  ids against a fake api (and references only registry-known ids).
- **Playwright (local-only, `studio/frontend`):** open the workbench → rearrange panes →
  _Save arrangement…_ "test" → Reset layout → apply "test" from the Layout menu →
  arrangement restored; apply a **built-in** ("Focus") → only Chat Room present; delete a
  user preset → it disappears from the menu.

## 9. Module structure (new / touched)

```
src/host/layoutPresets.ts            NEW  the service factory
src/host/layoutPresets.spec.ts       NEW  unit tests
src/state/layoutPresetsRef.ts        NEW  set/getLayoutPresets (mirrors hostRef)
src/app/layoutPresets.builtins.ts    NEW  LAYOUT_BUILTINS map (Chat, Focus)
src/app/layoutPresets.builtins.spec.ts NEW
src/app/SaveLayoutDialog.tsx         NEW  shadcn-dialog name prompt
src/app/Menubar.tsx                  EDIT add Layout menu; remove Reset from File
src/app/setupApp.ts                  EDIT create+register service; register shell commands
src/host/layoutService.ts            (no change; panelIdsFromLayout already exported)
```

## 10. Out of scope (this subsystem)

- **Per-room layouts** (deferred; the shared layout key stays single — see §1).
- **Dynamic per-preset palette commands** (noted seam in §7; not built).
- Import/export of presets; reordering; renaming in place (delete + re-save instead).
- Retiring the demo plugins; any backend or `IPlugin` contract change.
