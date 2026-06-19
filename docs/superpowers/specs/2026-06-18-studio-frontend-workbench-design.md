# `studio/frontend` — Workbench App-Shell Design

- **Date:** 2026-06-18
- **Status:** Approved (design); ready for an implementation plan
- **Parent:** `docs/superpowers/specs/2026-06-18-bloom-platform-architecture-design.md` (§5, §12, §13, §16)
- **Component:** `studio/frontend` — the designer UI (authoring plane)

This sub-project stands up the **first slice of the studio's designer UI**: an IDE-style
**workbench shell** built on a plugin architecture, plus the infrastructure every later
authoring stage will plug into. The real authoring stages (Setup, Art, Math, Targets,
Simulate, Sign-off) are **not** built here — they become plugins in their own
spec → plan → build cycles. This slice proves the architecture end-to-end with throwaway
demo plugins.

> **Build-order note.** The umbrella spec (§16) lists the frontend last in the studio.
> We are deliberately building it first: designing the designer's experience lets the UI
> pull the backend/simulator requirements backward. There is no backend yet, so this slice
> runs entirely against mock/in-memory data.

---

## 1. What this is

A **workbench**: a docking, IDE-like surface where each piece of authoring functionality is
a **pane** contributed by a **plugin**. This slice delivers the shell (chrome + docking),
the plugin system, the state layer, persistence, and an exhaustive e2e suite — proven by
two throwaway demo plugins. It contains **no real authoring features**.

---

## 2. Locked decisions

1. **Stack:** React + TypeScript, **dockview-react** (docking surface), **shadcn/ui** +
   **Tailwind** (components/styling), **hookstate** (state). Build tooling is **Nx** (React
   app, Vite executor), honoring umbrella §12. The shadcn-in-Nx setup is handled explicitly
   (see §11), not discovered.

2. **Plugin model — hybrid: static now, dynamic-ready.** Plugins register from a static
   array today, but the `IPlugin` manifest + `IPluginHost` API are the **stable contract**
   so a dynamic loader is an additive future step that touches no plugin code.

3. **No React Context, anywhere.** hookstate is the **only** global-state mechanism. The
   plugin `init(host)` argument is a plain object, **not** `React.createContext`. Theme is
   **not** a `ThemeProvider`/`next-themes` (see §7).

4. **Re-render performance is a core principle.** Components subscribe to the **narrowest
   hookstate leaf** they read; this is enforced structurally by per-plugin typed hooks
   (§4) and asserted by e2e render-count tests (§10).

5. **Single root store, namespaced plugin slices.** One module-scope `rootStore`; each
   plugin owns `plugins[id]`, reached only via its typed hooks.

6. **Strict-singleton panes.** One instance per pane type; re-opening focuses the existing
   pane. No `instanceId` concept. A deliberate, revisitable simplification (the authoring
   stages are inherently one-of-a-kind).

7. **Per-plugin opt-in persistence (UI preferences only).** A plugin sets `persist: true`
   to have its slice ride the versioned localStorage mechanism. This is **UI-preference
   persistence**; **authoring-document persistence is a separate, deferred, backend-bound
   mechanism** and must not be conflated with it.

8. **dockview owns the layout tree.** hookstate does not mirror it; the layout service
   serializes it to localStorage.

9. **Exhaustive Playwright e2e is the source of truth for behavior** (per `AGENTS.md`).
   TDD unit tests cover the pure logic beneath; e2e covers observable behavior.

10. **Coding standard:** all interfaces we define use an `I` prefix (`docs/coding-standards.md`).

---

## 3. Architecture

A layered workbench:

```
┌─────────────────────────────────────────────────────────────┐
│  Plugins (static array today; dynamic-ready)                 │
│    each = IPlugin { id, title, panes[], persist?, init?() }  │
│    + its own module-scope typed hooks (makePluginHooks)      │
├─────────────────────────────────────────────────────────────┤
│  Workbench chrome  — menu bar · command palette · View menu  │
│                      · theme toggle   (shadcn + Tailwind)    │
├─────────────────────────────────────────────────────────────┤
│  Host layer                                                  │
│    • IPluginHost     — register panes/commands, openPane()   │
│    • Pane registry   — paneId → React component              │
│    • Command registry— commandId → handler                   │
│    • Layout service  — dockview toJSON/fromJSON ↔ localStorage│
├─────────────────────────────────────────────────────────────┤
│  dockview-react      — docking surface (groups, tabs, drag)  │
├─────────────────────────────────────────────────────────────┤
│  hookstate root store (module scope, NO React Context)       │
│    rootStore = { workspace{…}, plugins:{ [id]: slice } }     │
└─────────────────────────────────────────────────────────────┘
```

