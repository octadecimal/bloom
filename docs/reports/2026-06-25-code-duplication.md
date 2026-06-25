# Code Duplication Report — 2026-06-25

**Commit:** `a5fc012` (main)
**Scope:** Python (`studio/backend/app`), TS/TSX (`studio/frontend/src`, `runtime/client`), Rust (`trusted/math`, `trusted/package`, `studio/simulator`, `studio/tuner`). Each stack analyzed independently within itself.
**Method:** `jscpd` 4.2.5 (flags: `--min-tokens 50 --min-lines 5 --mode mild`; ignored `node_modules`, `target`, `.venv`, `dist`, `__pycache__`, `*.snap`, `*.lock`) for exact/near-exact clones, plus one per-stack reading agent for structural/semantic and boilerplate duplication the tokenizer cannot see. Every finding below was confirmed against the cited source lines.
**Caveat:** Reflects committed `main` only. The in-flight worktrees `symbol-reshape` and `tuner-studio` are **excluded**; findings may shift once those land. This is a report — no code was changed.

## Executive summary

| Stack     |  High |   Med |    Low |  Total |
| --------- | ----: | ----: | -----: | -----: |
| Python    |     2 |     5 |      2 |      9 |
| TS/TSX    |     2 |     3 |      4 |      9 |
| Rust      |     1 |     0 |      5 |      6 |
| **Total** | **5** | **8** | **11** | **24** |

**Headline:** The codebase is not heavily clone-ridden — jscpd measured only 2.82% duplicated lines overall, and most exact clones are benign test fixtures. The real duplication is **structural**, and it clusters in two shapes: (1) **wire/protocol models hand-mirrored across a boundary** (engine ↔ studio in TS; `TargetSpec` ↔ deser mirrors in Rust), where drift silently breaks a contract, and (2) **per-plugin / per-subsystem scaffolding** (socket clients, stores, wire serializers, tool wiring) where every new feature re-pastes the same shape, creating the merge-conflict hot spots already noted in the team's working notes.

**Top findings across the whole codebase (all 5 High):**

1. **[T1] Engine document model duplicated** between `runtime/client` and the studio `game` plugin — a comment literally says "keep them in lockstep." Drift breaks the iframe protocol. _(TS, effort L)_
2. **[T2] postMessage protocol unions defined twice** — the two ends of one wire, nothing enforcing agreement. _(TS, effort M)_
3. **[P1] `ToolFactory._BUILDERS` / `ToolContext` / `RoomHub.__init__` wiring** — adding one tool edits four hot spots in lockstep; the known merge-conflict magnet. _(Python, effort L)_
4. **[P2] Hub queue/drain/lock machinery duplicated** between `RoomHub` and `AssetHub` — subtle concurrency code, divergence causes real races. _(Python, effort L)_
5. **[R1] `TargetJson`/`BandJson` deser mirrors + `TargetSpec` construction triplicated** across three CLI binaries — exists only because `TargetSpec` lacks a serde derive. _(Rust, effort M)_

**Suggested sequencing:** R1 is the cheapest High (a serde derive deletes ~150 lines across three files). T1+T2 should be done together (one shared `scene-protocol` package fixes both). P1 and P2 are the larger architectural seams — schedule deliberately. The Med-tier `S`-effort items (P3–P5, T3) are good low-risk warm-ups.

---

## Python

| #   | Type        | Title                                                                      | Severity | Effort |
| --- | ----------- | -------------------------------------------------------------------------- | -------- | ------ |
| P1  | boilerplate | `ToolFactory._BUILDERS` / `RoomHub.__init__` wiring grows with every tool  | High     | L      |
| P2  | boilerplate | Hub queue/drain/lock machinery duplicated between `RoomHub` and `AssetHub` | High     | L      |
| P3  | boilerplate | `_WireModel` config + `*_wire` serializers redefined per model module      | Med      | S      |
| P4  | clone       | Approval / question step-completion emit blocks identical                  | Med      | S      |
| P5  | structural  | Per-subsystem socket join/leave registrars near-identical                  | Med      | S      |
| P6  | boilerplate | Mongo doc ↔ pydantic id-remap store helpers duplicated                    | Med      | M      |
| P7  | structural  | Scene tool builders repeat op-dispatch + `OpError` wrapper                 | Med      | M      |
| P8  | clone       | REST handlers repeat the room-existence 404 guard                          | Low      | S      |
| P9  | boilerplate | `_now()` reimplemented in five modules, inconsistent return type           | Low      | S      |

