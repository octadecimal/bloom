# Reshape a Symbol by Chat — the Living-Game Slice

- **Date:** 2026-06-24
- **Status:** Draft for review
- **Component:** `studio/backend/` (GDD schema, assets, scene hub/store, agent tools,
  design-router), `runtime/client/` (reconciler already supports the rebind),
  `skills/design-game.md`, `skills/design-scene.md`, `justfile`
- **Worktree / branch:** `C:\code\bloom.wt\symbol-reshape` on `feat/symbol-reshape`
  (`BLOOM_PORT_OFFSET=2` → backend 8002 / frontend 4202 / runtime 4302)
- **Closes / depends on:** issue #69 (SceneHub concurrent-write race) — fixed here as a
  prerequisite.

---

## 1. Essence — the magic moment, end to end

Bloom's north-star magic moment (§3 steps 2–3, §7 Milestone 1) is _"a game appears
from a conversation and then bends to it."_ Live verification (2026-06-24) found the
loop half-built:

- ✅ **The GDD bends to chat.** Plain prose in a game room → the design-router edits the
  GDD; the doc viewer updates live.
- ✅ **Real art generates from words**, and the Pixi client engine **renders a valid
  scene** with real assets.
- ❌ **The rendered _game_ never bends to chat.** Two breaks:
  - **Architecture:** the conversational design-router is bound to **GDD tools only**
    (`GDD_TOOL_NAMES`) — it structurally cannot touch the scene. There is no bridge from
    a GDD change to the rendered game.
  - **Bug (#69):** even the explicit `/design-scene` skill can't reliably build a scene —
    `GameSceneStore.apply_op` is an unserialized read-modify-write, and the agent's
    concurrent `scene_*` calls clobber each other (observed: ~20 ops → `version=1`, a
    dangling edge, no textures → black render). No scene in the DB had ever persisted a
    Texture node.

This slice closes the loop for **one concrete, differentiated interaction**:

> Say _"make the high symbol a dragon"_ → that symbol's GDD entry updates, its art
> regenerates via ComfyUI, and **the rendered game re-paints the new art live** — no
> reload.

It is deliberately the **full loop**: the initial describe→generate flow establishes the
identity wiring, so the reshape works on a naturally-generated game, nothing staged.

## 2. The decisions that shape this slice

Settled during brainstorming:

1. **Target interaction:** symbol/art swap (regenerate one symbol's art and swap it in
   place). Single asset; exercises the whole GDD → asset → scene chain.
2. **Linkage:** a **stable symbol identity** — a `slot` string joining the GDD symbol,
   its Asset, and its scene Sprite/Texture. Surgical and reusable; no per-turn LLM
   guessing about which sprite is "the high symbol".
3. **Orchestration:** the conversational agent does the **design** (edit the GDD symbol),
   then calls **one deterministic tool, `realize_symbol(slot)`**, that does the
   **realization** (regenerate the asset + atomically rewrite the scene Texture's `src`).
   Honors §6 _"AI-designed, never AI-decided"_ and dodges #69 by construction (one atomic
   write, no multi-op dance on the reshape).
4. **Scope:** the **full loop** — thread the identity contract through the _initial_
   authoring (`/design-game`, asset generation, `/design-scene`), so the reshape has real
   targets and future reshapes (theme, layout) build on the same contract.

## 3. The symbol-identity contract (the spine)

A stable `slot` string (e.g. `high1`, `low1`, `wild`) threads through all three planes,
making every layer resolvable by a pure lookup:

| Plane     | Where the slot lives                                                                                                     | Change                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| **GDD**   | `symbols-reels.symbols` table gains a `slot` column beside `name/kind/art_desc`                                          | `gdd/schemas.py`                    |
| **Asset** | `Asset` gains a `slot: Optional[str]`; the store can look up an asset by `(game_id, slot)`                               | `assets/models.py` + `assets` store |
| **Scene** | the symbol **Sprite** carries `props.slot`, bound (data edge) to a **Texture** whose `src` is that slot's selected media | scene-authoring convention          |

Resolution becomes: `slot → GDD symbol row`, `slot → Asset`, `slot → Sprite node → its
Texture node`.

**Why a dedicated `slot`** (not reuse `kind` or `category`): `kind` (high/low/wild) is not
unique (multiple highs); `category` is free-text used elsewhere. `slot` is the single
unambiguous join key, cheap to add, and is the contract every later reshape leans on.

## 4. Initial authoring threads the contract

So the reshape has real targets, the describe→generate flow must _create_ the wiring:

- **`/design-game` (GDD):** filling `symbols-reels`, each symbol row gets a stable `slot`.
  Schema + skill-prose change; the agent already fills this table. `field_catalog()` (the
  router's addressable-surface prompt) includes `slot`.
- **Asset generation per slot:** `generate_asset` gains an optional `slot` (or a thin
  `generate_symbol_asset(slot, description)` wrapper) that tags the created asset with the
  slot — binding _slot → Asset_. `list_assets` surfaces the slot so the scene agent can
  match.
- **`/design-scene`:** when laying out symbol sprites, each symbol Sprite is created with
  `props.slot = "<slot>"` and bound (data edge) to a Texture whose `src` is that slot's
  selected media. Decorative nodes carry no slot. Skill-prose change; the tools already
  let the agent set props and bind textures.

After authoring, a query for `slot=high1` finds exactly one GDD row, one Asset, and one
Sprite→Texture — the join is real, not inferred.

## 5. The reshape path (deterministic realize step)

Plain chat in a game room stays on the **design-router**, extended with **one** new tool,
`realize_symbol`:

1. User: _"make the high symbol a dragon."_
2. Router (LLM — the _design_ decision): resolves "high symbol" → `slot=high1`, calls
   `set_gdd_fields('symbols-reels', …)` to update that row's `name`/`art_desc` to the
   dragon. **The GDD bends** (works today).
3. Router calls **`realize_symbol('high1')`** — deterministic, no LLM:
   - look up the `high1` Asset; update its prompt to the new `art_desc`; **regenerate**
     it (`asset_hub.generate_and_wait` → a new `Generation` via ComfyUI);
   - find the Sprite with `props.slot == 'high1'`, follow its data edge to the Texture
     node, and **rewrite `Texture.src`** to the new generation's `image_ref` — a **single
     atomic scene write** (`scene_hub.apply_op`, now serialized; see §6).
4. Engine receives the `setProp` on the Texture's `src`; the reconciler re-binds the
   texture (existing behavior in `runtime/client/src/render/reconciler.ts` — a `propSet`
   on a Texture's `src` re-runs `bindTexture`) → **the sprite re-paints as the dragon**,
   no reload.

The LLM only ever _designs_ (edits the GDD, picks the slot); a deterministic op
_realizes_ it. The racy multi-op authoring dance never happens on the reshape — it is one
atomic write.

**`realize_symbol(slot)` algorithm (deterministic):**

1. Read `symbols-reels`; find the row with `slot`; take its `art_desc` (already updated by
   the agent). (If called without a prior GDD edit, it still regenerates from the current
   `art_desc` — idempotent.)
2. Resolve the slot's Asset (`asset_store` by `(game_id, slot)`); update its prompt;
   `asset_hub.generate_and_wait` → new selected generation; read its `image_ref`.
3. Resolve the Sprite node (`props.slot == slot`) in the scene; follow its `data` edge to
   the Texture node; `apply_op` a `setProp` of `Texture.src = image_ref`.
4. Return a human confirmation ("Reshaped the high symbol → dragon").

Edge handling: missing slot / missing asset / missing sprite each return a clear message
(the agent surfaces it) rather than throwing.

## 6. The #69 concurrency fix (prerequisite)

`GameSceneStore.apply_op` reads, modifies in memory, then `replace_one`s with no
serialization; concurrent ops within one turn clobber. Fix:

- **Per-game serialization in `GameSceneHub`:** an `asyncio.Lock` keyed by `game_id`
  wrapping `apply_op` and `apply_batch`, so each scene write (read→modify→write→broadcast)
  is atomic per game. The backend is single-process, so a lock is sufficient and simple —
  the per-game-lock direction noted in #69.

This is load-bearing, not polish: without it, initial `/design-scene` can't reliably build
the labeled-sprite scene the contract depends on, and `realize_symbol`'s rebind isn't safe.
`apply_batch` is retained for grouped authoring; the lock only removes the interleave
hazard.

**Dev-ergonomics fix (found in verification):** there is no way to launch the engine
(`:4300`) — no justfile recipe and no nx `serve` target; `pixi.js` was also declared but
uninstalled. Add a **`just engine-serve`** recipe (+ nx `serve` target) so the full stack
(`backend` + `frontend` + `engine`) is launchable without a manual `npx vite`.

## 7. Module touch-list

- `studio/backend/app/gdd/schemas.py` — `symbols-reels.symbols` gains `slot`; `field_catalog` surfaces it.
- `studio/backend/app/assets/models.py` + store — `Asset.slot`; lookup by `(game_id, slot)`.
- `studio/backend/app/agent_tools.py` — `generate_asset` optional `slot` (or wrapper); `list_assets` surfaces slot; **new `realize_symbol` builder**; register in `ToolFactory._BUILDERS` (a known hot file — keep the edit minimal).
- `studio/backend/app/gdd/router.py` — design-router tool allowlist gains `realize_symbol`; system prompt teaches "after changing a symbol, call `realize_symbol(slot)`".
- `studio/backend/app/scene/hub.py` — per-game `asyncio.Lock` around `apply_op`/`apply_batch`.
- `skills/design-game.md`, `skills/design-scene.md` — slot-threading prose.
- `justfile` + `runtime/client/project.json` — `engine-serve` recipe / nx `serve` target.
- `runtime/client/src/render/reconciler.ts` — **no change** (already re-binds on `Texture.src` change); covered by a test.

## 8. Testing strategy (repo TDD + e2e-as-truth)

**Unit (CI-affordable):**

- GDD schema: `symbols` table carries `slot`; `field_catalog()` includes it.
- Asset store: persist + look up an asset by `(game_id, slot)`.
- `realize_symbol` pure resolution (with fakes): given `slot`, resolves asset + Sprite →
  Texture and produces the correct `setProp` op; missing-slot/asset/sprite → clear errors.
- **Concurrency:** N concurrent `apply_op` calls on one game all survive — `version`
  increments to N, no lost update (the regression test for #69).
- Engine: a `propSet` on a Texture's `src` re-binds the sprite's texture (extend the
  existing `runtime/client` reconciler spec).

**Backend non-browser e2e (CI, replay):** run the conversational reshape through the real
agent loop under a curated run cassette — assert the GDD symbol updated **and** the asset
regenerated **and** `Texture.src` rewritten **and** a `scene_op` broadcast. Mirrors
`tests/e2e/test_scene.py`'s `run_skill` style. Cassette curated (hand-appended to the
shared `run/default.json` union, filtered by the router's bound tools), not
`record-fixtures`.

**Browser e2e (Playwright, local — authoritative):** the whole loop — author a game with
slots → assert symbol sprites are labeled and their textures bound → send _"make the high
symbol a dragon"_ → assert the high-symbol Sprite's Texture `src` changed to a **new
generation** and the **rendered pixels changed** in the real engine iframe (non-`EMPTY`
texture, new dimensions/hash). Without the pixel assertion we cannot honestly claim "the
game re-paints".

## 9. Scope boundary

**In:** the `slot` contract across GDD/asset/scene; slot-threading in initial authoring;
`realize_symbol`; design-router gains the tool + prose; the #69 per-game lock;
`engine-serve` recipe; the tests above.

**Labeled, not built (deferred):**

- Other reshape verbs (theme swap, layout/add-a-row) — they reuse the same `slot` contract
  but are separate slices.
- Multi-symbol / whole-theme cascades in one turn.
- Asset-id → URL resolver / re-selection auto-update beyond the `realize_symbol` rewrite
  (Plan 2 §7 deferral stands).
- Cross-process scene-write concurrency (optimistic version check) — the single-process
  lock is sufficient now.
- Math reconciliation of the changed symbol (RTP impact) — the simulator path is separate.

## 10. Open questions

- Exact `slot` vocabulary (e.g. `high1/high2/low1…` vs `kind`-derived) — finalize when the
  `symbols-reels` schema change is implemented; the contract only requires uniqueness +
  stability.
- Whether `generate_asset` gains an optional `slot` param vs a dedicated
  `generate_symbol_asset` wrapper — decide during implementation by which keeps the tool
  surface and skill prose clearest.