**Directory layout** (Nx React app):

```
studio/frontend/
├─ project.json · vite.config.ts · tailwind.config.* · components.json (shadcn)
├─ playwright.config.ts · e2e/
├─ src/
│  ├─ app/                 # workbench shell: chrome + dockview mount
│  ├─ host/                # IPluginHost, pane/command registries, layout service
│  ├─ state/               # rootStore, makePluginHooks, persistence codec
│  ├─ plugins/
│  │  ├─ index.ts          # the static PLUGINS array (the registry)
│  │  ├─ demo-counter/     # persist:true; CounterPane + MirrorPane
│  │  └─ demo-scratch/     # ephemeral; ScratchPane
│  └─ components/ui/       # shadcn components
```

**Boot sequence:** for each `IPlugin` in the static `PLUGINS` array → seed
`rootStore.plugins[id] = initialState` → `registerPane`/`registerCommand` for each →
call `init(host)` → hydrate persisted state (`workspace.theme` + opted-in plugin slices) →
layout service restores the saved layout or applies `DEFAULT_LAYOUT` → dockview instantiates panel components, which subscribe
to their slice via the plugin's typed hooks. A future dynamic loader runs the **same** steps
for one plugin at runtime; `dispose()` reverses them.

---

## 4. The plugin contract

```ts
interface IPlugin<TState = unknown> {
  id: string;                         // e.g. "demo-counter"
  title: string;
  initialState?: TState;              // seeds rootStore.plugins[id] before init()
  persist?: boolean;                  // default false; opt into UI-preference persistence
  panes: IPaneDef[];                  // pane types this plugin contributes
  commands?: ICommandDef[];           // optional palette/menu entries
  init?(host: IPluginHost): void;     // optional extra wiring at registration
  dispose?(host: IPluginHost): void;  // unregister/detach — for dynamic unload
}

interface IPaneDef {
  id: string;                         // namespaced: `${pluginId}/${key}`
  title: string;
  component: React.ComponentType<DockviewPanelProps>;  // external dockview type
}

interface ICommandDef {
  id: string;                         // namespaced
  title: string;
  run(host: IPluginHost): void;
}

interface IPluginHost {
  registerPane(def: IPaneDef): void;
  registerCommand(def: ICommandDef): void;
  openPane(paneId: string): void;     // singleton: focus if open, else create
  runCommand(commandId: string): void;
  listPanes(): IPaneDef[];            // backs the View menu
  listCommands(): ICommandDef[];      // backs the command palette
  resetLayout(): void;
}
```

The public contract for panel components is each plugin's **typed hooks**, created by a
module-scope factory keyed by `pluginId` and bound to a scoped handle into the single root
store:

```ts
// state/makePluginHooks.ts
export function makePluginHooks<TState>(pluginId: string) {
  return {
    usePluginState: () => useHookstate(rootStore.plugins[pluginId]) as State<TState>,
    useHost: () => host,              // module-scope singleton, NOT Context
  };
}
```

A panel is then trivial and scope-correct by construction:

```ts
const { usePluginState } = makePluginHooks<ICounterState>('demo-counter');

export function CounterPane() {
  const s = usePluginState();
  return <Button onClick={() => s.count.set(c => c + 1)}>count: {s.count.get()}</Button>;
}
```

Notes: `initialState` lives on the manifest (declarative; the host needs it to seed the slice
before `init`). Commands are flat/always-enabled this slice (a `when`/`enablement` predicate is
deferred and additive). Raw direct access to the root store is a discouraged escape hatch; the
typed per-plugin hooks are the contract.

---

## 5. State model

```ts
interface IWorkspaceState {
  theme: 'light' | 'dark';
  activePaneId: string | null;        // lightweight focus hint; dockview OWNS layout
}

interface IRootState {
  workspace: IWorkspaceState;
  plugins: Record<string, unknown>;   // plugins[id] = that plugin's slice; typed at the hook
}

// created once, at module scope — not in React, never in a Context
export const rootStore = hookstate<IRootState>({
  workspace: { theme: 'dark', activePaneId: null },
  plugins: {},
});
```