### P1 — `ToolFactory._BUILDERS` / `ToolContext` / `RoomHub.__init__` wiring grows with every tool _(High, L)_

`studio/backend/app/agent_tools.py:11-20`, `agent_tools.py:408-441`, `room_hub.py:14-58`, `main.py:99-113`

Adding one agent tool requires editing four hot spots in lockstep: a `build_*` function, the `_BUILDERS` dict entry, `ToolContext` fields (the dependency bag, currently typed as bare `object`), `ToolFactory.__init__`'s positional `store`/`hub` params, and `RoomHub.__init__`'s parallel `store`/`hub` kwargs that get re-bundled into `ToolContext` in `_run_skill`. These references are threaded by hand through `ToolFactory.__init__`, `RoomHub.__init__`, and `main.build` — so every feature touches them, which is exactly the merge-conflict magnet called out in the team's `avoid-merge-conflicts` note.

**Fix:** Introduce a single `Services` dependency-container dataclass (`asset_store`, `asset_hub`, `gdd_*`, `scene_*`, and the rest) constructed once in `main.build` and passed whole into `ToolFactory` and `RoomHub` instead of N positional/keyword params; `ToolFactory` builds `ToolContext` from it. Consider a `@register_tool` decorator so `_BUILDERS` self-populates and adding a tool touches one file.

### P2 — Hub queue/drain/lock machinery duplicated between `RoomHub` and `AssetHub` _(High, L)_

`studio/backend/app/room_hub.py:49-61`, `room_hub.py:170-191`, `assets/hub.py:16-59` (and the `_lock`/`_locks` pair again in `scene/hub.py`)

`RoomHub` and `AssetHub` independently implement the same per-key serialized work-queue: a `_queues` dict, a `_busy` set, a `_locks` dict with an identical `_lock` (`setdefault` Lock), an `attach_subscriber` that emits an active-snapshot under the lock, and a `_drain` loop that pops the queue under the lock, runs an item, and clears `_busy` when empty. The snapshot-vs-live race is subtle (commented in both), so divergence here causes real bugs rather than cosmetic drift.

**Fix:** Extract a reusable `SerialWorkQueue` / `KeyedLockMixin` (e.g. `app/work_queue.py`) owning `_queues`/`_busy`/`_locks`, `_lock(key)`, `enqueue`, and a drain loop that takes a `run(item)` callback. `RoomHub` and `AssetHub` compose it; `scene/hub.py` reuses just the keyed-lock part.

### P3 — `_WireModel` config + `*_wire` serializers redefined per model module _(Med, S)_

`studio/backend/app/models.py:8-9`, `assets/models.py:11-12`, `gdd/models.py:12-13`, `simulator/models.py:5-6`, `games.py:9-13`

The identical `class _WireModel(BaseModel)` with `ConfigDict(alias_generator=to_camel, populate_by_name=True)` is copy-defined in four modules (`games.py` inlines the same `ConfigDict`). Alongside it, seven trivial `*_wire` functions (`room_wire`, `message_wire`, `run_wire`, `asset_wire`, `sim_wire`, `gdd_wire`, `game_wire`) are all the same one-liner `return X.model_dump(by_alias=True, mode='json')`. A change to the wire convention must be made in 4–5 places.

**Fix:** Define `_WireModel` once in `app/wire.py` and import it everywhere; give it a `.wire()` method so the standalone `*_wire` functions collapse to that method (or a single `wire(model)` free function).

### P4 — Approval / question step-completion emit blocks identical _(Med, S)_

`studio/backend/app/room_hub.py:399-418`, `room_hub.py:420-439` (emit dict repeats a third time at `room_hub.py:494-506`)

