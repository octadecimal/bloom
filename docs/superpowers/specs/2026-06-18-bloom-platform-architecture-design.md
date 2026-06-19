# Bloom — Platform Architecture (Umbrella Design)

- **Date:** 2026-06-18
- **Status:** Approved (architecture); decomposes into per-component sub-specs
- **Scope of this doc:** the *umbrella* architecture for the whole platform. It is
  intentionally too large for a single implementation plan. Each component gets its
  own spec → plan → build cycle (see §16). This round's concrete deliverable is in §15.

---

## 1. What Bloom is

**Bloom** is an AI-driven, human-in-the-loop platform for **designing and running
real-money generative-AI casino games**. A designer works in an authoring studio where
AI agents help create a game (theme, art, symbols, math); the platform simulates and
curates the game's math, freezes it into a signed artifact, and a separate, AI-free
runtime serves authoritative outcomes to players.

Bloom is **not** a casino operator. It produces games and authoritative game outcomes
and **integrates into existing operator platforms** that already own players, wallets,
money movement, and KYC/AML (see §11).

The first game family is **slots**; the architecture is built so additional game
families are additive, not rewrites (see §7).

---

## 2. Glossary (locked vocabulary)

| Term | What it is | Path |
|---|---|---|
| **Bloom** | the platform | the repo |
| **the studio** | authoring environment: designer UI + AI orchestration + simulator | `studio/` |
| **the math engine** | certified kernel — deterministically turns a *seed* into one round's outcome; holds the mechanics | `trusted/math/` |
| **a game package** | the signed, frozen artifact; the versioned public contract between studio and runtime | `trusted/package/` |
| **the game server** | authoritative runtime — loads a package, draws a seed, evaluates via the math engine, writes the audit log | `runtime/server/` |
| **the game client** | browser renderer — plays back the outcome the server dictates | `runtime/client/` |
| **simulator** | the studio's tool that plays millions of rounds and curates the winning seed set, then builds a package | `studio/simulator/` |
| **seeds** | the curated PRNG seeds; each maps to one predetermined outcome | data |
| **mechanic** | the logic for one game family — `(math_model, seed) → outcome` (slots = mechanic #1) | inside the math engine |

---

## 3. The central law: two planes + a trusted core

Bloom has **two planes**, and **AI lives in exactly one of them**, plus a **trusted core**
shared by both:

- **`studio/` (the authoring plane):** designer UI + AI orchestration + simulator.
  AI-driven, human-in-the-loop, fast-churning, **not certified**.
- **`runtime/` (the authoritative plane):** game server + game client.
  Deterministic, **zero AI**, authoritative, audited.
- **`trusted/` (the shared certified heart):** the math engine + the game-package format.
  Bit-reproducible, audited, and depended on by *both* planes.

> **The only thing that crosses `studio/` → `runtime/` is a signed game package,
> and it crosses through a human sign-off gate.**

**Compliance story (the reason the law matters):** *No LLM, no ML, no nondeterminism
ever touches a real-money outcome. AI only helps humans design games; everything it
produces is frozen into a signed package and human-approved before it can decide a
single round.* Guard this sentence ruthlessly — it is the platform's regulatory posture.

**Dependency rule (lintable):** everything may depend on `trusted/`; **nothing may
depend on `studio/`.**

---

## 4. The math model (predetermined seed pool)

1. The **simulator** runs a PRNG over **millions of simulated rounds**. Each seed
   deterministically expands (via the **math engine**) into one round's outcome.
2. It measures the aggregate math characteristics — **RTP, volatility, bonus hit rate**, etc.
3. It **curates**: keeps the seeds whose collective distribution hits the targets,
   discards the rest. The surviving seeds *are* the game.
4. The curated seeds are frozen into a **game package**.
5. At runtime, the **game server** draws a seed from the package **uniformly at random,
   with replacement** (a pool, not a depleting deck), and expands it via the **same**
   math engine into the served outcome.

**Consequences:**

- **The runtime RNG's only job is to pick an index** in `[0, pool_size)`. *All* of the
  game's probability lives in the **composition of the pool** — a common outcome is
  represented by many seeds, a jackpot by few. Uniform draw + multiplicity = the entire
  distribution. The pool is a **flat list**, drawn uniformly, with **no per-seed weights**
  (hidden weights would be a certification headache).
- **Pool size is a real design parameter**, not a detail. Draw-with-replacement means
  seeds recur; the pool must be large enough that recurrence is rare and unpredictable.
- **The determinism contract is sacred.** Seed-expansion must be **bit-identical** in the
  simulator and the server — it is **the same compiled math engine** in both. If they
  diverged by one bit, the curated RTP would be measured against behavior the runtime
  doesn't reproduce, and the certified RTP would be a lie.

---

## 5. Components

### the studio — `studio/` (authoring plane)

A three-language product (the job needs all three):

- **`studio/frontend/` — designer UI (React / TS).** What the designer interacts with.
- **`studio/backend/` — AI orchestration (Python / FastAPI + Langchain).** Runs the AI
  authoring agents (theme, art via the ComfyUI pipeline, symbols, math intent), and
  orchestrates the simulator. **All AI lives here and only here.**
- **`studio/simulator/` — sims + curation (Rust).** Plays millions of rounds via the math
  engine, curates the seed set to hit targets, and **builds + signs the game package**.
  - *Does not:* run real-money play; its sims are advisory until frozen + approved.
  - *In → out:* designer intent + AI assistance → a signed game package.

### the math engine — `trusted/math/` (Rust)

- **Essence:** the pure, deterministic, certified kernel. A library, not a service.
- **Does:** holds the certified **mechanics** (slots = #1) and the deterministic
  evaluation `(math_model, seed) → outcome`. Bit-reproducible. Consumed by **both** the
  simulator (curation) and the server (live evaluation) — *the identical compiled logic*.
- **Does not:** generate its own randomness (the index is supplied); touch wallets,
  sessions, persistence, or network; contain game-specific data; contain any AI.

### a game package — `trusted/package/` (Rust, + generated TS types)

- **Essence:** the signed, frozen artifact — the only thing crossing the gate. See §8.
- **Does:** carry the curated seeds, the mechanic-specific math payload, a presentation
  manifest (asset *references*, not blobs), the mechanic + version it targets, and
  certification/provenance + a signature. Immutable once signed.
- **Does not:** contain logic (it is data), contain AI, or be editable in the runtime plane.

### the game server — `runtime/server/` (Rust / axum)

- **Essence:** the authoritative, real-money runtime. The source of truth.
- **Does:** load + verify a package; per bet, draw a seed (pick an index), expand it via
  the math engine, write the **append-only audit record**, return the authoritative
  outcome. Exposes an **operator-integration edge** (REST/WS) — see §11.
- **Does not:** author or modify math; render anything; run any AI; introduce any
  nondeterminism beyond the certified index draw. The client can never override it.

### the game client — `runtime/client/` (TS / Pixi)

- **Essence:** the player's browser game — a beautiful playback surface.
- **Does:** load presentation data from the package, connect to the server, send the bet,
  and animate to *exactly* the outcome the server returns.
- **Does not:** decide outcomes, compute wins authoritatively, or hold the real math. It
  is **untrusted**; the server is authoritative. Anything it computes is cosmetic.

---

## 6. Data flow / lifecycle

```
designer + AI agents  (studio/frontend + studio/backend)
        │  design intent
        ▼
   simulator  ──uses──►  the math engine            (studio/simulator → trusted/math)
        │  sims millions of rounds, curates seeds
        ▼
   builds + signs a game package                    (trusted/package)
        │
        ▼
   ◇ HUMAN SIGN-OFF GATE ◇   (the only crossing from studio → runtime)
        │  signed, frozen package
        ▼
   the game server  ──uses──►  the math engine        (runtime/server → trusted/math)
        │  load+verify package, draw seed, expand, AUDIT
        ▼
   the game client  renders the dictated outcome     (runtime/client)
```

---

## 7. The mechanic abstraction (shaping choice — build slots only)

A **mechanic** is the logic for one game family: `(math_model, seed) → outcome`.
"Mechanic" is a parameter that threads through **four** places:

- **the math engine** — a registry of mechanics. **Mechanics are append-only and immutable
  once shipped**; an old package must keep playing identically for years. New behavior =
  a new mechanic *version*, never an edit. (Changing a mechanic = a re-certification event.)
- **the game package** — a **common envelope** (id, version, mechanic ref, seeds, signature,
  presentation) **+ a mechanic-specific math payload**.
- **the server → client outcome contract** — a **tagged union keyed by mechanic** (a slot
  outcome and a roulette outcome are different shapes).
- **the game client** — a **renderer registry** (a host + per-mechanic render modules).

**We build only slots (mechanic #1).** The registry has one entry; the outcome type has
one variant; the `match` on mechanic has one arm. The rule is **labels and placement, not
machinery**: we name and locate the slot-specific parts so a second mechanic is *additive*,
and we build **no** plugin system, loader, or abstract framework until a second mechanic
is real.

> **The test for any "future-proofing":** does it cost real work/complexity now, or is it
> just deciding where a thing lives and labeling it? Labels → do it. Machinery → wait.

---

## 8. The game package as a versioned public contract

The package is the single most important interface in Bloom because it is load-bearing in
**three** roles at once:

1. the **studio ↔ runtime** boundary,
2. the **licensing contract** — `trusted/` + `runtime/` can be licensed without `studio/`,
   and a licensee feeds the server *their* packages,
3. the **certification artifact**.

Therefore the package format gets **explicit versioning + a back-compat policy from v1**,
and is documented as a public schema. Game variants (e.g. 94% vs 96% RTP) are **sibling
packages**, each one certified configuration — not modes inside one package (keeps the
certification boundary clean).

Presentation is carried as **asset references** (IDs / CDN URLs), never embedded blobs, so
the media pipeline (and ComfyUI) can evolve independently and packages stay small.

---

## 9. Determinism, audit & the sign-off gate

- **Determinism contract:** the math engine is bit-identical in the simulator and the
  server (same compiled crate). Non-negotiable (see §4).
- **Audit log:** an **append-only event stream**, not just a table. Each round records
  `(package id + version, seed drawn, math-engine version, bet, timestamp, outcome)` so any
  historical round is **bit-reproducible**. One stream feeds three needs: **disputes,
  certification, and analytics**. (Event-sourcing is brutal to retrofit and trivial to start.)
- **The sign-off gate** is a real component, not a file copy: a **human approval** plus
  **signing + provenance** (sim reports, achieved RTP/volatility, who approved, when, the
  mechanic + version). This metadata is the seed of future compliance tooling.

---

## 10. Outcome principle: "what happened" vs "what it paid"

The seed determines the **symbolic outcome** ("three 7s on the line") — fixed forever.
**Monetary translation and shared state** ("three 7s = 50× bet"; "+ the current progressive
pool of $4,210") is a **separate, recorded layer** applied on top. Keep them as two facts,
never fused into one value. Today we only pay the base amount — but this seam is what lets
progressives, externally-funded bonuses, and operator multipliers bolt on later without
violating the determinism law.

---

## 11. Boundaries (what Bloom does and does not own)

- **Bloom owns:** game design, authoritative game outcomes, the audit log.
- **The operator platform owns:** the player, the wallet, money movement, KYC/AML.
- The server's edge is an **operator-integration adapter** (REST/WS): it receives a driven
  request (session token + bet) and returns an **authoritative outcome + audit record**.
- **Out of scope for Bloom:** banking, payments/settlement, KYC/AML, player & operator
  accounts. We design the server's edge to integrate cleanly, and we build the audit log
  (core to the engine's authority), but nothing else of the money/identity layer.

---

## 12. Languages & repo topology

**Rust does all the deterministic math · Python does the AI · TypeScript does the screens.**

```
bloom/                                  # the platform
├─ CLAUDE.md · AGENTS.md · README.md · justfile · .gitignore
├─ Cargo.toml                           # Rust workspace → trusted/math, trusted/package,
│                                       #   studio/simulator, runtime/server
├─ package.json · nx.json · tsconfig.base.json   # Nx, scoped to the TS projects only
│
├─ studio/                              # ══ where you build (AI plane) ══
│  ├─ AGENTS.md                         #   "AI lives here. Not certified. May depend on trusted/."
│  ├─ frontend/   (project.json)        #   designer UI        — React/TS (Nx)
│  ├─ backend/    (pyproject.toml)      #   AI orchestration   — Python (uv)
│  └─ simulator/  (Cargo.toml)          #   sims + curates seeds, builds packages — Rust
│
├─ trusted/                             # ══ the certified shared heart ══
│  ├─ AGENTS.md                         #   "Certified-grade. Determinism sacred. Mechanics
│  │                                    #    append-only & immutable once shipped. No AI edits."
│  ├─ math/       (Cargo.toml)          #   seed → outcome kernel — Rust  (mechanics/slots.rs)
│  └─ package/    (Cargo.toml)          #   game-package: build/sign/verify — Rust (+ bindings/ts/)
│
├─ runtime/                             # ══ where it runs (no AI, ever) ══
│  ├─ AGENTS.md                         #   "No AI. Authoritative. Operator-integration edge.
│  │                                    #    Append-only, replayable audit log."
│  ├─ server/     (Cargo.toml)          #   load package, draw seed, eval, audit — Rust (axum)
│  └─ client/     (project.json)        #   renderer registry (slots = 1 entry) — TS/Pixi (Nx)
│
├─ tools/comfyui/                       # existing asset-gen pipeline (moved from repo root)
└─ docs/superpowers/specs/
```

The Rust workspace spans all three domains (Cargo doesn't care about folders — product/plane
organization wins at the directory level). Nx only knows the two TS projects.

---

## 13. Tooling

- **Cargo workspace** owns all Rust (math, package, simulator, server) — already a caching
  workspace.
- **uv** owns Python (studio backend).
- **Nx** owns **the TS layer only** (studio frontend, client, generated package types) — where
  it is genuinely best-in-class (caching, generators). **Nx does not wrap uv or Cargo.**
- **`justfile`** provides the cross-cutting commands (`just build` / `test` / `ci`) that call
  cargo + uv + nx in order.
- **Generated TS types** from the `package` crate are an **always-run** step, so a package
  format change that would break the client fails the build immediately. This guards the one
  cross-language seam (`package` → `client`) without full polyglot Nx.

**Revisit Nx-as-orchestrator only** if the TS surface grows large, Nx Cloud is adopted, or
cross-language `affected` becomes a *measured* CI bottleneck.

---

## 14. Metadata strategy (how the law is enforced, not just documented)

A **per-domain `AGENTS.md`** encodes each plane's rules so any agent dropped into that
directory is bound by them before touching anything:

- **`studio/AGENTS.md`** — AI lives here; not certified; may depend on `trusted/`.
- **`trusted/AGENTS.md`** — certified-grade; determinism is sacred; mechanics are append-only
  and immutable once shipped; no AI/automated free-editing; a change is a re-certification event.
- **`runtime/AGENTS.md`** — no AI, ever; authoritative; the audit log is append-only and every
  round must stay replayable; this is the operator-integration edge.

This is how AI is kept out of the certified/authoritative zones **by construction**.

---

## 15. Scope of this round (the first deliverable)

1. **This umbrella spec.**
2. **The Bloom monorepo scaffold** — the tree in §12 with all components stubbed and the
   three toolchains wired (Cargo workspace, uv, Nx-for-TS, justfile).
3. **Per-domain `AGENTS.md`** files (§14).
4. **The vertical slice** that proves the hardest contract — determinism:
   - the **math engine** expands a **trivial slot seed** into a symbol grid, and
   - a **bit-reproducibility test** passes (the same seed always yields the same grid).

Everything else is deferred to the per-component sub-specs.

---

## 16. Decomposition into sub-projects (build order)

Foundation-up; each gets its own spec → plan → build:

1. **the math engine** (`trusted/math`) — kernel + slot mechanic + determinism tests *(the vertical slice starts here)*
2. **the game package** (`trusted/package`) — format, build, sign, verify, TS type generation
3. **the game server** (`runtime/server`) — load/verify, draw, evaluate, audit, operator edge
4. **the studio** (`studio/simulator`, then `backend`, then `frontend`) — curation, AI orchestration, designer UI
5. **the game client** (`runtime/client`) — renderer host + slot renderer

---

## 17. Future directions & non-goals

**The architecture accommodates these; we build none of them now** (write them down so no one
designs against them):

- **More game types** via new mechanics (roulette, scratch/instant-win, crash, wheel, bingo).
- **Decision games** (blackjack, video poker) — a future *mechanic class*: the seed encodes the
  shuffle/card-sequence and curation assumes an optimal-strategy EV. Fits the model; needs its
  own math treatment.
- **Progressives / shared jackpots** — a runtime shared-state component + the two-layer outcome
  (§10); audit records the pool snapshot at win time.
- **Multiplayer / shared-outcome games** — a future *round topology* (one draw, many participants);
  keep the round/draw concept separable from the bet. WS transport already allows it.
- **Jurisdiction & RTP variants** — sibling packages (§8); jurisdiction compliance config lives at
  the server's operator edge, not in the package.
- **Provably-fair / commit-reveal** (crypto markets) — a future *draw-strategy* behind an interface;
  do not hardcode the single CSPRNG-index-draw assumption.
- **Studio as multi-tenant SaaS / marketplace** — packages trade freely (signed, attributable);
  **mechanics cannot** (they live inside the certified core, so third-party mechanics mean entering
  the cert boundary). A game marketplace is light; a mechanic marketplace is fundamentally heavy.
- **Compliance tooling** grown from the sign-off gate's provenance metadata.
- **Analytics & responsible-gaming** pipelines consuming the audit stream (decoupled; emit events,
  don't read the server's DB).
- **Richer authoring AI & media pipeline** (math-designer/art-director/playtester agents; animation,
  audio, 3D, localization).

**Explicit non-goals now:** banking/payments/KYC/accounts (operator's, §11); any AI in `runtime/`
or `trusted/`; more than one mechanic (slots only).

---

## 18. Open / deferred decisions

- Package **wire format** (likely a signed container; Rust-canonical) and **signing scheme**.
- Server **persistence** for the audit stream (durable, append-only).
- The **index-draw RNG algorithm** (a certification-appropriate CSPRNG).
- **Pool-size** targets (recurrence/unpredictability vs. package size).
- **ComfyUI integration** details (the studio backend as the caller; assets by reference).

These are resolved within the relevant component's sub-spec, not here.