**Ownership boundaries (no double sources of truth):**
- **dockview** owns the layout tree → serialized by the layout service, not mirrored here.
- **`workspace`** owns cross-cutting shell state only (theme, active-pane hint).
- **`plugins[id]`** owns each plugin's data; seeded from `IPlugin.initialState`; reached only
  through that plugin's typed `usePluginState()`.

**Re-render-performance rule (law):** Components MUST subscribe to the narrowest leaf they
actually read. Never call `useHookstate` on a broad parent node inside a pane.
`usePluginState()` returns the plugin's slice; drill to the leaf (`s.count`) so hookstate's
access-tracking re-renders that component only when that leaf changes.

**Persistence (this slice):**
- `workspace.theme` → localStorage.
- dockview layout → localStorage via the layout service, as `{ version, layout }`, with
  fallback-to-default on parse error / version mismatch.
- Plugin slices: only those with `persist: true` are persisted (same `{ version, blob }` +
  fallback codec). This is **UI-preference** persistence. `demo-counter` opts in (count
  survives reload); `demo-scratch` is ephemeral. Authoring-document persistence is **out of
  scope** here and is a separate backend-bound mechanism.

---

## 6. dockview integration

The pane registry **is** dockview's component map (one source):

```ts
<DockviewReact
  components={paneRegistry.asComponentMap()}     // paneId → React component
  onReady={(event) => layoutService.attach(event.api)}
/>
```

**`openPane(paneId)` — strict-singleton:**
```ts
openPane(paneId) {
  const existing = api.getPanel(paneId);
  if (existing) { existing.api.setActive(); return; }       // focus, never duplicate
  api.addPanel({ id: paneId, component: paneId, params: { paneId } });  // identity only
}
```
`params` carries **identity only** (`paneId`), never live state — panels pull state through
typed hooks, so dockview params and the store never compete.

**Layout lifecycle (dockview owns the tree):**
- **Boot:** read localStorage → valid `{ version, layout }` for the current version →
  `api.fromJSON(layout)`; else apply `DEFAULT_LAYOUT`.
- **On change:** `api.onDidLayoutChange` → debounce → persist `{ version, layout: api.toJSON() }`.
- **`resetLayout()`:** clear the key, re-apply `DEFAULT_LAYOUT`.
- **Validation:** restored panel ids are validated against the live pane registry; unknown
  panels are dropped; if the result is empty → `DEFAULT_LAYOUT`. Any parse error / version
  mismatch → `DEFAULT_LAYOUT`. Never crash.

`DEFAULT_LAYOUT` for this slice: the demo panes arranged in a sensible default grouping.

---

## 7. Workbench chrome

All shadcn + Tailwind, all reading/writing hookstate (no Context):

- **Menu bar** (`Menubar`): `File` (Reset layout), `View` (pane list), `Help` (about). Thin.
- **Command palette** (`Command` dialog, bound to ⌘/Ctrl-K): fuzzy filter over
  `host.listCommands()`; selection runs `host.runCommand(id)`. The **primary** surface.
- **View menu:** generated from `host.listPanes()`; each entry calls `host.openPane(paneId)`
  (singleton focus). Plus "Reset layout."
- **Theme toggle:** flips `rootStore.workspace.theme`; a single module-scope effect subscribes
  to that leaf and toggles the `.dark` class on `<html>`. **No `ThemeProvider`, no
  `next-themes`.**

```ts
function useApplyTheme() {
  const theme = useHookstate(rootStore.workspace.theme);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme.get() === 'dark');
  }, [theme.get()]);
}
```

The chrome frames dockview (it is outside the docking surface) — chrome is never a dockable pane.

---

## 8. Demo plugins (throwaway proof)

Two plugins that, between them, exercise every architectural claim:

- **`demo-counter`** — `persist: true`, state `{ count: number }`. Contributes two singleton
  panes: `CounterPane` (`+`/`−`, shows `count`) and `MirrorPane` (read-only, "count is N").
  Both subscribe to `count` via the plugin's `usePluginState()`. Proves shared scoped state
  across panes, scoped re-render, and persistence across reload.
- **`demo-scratch`** — `persist: false`, state `{ text: string }`. One `ScratchPane` (text
  input). Proves per-plugin persistence opt-out (text gone after reload) and an independent slice.