jscpd-confirmed clone. `_complete_approval` and `_complete_question` are the same method: pop the pending entry, read `step_index`, build `content = json.dumps({**action, <key>: value})`, call `run_store.complete_step(..., 'complete', content)`, then emit an identical `run_step_completed` payload. The only difference is the merged key name (`'decision'` vs `'answer'`). The whole emit dict appears a third time in `_project_run_event`.

**Fix:** Extract `_finalize_step(room_id, run_id, content)` that persists `complete_step` + emits `run_step_completed`; both completers build only the content dict and call it. Reuse the same emit helper in `_project_run_event`'s `StepCompleted` branch.

### P5 — Per-subsystem socket join/leave registrars near-identical _(Med, S)_

`studio/backend/app/gdd/sockets.py:1-8`, `scene/sockets.py:1-9`, `simulator/sockets.py:1-8`, `assets/sockets.py:1-8`

Four `register_*_handlers` functions each define a `join_<x>`/`leave_<x>` pair doing the same thing: join calls `hub.attach`/`attach_subscriber(data['gameId'], sid)`, leave calls `sio.leave_room(sid, data['gameId'])`. Only the event-name prefix and the attach method name differ (assets/sim use `attach_subscriber`, gdd/scene use `attach`) — and that drift already shows the pattern is fragile.

**Fix:** Add a shared helper `app/socket_rooms.py` — `register_game_room(sio, hub, prefix, attach='attach')` — wiring `join_<prefix>`/`leave_<prefix>` against `data['gameId']`. Each subpackage's `sockets.py` becomes a one-line call. Normalize `attach` vs `attach_subscriber` while doing it.

### P6 — Mongo doc ↔ pydantic id-remap store helpers duplicated _(Med, M)_

`studio/backend/app/gdd/store.py:19-28`, `assets/store.py:14-23`, `simulator/store.py:12-21`, `games.py:20-25`, `store.py:15-56`

Three stores (gdd, assets, simulator) carry byte-identical `_to_doc`/`_from_doc` helpers that round-trip a pydantic model to a Mongo doc by swapping `id`↔`_id`. `games.py` and `store.py` hand-roll the same mapping field-by-field. This is a missing persistence-mapping seam; every new Mongo-backed model re-implements it and can drift (e.g. `mode='json'` vs not).

**Fix:** Introduce `app/mongo_doc.py` with `to_mongo(model)` / `from_mongo(model_cls, raw)` using the `id`↔`_id` convention; each store delegates. Optionally a generic `MongoStore[T]` base for the `get`/`list`/`insert` plumbing.

### P7 — Scene tool builders repeat op-dispatch + `OpError` wrapper _(Med, M)_

`studio/backend/app/agent_tools.py:228-247`, `:250-268`, `:271-288`, `:291-302`, `:305-316`, `:319-339`

Six `build_scene_*` tools share one body shape: optionally `json.loads` an args string (returning `Invalid <field>: {e}`), construct an op dict, then `try: await ctx.scene_hub.apply_op/apply_batch(...) except OpError as e: return f'Rejected ({e.code}): {e}'`, then a success string. The try/except-to-string block and the JSON-parse guard are copied verbatim across all of them.

**Fix:** Extract `_apply_scene_op(ctx, op_or_ops, success)` and `_parse_json_arg(raw, field)` that centralize the `OpError`→string and `JSONDecodeError`→string handling; each builder reduces to assembling the op dict and calling it.

### P8 — REST handlers repeat the room-existence 404 guard _(Low, S)_

`studio/backend/app/rest.py:100-107`, `rest.py:127-135`

jscpd-confirmed clone. `list_messages` and `list_runs` both open with the same four lines: fetch `store`, `room = await store.get_room(room_id)`, `if room is None: raise HTTPException(404, 'room not found')`. Small, but the canonical place a FastAPI dependency would help — and it will be re-pasted for every future room-scoped route.

**Fix:** Add a FastAPI dependency `require_room(room_id, request) -> Room` that fetches and 404s, then inject it (`room: Room = Depends(require_room)`) into both routes and future room-scoped endpoints.

### P9 — `_now()` reimplemented in five modules, inconsistent return type _(Low, S)_

