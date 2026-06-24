# Bloom Client Engine — MVP Design

- **Date:** 2026-06-23
- **Status:** Approved (design); next step is an implementation plan
- **Component:** `runtime/client/` (the game client — TS / Pixi)
- **Related:** [`docs/north-star.md`](../../north-star.md) (Milestone 1, the living game),
  [platform architecture](2026-06-18-bloom-platform-architecture-design.md) (§5 the game client, §7 the mechanic abstraction)

---

## 1. Essence & placement

The client engine is a **node-graph runtime** that materializes a structured game
document into a live Pixi scene, and mutates that scene **incrementally** via a
message protocol — **no page refresh, and never a full document regenerate**.

The single load-bearing idea: **the serialized document and the live mutation
stream are the same vocabulary.** A document file is a *snapshot* of operations; a
live edit is *one more* operation. There is exactly one interpreter and one set of
operations; cold-load and live-edit run the identical pipeline. This is what makes
the top-priority requirement hold — **the AI never regenerates the whole document
to change one thing.**

**Placement: `runtime/client/`** (the Nx TS/Pixi project the platform architecture
already names). Consequences of that placement, which the design honors:

- The engine contains **zero AI** and is **studio-agnostic** — it speaks only the
  op protocol. It therefore satisfies the runtime plane's law (no AI, deterministic,
  untrusted) **by construction**.
- The studio **embeds** the engine (an allowed `studio/ → runtime/client` direction).
  The engine **must never import `studio/`** (the platform dependency rule).
- The **same bundle** runs embedded in the studio (driven by the authoring protocol)
  and standalone from a document file. "One engine, two drivers."
- The future **server-driven player mode** (send a bet, animate the server's
  authoritative outcome) is a *second driver* on this same core — **labeled, not
  built** this iteration.

---

## 2. Components

| Unit | Responsibility | Touches Pixi? |
|---|---|---|
| **GraphModel** (pure) | Holds `nodes` + `edges`; applies and validates ops; emits change records. Source of truth inside the engine. | No |
| **Reconciler** | Consumes change records → drives the renderer seam. Owns one-hop reactive push. | No |
| **`IRenderer`** (seam) | The **only** Pixi boundary: `mount`, `createObject(type)`, `setProp`, `setParent`, `destroy`, `loadTexture`. | interface |
| **PixiRenderer** | The single `IRenderer` implementation (Approach 3). | Yes |
| **Materializers** (per node type) | Map a node's props/edges → renderer calls. One small unit each: Root, Container, Sprite, Texture. | via seam |
| **ProtocolHost** | postMessage envelope: handshake, op/batch intake, ack/error/event out, origin validation. | No |

Everything from GraphModel → Reconciler → `IRenderer` is **unit-testable with a
mock renderer** — no WebGL context required. `PixiRenderer` is the lone unit that
needs a browser/WebGL and is covered by e2e.

### Pixi abstraction strategy (the "adapters over Pixi" decision)

**Approach 3 — thin, node-scoped adapters behind one small renderer seam.** Not a
thick facade that re-wraps all of Pixi (a maintenance tax and scope bomb), and not
inline Pixi calls smeared across op-handling (untestable without WebGL). Instead:

- the op pipeline + graph model are **pure and renderer-agnostic** (no Pixi import);
- one narrow `IRenderer` seam is the only place Pixi is touched;
- each node type has a small **materializer** mapping its props/edges → renderer calls.

This is the repo principle "**proven libraries behind thin seams**": Pixi is used
directly for what it is great at, but isolated behind a one-file boundary that keeps
the core testable and the renderer replaceable in principle — without reimplementing
Pixi.

---

## 3. The document schema

A node is one of four types; an edge is either a `child` (parenting) or a `data`
(resource/value flow) connection. IDs are **stable and semantic** so the AI can
address any node on any later turn without a lookup.