Cross-*plugin* state sharing is **not** built into the demo (not needed to prove the shell);
it is a deferred, make-it-explicit-when-real concern.

---

## 9. Error handling

Isolation so nothing kills the shell:
- **Plugin `init` throws** → log, skip that plugin (its panes/commands don't register); the
  workbench still boots. One bad plugin can't take down the workbench (also the dynamic-unload
  safety net).
- **Restored layout references an unknown pane** → drop it (validated against the registry);
  empty result → `DEFAULT_LAYOUT`.
- **Corrupt/incompatible persisted blob** (layout or plugin slice) → version mismatch / parse
  error → discard that key, fall back to default / `initialState`. Never crash.
- **Unknown command id** → no-op + warn.

---

## 10. Testing

Two layers; **e2e authoritative** (per `AGENTS.md`).

**Unit (TDD, Vitest):** pane registry, command registry, layout codec (version + fallback +
unknown-panel-drop), persistence codec (opt-in + version + fallback), `makePluginHooks`
scoping.

**e2e (Playwright — exhaustive, source of truth).** This slice **wires Playwright** (config,
dev-server fixture, `data-testid` conventions, a render-counter test hook exposed only in test
builds). Native dockview drag/drop is driven via stable `data-testid`s + dockview's API, not
raw mouse simulation. Coverage matrix:

| # | Behavior asserted |
|---|---|
| 1 | Boot renders chrome + default layout |
| 2 | Theme toggle flips dark/light; persists across reload; `.dark` applied |
| 3 | ⌘/Ctrl-K opens palette; filter; run command → pane opens |
| 4 | View menu lists panes; open; re-open focuses, no duplicate (singleton) |
| 5 | Counter increments; MirrorPane reflects; reload → count persists |
| 6 | Scratch text entered; reload → text gone (ephemeral) |
| 7 | Dock interactions: drag/split/move; close pane; reopen via View menu |
| 8 | Rearrange → reload → layout restored; Reset layout → default |
| 9 | Corrupt localStorage layout → falls back to default, no crash |
| 10 | Increment counter → only CounterPane + MirrorPane re-render; ScratchPane + menubar do not (render-counter assertion) |

---

## 11. Build slice (this round's deliverable)

1. **Nx workspace** with `studio/frontend` as an Nx React app (Vite executor); Tailwind +
   **shadcn/ui** wired (the Nx-shadcn setup handled explicitly: `components.json`, path aliases,
   the `cn` util).
2. **State layer:** `rootStore`, `makePluginHooks`, the persistence codec (`{ version, blob }`
   + fallback), `useApplyTheme`.
3. **Host layer:** `IPluginHost`, pane + command registries, the layout service (restore /
   persist / reset / validate).
4. **dockview** mounted; `openPane` singleton semantics; `DEFAULT_LAYOUT`.
5. **Chrome:** menu bar, command palette (⌘/Ctrl-K), View menu, theme toggle — all shadcn.
6. **Plugin registry** + the two demo plugins.
7. **Playwright** wired and the full coverage matrix (§10) implemented; unit tests for the
   pure logic.

---

## 12. Out of scope (built elsewhere / later)

- **The real authoring stages** (Setup, Art, Math, Targets, Simulate, Sign-off) — each its own
  plugin, spec, plan, build.
- **A dynamic plugin loader** — the contract is dynamic-ready; the loader is additive later.
- **Authoring-document persistence** — backend-bound; distinct from UI-preference persistence.
- **Cross-plugin state sharing** — make explicit when a real stage needs it.
- **Multi-instance panes** — strict singletons now; revisit if a pane ever needs duplication.
- **Command enablement (`when`) predicates** — flat/always-enabled now.
- **The studio backend and simulator** — their own sub-projects; this slice mocks all data.
- **Nx as cross-language orchestrator** — Nx owns the TS layer only (umbrella §13).

---

## 13. Open / deferred decisions

- Whether `runtime/client` later joins the **same** Nx workspace (likely yes; revisit when it
  is built).
- The persisted-blob **schema-migration** strategy beyond "version mismatch → fall back to
  default" (sufficient while there is no authoring data to preserve).
- Whether the render-counter test hook graduates into a reusable perf-assertion utility for
  later stage plugins.
- Exact `DEFAULT_LAYOUT` arrangement of the demo panes (cosmetic; settle during implementation).