`studio/backend/app/store.py:7-8`, `runs.py:8-9`, `gdd/store.py:15-16`, `assets/store.py:10-11`, `simulator/store.py:8-9`

Five modules define a private `_now()`. Four return a `datetime` (`datetime.now(timezone.utc)`); `simulator/store.py` returns the isoformat string instead, and `gdd/store.py` mixes both. The datetime-vs-str inconsistency is exactly the kind of bug a single shared helper prevents.

**Fix:** Provide one `app/time.py` with `utc_now()` (datetime) and `utc_now_iso()` (str); replace the five local definitions and make the persisted-timestamp type a deliberate choice rather than per-file drift.

---

## TS/TSX

| #   | Type        | Title                                                                              | Severity | Effort |
| --- | ----------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| T1  | structural  | Engine document model duplicated between `runtime/client` and studio `game` plugin | High     | L      |
| T2  | structural  | postMessage protocol message-type unions defined twice                             | High     | M      |
| T3  | clone       | `okJson<T>` fetch helper copy-pasted across every plugin `restClient`              | Med      | S      |
| T4  | boilerplate | socket.io singleton + `isActive` + connect/disconnect scaffold per plugin          | Med      | M      |
| T5  | structural  | `openGame`/`closeGame` active-game lifecycle repeated across plugins               | Med      | M      |
| T6  | boilerplate | Per-plugin `state.ts` scaffold (slice accessor + hooks)                            | Low      | S      |
| T7  | boilerplate | Plugin registration scaffold (config re-export + index `IPlugin` literal)          | Low      | S      |
| T8  | clone       | `openRoom`/`closeRoom` duplicate the slice-reset block                             | Low      | S      |
| T9  | clone       | Test-only: repeated socket mocks + render/act preambles in spec files              | Low      | M      |

### T1 — Engine document model duplicated between `runtime/client` and studio `game` plugin _(High, L)_

`runtime/client/src/model/document.ts:1-32`, `studio/frontend/src/plugins/game/state.ts:9-42`, `runtime/client/src/model/ops.ts:3-8`, `studio/frontend/src/plugins/game/reducers.ts:3-8`

The wire model is hand-mirrored across the two source roots: `NodeType`/`EdgeType`/`JsonValue`/`IPortRef`/`INode`/`IEdge`/`IGameDocument` plus `emptyDocument()` are duplicated in `document.ts` and `game/state.ts` (confirmed byte-identical), and the 5-arm scene-op discriminated union is duplicated as `Op` (`ops.ts`) vs `ISceneOp` (`reducers.ts`) — identical except the type name. A comment in `game/state.ts` even says "keep them in lockstep with the engine." Adding a node type or op kind requires synchronized edits in both roots or the iframe protocol silently drifts.

**Fix:** Promote the model + op types to a single shared package (e.g. a `@bloom/scene-protocol` lib, or a shared `protocol/` dir consumed by both roots) and import from it in both `runtime/client/src/model` and `studio/frontend/src/plugins/game`. At minimum, generate one from the other.

### T2 — postMessage protocol message-type unions defined twice _(High, M)_

`runtime/client/src/protocol/messages.ts:6-14`, `studio/frontend/src/plugins/game/protocolBridge.ts:4-12`

`InboundMessage` and `OutboundMessage` discriminated unions are declared independently in the engine host (`messages.ts`) and the studio bridge (`protocolBridge.ts`), identical except `Op` vs `ISceneOp` naming. These are literally the two ends of the same postMessage protocol; a new message kind or a `protocolVersion` bump must be edited in both files with nothing enforcing agreement. **Do this together with T1** — the same shared package fixes both.

**Fix:** Move `InboundMessage`/`OutboundMessage`/`PROTOCOL_VERSION` into the shared scene-protocol package and import in both `ProtocolHost` and `ProtocolBridge`.

### T3 — `okJson<T>` fetch helper copy-pasted across every plugin `restClient` _(Med, S)_

`studio/frontend/src/plugins/llm-chat/restClient.ts:10-13`, `simulator/restClient.ts:4-7`, `gdd/restClient.ts:4-7`, `assets/restClient.ts:15-18`