```jsonc
{
  "version": 1,
  "nodes": {
    "tex.oak":  { "type": "Texture",   "props": { "src": "asset:abc123" } },
    "root":     { "type": "Root",      "props": { "width": 1280, "height": 720 } },
    "reels":    { "type": "Container", "props": { "position": { "x": 100, "y": 80 } } },
    "sym.r2c1": { "type": "Sprite",    "props": { "anchor": { "x": 0.5, "y": 0.5 }, "zIndex": 1 } }
  },
  "edges": [
    { "id": "e1", "type": "child", "from": { "node": "root",  "port": "children" }, "to": { "node": "reels",   "port": "parent" } },
    { "id": "e2", "type": "child", "from": { "node": "reels", "port": "children" }, "to": { "node": "sym.r2c1", "port": "parent" } },
    { "id": "e3", "type": "data",  "from": { "node": "tex.oak", "port": "data" },   "to": { "node": "sym.r2c1", "port": "texture" } }
  ]
}
```

- **`child` edges** map onto Pixi's scene tree; transforms inherit parent→child
  (Pixi-native). **`data` edges** carry a resource/value into a target property.
- **Node props (MVP):**
  - **Root:** `width`, `height`, `background?`
  - **Container:** `position`, `scale`, `rotation`, `alpha`, `visible`
  - **Sprite:** `position`, `scale`, `rotation`, `alpha`, `anchor`, `visible`,
    `zIndex` (its `texture` arrives via a `data` edge, not a prop)
  - **Texture:** `src` — an **asset reference** (ID/URL) resolving against the
    existing ComfyUI Asset Board pipeline (references, not embedded blobs)

---

## 4. The operation vocabulary

One set of operations, three uses: **load**, **live-edit**, **persist**.

```
addNode(id, type, props?)
removeNode(id)
setProp(id, path, value)        // path supports nesting, e.g. "position.x"
connect(edgeId, type, from, to)
disconnect(edgeId)
applyBatch(ops[])               // atomic: all-or-nothing
```

- **Cold-load** = `applyBatch(<all ops>)` into an empty model.
- **Live edit** = a single op.
- Same validation and reconcile pipeline either way.

`applyBatch` is not extra capability beyond what cold-load already requires — it is
the same primitive, additionally exposed as one agent tool so multi-op edits (e.g.
"build a reel of 5 symbols") apply atomically.

---

## 5. The protocol (postMessage envelope, versioned)

```
parent → engine:  { v:1, kind:"init",  id, document? }     // boot, optional initial doc
                  { v:1, kind:"op",    id, op }
                  { v:1, kind:"batch", id, ops:[...] }
engine → parent:  { v:1, kind:"ready", protocolVersion }   // emitted when the engine has booted
                  { v:1, kind:"ack",   id }
                  { v:1, kind:"error", id, code, message }
                  { v:1, kind:"event", name, ... }          // selection/interaction — FUTURE
```

- **Handshake:** the engine posts `ready` once booted; the parent waits for `ready`
  before sending `init`/ops — no lost-message races.
- **Versioned** (`v`, `protocolVersion`) from day one, the same contract discipline
  the game-package format follows.
- **Origin-validated**; the iframe is sandboxed; messages from unexpected origins
  are ignored.
- **Reads are served studio-side** (see §6), so there is no query round-trip into
  the iframe on the hot path. An engine-side `query` op is a **labeled debug
  affordance**, not built now.

---

## 6. Ownership & end-to-end data flow