The identical `async function okJson<T>(res): Promise<T>` (throw on `!res.ok`, else cast JSON) is defined verbatim in four plugin `restClient` modules (jscpd flagged 3 of the 6 pairwise instances). Every plugin also independently re-imports/re-exports `BACKEND_URL`. Divergence-prone: any change to error handling (e.g. reading a JSON `detail` field, as `saveSkill` already does inline) must be made in four places.

**Fix:** Extract a shared `studio/frontend/src/lib/http.ts` exporting `okJson<T>` (and optionally `postJson`/`patchJson` wrapping method + JSON-headers + body, itself repeated in `createAsset`/`updateAsset`/`putSlotModel`/`createRoom`/`selectGeneration`). Import it in each `restClient`.

### T4 — socket.io singleton + `isActive` + connect/disconnect scaffold per plugin _(Med, M)_

`studio/frontend/src/plugins/gdd/socketClient.ts:1-45`, `simulator/socketClient.ts:1-55`, `game/socketClient.ts:34-78`, `assets/socketClient.ts:57-108`

Every plugin `socketClient` hand-rolls the same scaffolding: `let sock: Socket|null`, an `isActive(gameId)` guard comparing `xSlice().activeGameId`, a `createXSocket()` factory doing `io(BACKEND_URL, { auth: { displayName } })`, inbound handler registration, connect/disconnect + join/leave emit wrappers, and a module-level lazy singleton + `xSock()` accessor. assets + llm-chat additionally duplicate the `ISocketLike` interface and the `createSocketClient`/`initSocketClient`/`getSocketClient` triad. Only the event names and handler bodies differ.

**Fix:** Introduce a `studio/frontend/src/lib/socketClient.ts` factory `createPluginSocket({ displayName, slice, joinEvent, leaveEvent, handlers })` owning the singleton, `isActive` guard, connect/disconnect, and emit wrappers; each plugin supplies only its handler map. Hoist `ISocketLike` there too.

### T5 — `openGame`/`closeGame` active-game lifecycle repeated across plugins _(Med, M)_

`studio/frontend/src/plugins/assets/actions.ts:46-83`, `gdd/actions.ts:9-37`, `simulator/actions.ts:7-49`, `game/actions.ts:4-30`

Four plugins implement the same open/close-game shape: open = set `activeGameId`, status `'loading'`, join the socket room, await a rest fetch, populate slice + `'idle'`, catch → `'error'` (with a stale-game guard in assets); close = leave the prior room and reset slice fields. The status unions (`'idle'|'loading'|'error'`) and connection unions (`'connecting'|'connected'|'reconnecting'|'disconnected'`) are likewise re-declared in all five state files.

**Fix:** Extract a shared `useActiveGame` / `openActiveGame(slice, { join, leave, fetch, apply })` helper in `lib/` plus shared `ConnectionState`/`LoadStatus` type aliases; each plugin passes only its fetch + apply. Reuse llm-chat's existing `ConnState` as the canonical type.

### T6 — Per-plugin `state.ts` scaffold (slice accessor + hooks) _(Low, S)_

`studio/frontend/src/plugins/gdd/state.ts:40-46`, `simulator/state.ts:80-86`, `assets/state.ts:55-61`, `game/state.ts:53-57`

Each plugin repeats the same trailing boilerplate: `export const xHooks = makePluginHooks<IXState>(X_PLUGIN_ID)` and `export function xSlice(): State<IXState> { return rootStore.plugins.nested(X_PLUGIN_ID) as unknown as State<IXState>; }`. The cast pattern is also re-inlined in `demo-counter/index.ts` and `game/state.ts`. `makePluginHooks` abstracts the hooks half but not the slice accessor.

**Fix:** Have `makePluginHooks` (or a sibling `makePluginSlice<T>(pluginId)`) return the `slice()` accessor alongside `usePluginState`/`useHost`, so each `state.ts` gets it in one call.

### T7 — Plugin registration scaffold (config re-export + index `IPlugin` literal) _(Low, S)_

`studio/frontend/src/plugins/game/index.ts:1-13`, `gdd/index.ts:1-13`, `simulator/index.ts:1-13`, `assets/index.ts:1-15`

Each plugin `index.ts` is the same `IPlugin` literal differing only in id/title/pane/command/init, and gdd/game/simulator `config.ts` are each a one-line re-export of `BACKEND_URL` from the assets plugin. Low-payoff (this is also the readable, explicit registration seam) — noted for completeness; the config re-export chain in particular is pure indirection.

**Fix:** Optionally a `defineGamePlugin({ id, title, pane, init })` helper that builds the single-pane/single-command literal; and move `BACKEND_URL` to a shared `lib/config` so plugins import it directly instead of re-exporting from the assets plugin.

### T8 — `openRoom`/`closeRoom` duplicate the slice-reset block _(Low, S)_

`studio/frontend/src/plugins/llm-chat/actions.ts:85-93`, `actions.ts:108-118`

jscpd-confirmed. `openRoom` and `closeRoom` both inline the same reset sequence (`messages.set([])`, `runs.set([])`, `activeRunId.set(null)`, `members.set([])`, `typing.set([])`, `persist()`). Small, duplicated within one file.

**Fix:** Extract a private `resetRoomSlice(s)` helper in `actions.ts` and call it from both `openRoom` and `closeRoom`.

### T9 — Test-only: repeated socket mocks + render/act preambles in spec files _(Low, M)_

`studio/frontend/src/plugins/llm-chat/actions.spec.ts:14-25`, `llm-chat/ChatRoomPane.spec.tsx:141-204`, `assets/actions.spec.ts:30-95`, `assets/AssetCard.spec.tsx:45-148`, `app/routes/RoomPicker.spec.tsx:38-72`, `runtime/client/src/render/reconciler.props.spec.ts:7-21`, `reconciler.nodes.spec.ts:25-30`

The bulk of jscpd's TS/TSX hits live in `.spec` files: the full chat socket-mock literal (`connect`/`disconnect`/`reconnectWith`/`joinRoom`/`leaveRoom`/`sendPrompt`/`setTyping`/`runSkill`/`resolveApproval`, all `vi.fn()`) repeats ~6× in `actions.spec.ts` and again in `ChatRoomPane.spec.tsx`; assets specs repeat the rest+socket dep mock; several specs repeat render+seed+act preambles; reconciler specs repeat the `new GraphModel()`/`MockRenderer()`/`Reconciler()` setup. Low per the test-duplication guideline, but the chat socket-mock is borderline egregious because it tracks the real client surface and can drift from it.

**Fix:** Add per-plugin test helpers: `makeChatSocketMock()` / `makeAssetsDeps()` factories, a `renderChatRoom()`/`seedAndRender()` helper, and a `newReconcilerHarness()` in the runtime render tests. Keeps the mock surface defined once so it can't drift from the real client.

---

## Rust

| #   | Type       | Title                                                                                       | Severity | Effort |
| --- | ---------- | ------------------------------------------------------------------------------------------- | -------- | ------ |
| R1  | structural | `TargetJson`/`BandJson` deser mirrors + `TargetSpec` construction triplicated across 3 CLIs | High     | M      |
| R2  | clone      | Arg-parse + file-read boilerplate shared between `curate.rs` and `tune.rs`                  | Low      | S      |
| R3  | clone      | Test-only `target()`/`metrics()` builders duplicated across simulator & tuner tests         | Low      | S      |
| R4  | clone      | Duplicated `GeneBounds`/`Weights` test-config block within tuner tests                      | Low      | S      |
| R5  | clone      | Test-only `SlotModel` fixtures duplicated within the math kernel's own tests                | Low      | S      |
| R6  | clone      | Test-only `SlotModel` fixtures duplicated across simulator & tuner tests                    | Low      | M      |

> **Note (good news):** the worst-case pattern — `studio/simulator`/`studio/tuner` reimplementing trusted-kernel logic (SplitMix64 RNG, RTP/volatility/hit-rate, eval, `RoundOutcome`) — does **not** occur. `SplitMix64` lives only in `trusted/math/src/rng.rs`, and the tuner's `genetic.rs` correctly imports `measure`, `simulate`, `verify`, and `generate_seeds` from `bloom_simulator` rather than reimplementing them. Apart from R1, all Rust duplication is test-fixture code.