Ownership within the studio plane (refines "the studio owns the model, the engine is
a replica"):

- **Durable record:** the document persisted in **Mongo**, written via
  `studio/backend` — the artifact.
- **Live canonical writer:** **`studio/frontend`** — the single in-memory writer in
  a session. It applies every op, forwards it to the iframe, and persists through the
  backend.
- **Engine (iframe):** a **render-only replica**. In standalone mode (no studio) the
  engine loads a document directly and its internal model becomes primary — which is
  why the engine always carries a full model.
- **Agent reads:** the current document snapshot is provided to the agent as turn
  context — cheap, no iframe round-trip.

```
Live AI edit:
  agent tool (studio/backend, Python)
    → socket.io → studio/frontend     [apply to canonical model + persist to Mongo]
    → postMessage(op) → iframe engine  [validate → mutate model → reconcile Pixi → ack]

Standalone load:
  static page boots engine → init{document} → engine replays as one batch → scene appears
  (no studio, no backend, no AI)
```

---

## 7. Agent tools (on the existing agentic rail)

The op vocabulary is exposed as typed agent tools, exactly like the existing
`generate_asset` skill: `scene.add_node`, `scene.set_prop`, `scene.connect`,
`scene.disconnect`, `scene.remove_node`, and `scene.apply_batch` (atomic multi-op).
The agent's existing **arg-schema validation is the "fail loudly" guarantee**. The
agent already thinks in tool calls; each call becomes one op on the wire.

---

## 8. Reconcile & reactivity (one hop)

- `setProp Sprite#x.alpha = 0.5` → mutate model → set that one Pixi object's `alpha`.
- `connect data` (`Texture#oak.data → Sprite#s.texture`) → resolve the texture
  (async via `IRenderer.loadTexture`) → assign to that sprite.
- `setProp Texture#oak.src = <new asset>` → re-resolve → push to **every** sprite
  whose `texture` edge points at this node (one hop along edges).

**Immediate apply** (human/AI-paced edits can't visibly tear). **Deliberately not
built now:** a general computed/expression-node evaluator, per-frame graph
re-evaluation, dirty-flag scheduling. With no value/expression nodes in the MVP
catalog, one-hop push covers every edge; a real evaluation pass earns its keep only
when expression nodes arrive. Per-frame **coalescing** is labeled for "later, if a
burst ever causes jank."

---

## 9. Error handling

- Unknown node/edge/port, type mismatch, duplicate ID, or a cyclic `child` edge →
  the op is **rejected with `error{code}`** and the model is left **untouched**.
- `applyBatch` is **transactional**: validate all, then apply all, or apply none.
- Async texture-load failure → the sprite shows a placeholder; an `event` is
  surfaced; the model stays valid.
- The engine never half-applies an op, so the model cannot rot across many turns.

---

## 10. Testing strategy

Follows the repo: **TDD mandatory**; **e2e is the authoritative behavioral contract**;
browser e2e runs locally, not in CI.

- **Unit (TDD, no WebGL — the bulk):** GraphModel op application + validation +
  change records; Reconciler against a **mock `IRenderer`**; protocol envelope &
  handshake; `applyBatch` atomicity; one-hop reactive push.
- **e2e (Playwright, authoritative):** the real engine in a real iframe — boot →
  `ready`; send ops via `postMessage`; assert observable scene (sprite present /
  positioned / textured); live mutation with **no reload**; **standalone document
  load** builds the scene with no studio/backend.
- **Determinism:** the same document materializes to the same scene.

---

## 11. Scope boundary

**In this iteration:**
- Node types: **Root, Container, Sprite, Texture**.
- The **6 operations** and the **postMessage protocol + handshake**.
- The engine: **GraphModel → Reconciler → `IRenderer`/PixiRenderer**, with
  per-type materializers.
- **Agent tools** for the op vocabulary.
- **Mongo persistence** of the document via `studio/backend`.
- A **standalone load** entry that boots the engine from a document file.
- **Unit + e2e** coverage.

**Labeled, not built (named so a second case is purely additive):**
- Node types: Sound, Text, Animation/Tween, Spine/animated symbols, particles,
  value/expression nodes, layout nodes, slot-mechanic nodes.
- Per-frame coalescing & a general dataflow evaluation pass.
- Engine-side `query` protocol; interaction/selection `event`s.
- The **server-driven player mode** (the second driver of this same core).
- Rich asset-load states beyond placeholder-on-failure.

---

## 12. Open / deferred decisions

- Exact **asset-reference resolution** contract between a `Texture.src` and the
  Asset Board (ID scheme, CDN/URL shape) — resolved against the existing assets
  plugin during planning.
- The **standalone entry**'s concrete form (a route in `runtime/client` vs a small
  static host) — an implementation detail for the plan.
- Whether direct **user manipulation** in the preview (drag a sprite) is routed as
  ops this iteration or deferred — leaning deferred; all mutation is ops regardless.