### R1 — `TargetJson`/`BandJson` deser mirrors + `TargetSpec` construction triplicated across 3 CLIs _(High, M)_

`studio/simulator/src/bin/curate.rs:22-71`, `studio/simulator/src/bin/curate_json.rs:14-114`, `studio/tuner/src/bin/tune.rs:16-98`

All three CLI binaries hand-declare identical `BandJson { min, max }` and `TargetJson { rtp_target, rtp_tolerance, volatility_min, volatility_max, bonus_hit_rate_bands, pool_size, candidate_count, realized_correction_band, master_seed }` deserialization structs, then run the same ~17-line block that maps `TargetJson` → `bloom_simulator::target::TargetSpec` (including the `bonus_hit_rate_bands.iter().map(|b| HitRateBand { min: b.min, max: b.max }).collect()` re-mapping). This parallel hand-written deser layer exists **only because** `TargetSpec`/`HitRateBand` in `target.rs` do not derive `serde::Deserialize` (unlike `SlotModel`, which does). Any new target field must be added in four places. jscpd flagged the struct block and the construction block as separate clones; they share this one root cause.

**Fix:** Derive `serde::Deserialize` on `TargetSpec` and `HitRateBand` in `studio/simulator/src/target.rs` (handle `master_seed` via `#[serde(default)]` or a separate field). Then delete `BandJson`/`TargetJson` and the manual mapping from all three binaries, deserializing straight into `TargetSpec`. If `master_seed` must stay outside `TargetSpec`, introduce one shared `fn load_target(path) -> (TargetSpec, u64)` helper and call it from all three.

### R2 — Arg-parse + file-read boilerplate shared between `curate.rs` and `tune.rs` _(Low, S)_

`studio/simulator/src/bin/curate.rs:42-53`, `studio/tuner/src/bin/tune.rs:69-80`

Both binaries open with the same `let args: Vec<String> = std::env::args().collect(); if args.len() != 6 { eprintln!(usage); exit(2) }` guard followed by the same `serde_json::from_str(&fs::read_to_string(&args[N]).expect(...)).expect(...)` load idiom (`curate_json.rs` uses a `map_err` variant). Small but identical CLI plumbing.

**Fix:** Add a tiny shared helper (`bloom_simulator::cli::read_json::<T>(path) -> T`, and/or `require_args(n) -> Vec<String>`) and call it from all three binaries. Low payoff alone — bundle with R1 so the CLIs shrink to a few lines each.

### R3 — Test-only `target()`/`metrics()` builders duplicated across simulator & tuner tests _(Low, S)_

`studio/simulator/src/run.rs:289-311`, `studio/tuner/src/fitness.rs:91-113`, `studio/tuner/src/validate.rs:88-106`

The `fn target(bands) -> TargetSpec { rtp_target: 0.96, … realized_correction_band: 0.05 }` and `fn metrics(rtp, vol, bonus) -> Metrics { … }` helper builders are copy-pasted between `run.rs`, `fitness.rs`, and `validate.rs` test modules (jscpd flagged `run.rs` vs `fitness.rs`). Test-only, hence Low, but a clean shared-test-helper opportunity that also reduces drift when `TargetSpec`/`Metrics` fields change.

**Fix:** Add `bloom_simulator::target::testing` (test-support, `cfg`-gated) with `target_spec(bands)` and `metrics(rtp, vol, bonus)` builders; import from simulator and tuner test modules.

### R4 — Duplicated `GeneBounds`/`Weights` test-config block within tuner tests _(Low, S)_

`studio/tuner/src/genetic.rs:291-318`, `studio/tuner/src/validate.rs:108-135`

The `fn cfg() -> TunerConfig { … bounds: GeneBounds { … }, weights: Weights { rtp: 1.0, volatility: 1.0, hit_rate: 1.0 } }` block is duplicated between `genetic.rs` and `validate.rs` test modules. Same crate, test-only — Low.

**Fix:** Hoist one `fn sample_cfg(master_seed)` (or a `pub(crate) mod test_support`) into the tuner crate and call it from both test modules instead of redefining the `GeneBounds`/`Weights` literals.

### R5 — Test-only `SlotModel` fixtures duplicated within the math kernel's own tests _(Low, S)_

`trusted/math/src/mechanics/slots/eval.rs:246-261`, `eval.rs:379-392`, `eval.rs:454-471`, `model.rs:112-129`

Several `#[cfg(test)]` `SlotModel` builders inside `trusted/math` repeat the same symbols block (sym0 Normal / sym1 Wild / sym9 Scatter) and reel/paytable scaffolding. Purely test-fixture duplication local to the kernel; production eval/model logic is **not** duplicated. Low.

**Fix:** Within `trusted/math` add a single `#[cfg(test)] mod test_support` (or reuse `model.rs`'s `sample_model()`) providing the wild+scatter sample model; import in `eval.rs` tests instead of re-declaring the symbol/reel blocks.

### R6 — Test-only `SlotModel` fixtures duplicated across simulator & tuner tests _(Low, M)_

`studio/simulator/src/measure.rs:114-151`, `studio/simulator/src/run.rs:195-230`, `studio/tuner/src/genetic.rs:241-276`

The identical "1 reel, strip 5×sym0/4×sym1/1×sym2, paytable sym1@1→1, sym2@1→5, closed-form RTP 0.9" `SlotModel` builder is copied into three `#[cfg(test)]` modules (the tuner version parameterized by `payout_sym2`, otherwise identical). Test-fixture, so Low — but sizeable (~36 lines each) and spans crate boundaries, so a reasonable consolidation candidate.

**Fix:** Expose a test-fixture builder from the trusted kernel behind a `cfg`-gated test-support module, e.g. `bloom_math::mechanics::slots::testing::measurable_model(payout_sym2)`, and have the simulator/tuner test modules import it instead of redefining. Keeps the canonical 0.9-RTP fixture in one place. (Pairs with R3/R5.)

---

## Appendix: raw jscpd metrics

`jscpd` 4.2.5, run from `C:\code\bloom` against the source roots, `--min-tokens 50 --min-lines 5 --mode mild`, ignoring `node_modules`, `target`, `.venv`, `dist`, `__pycache__`, `*.snap`, `*.lock`.

| Format              |   Files |      Lines | Clones | Duplicated lines |
| ------------------- | ------: | ---------: | -----: | ---------------- |
| rust                |      24 |      3,545 |     12 | 248 (7.00%)      |
| typescript          |     144 |      6,392 |     19 | 189 (2.96%)      |
| tsx                 |      82 |      4,357 |      8 | 56 (1.29%)       |
| python              |      46 |      4,146 |      2 | 19 (0.46%)       |
| json                |       7 |        210 |      4 | 67 (31.9%)       |
| javascript          |      58 |      1,415 |      0 | 0                |
| css / markup / toml |       9 |        459 |      0 | 0                |
| **Total**           | **370** | **20,524** | **45** | **579 (2.82%)**  |

**Reading the numbers:**

- **Rust** shows the highest exact-clone density (7%), but nearly all of it is test-fixture duplication (R3–R6) plus the genuinely-structural R1 — not production-logic clones.
- **Python** has almost no token-level duplication (0.46%, 2 clones); its findings are overwhelmingly _structural/boilerplate_ that jscpd cannot see, which is why the agent pass matters here.
- **JSON** at 31.9% is config/fixture data (not source code) and was not analyzed as a finding; listed only for completeness.
- jscpd flagged 45 clones; many collapse into the structural findings above (e.g. the three Rust CLI clones are one root cause, R1), and a large share are test files (T9, R3–R6).

**Caveats / limitations:**

- Token-based detection (jscpd) misses semantic duplication entirely; that gap is covered by the agent reading pass, but agent coverage is judgment-based and not exhaustive — there may be additional structural duplication not surfaced here.
- Line numbers reflect commit `a5fc012`; they will drift as the tree changes.
- The `symbol-reshape` and `tuner-studio` worktrees are excluded; they may add or resolve duplication (especially around the symbol/scene contract relevant to T1/T2) once merged.
