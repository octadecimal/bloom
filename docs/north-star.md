# Bloom — North Star

> The durable "why / who / what winning looks like" for the whole platform.
> Read this first for **intent**; drop into
> [`docs/superpowers/specs/2026-06-18-bloom-platform-architecture-design.md`](superpowers/specs/2026-06-18-bloom-platform-architecture-design.md)
> for **mechanics**. This doc changes rarely; when product intent and a feature
> spec disagree, this doc decides on intent and the spec decides on how.

---

## 1. What Bloom is

Bloom is an **AI-driven, human-in-the-loop platform for authoring real-money
generative-AI casino games** — slots first, built so new game families are
additive rather than rewrites. A person describes the game they want; the studio's
AI helps design it, generate its art, and tune its math; a human approves it; and
it ships as a certified game that real players can play for real money.

The hard, novel thing Bloom proves is not "AI makes games." It is that
**AI-authored games can still be certifiable**, because of a single rule (§6).

## 2. Who it's for

**Now: us.** Bloom is our own studio's tool — a small expert team uses it to
author a catalog of slots faster and cheaper than a traditional studio can, and
licenses those games to operators. The studio is a competitive weapon.

**Later: a product.** The authoring environment itself could be sold to other game
makers (multi-tenant SaaS / a game marketplace). That is the proven-later play.
**We do not build tenancy, billing, or marketplace machinery until it is real** —
same discipline the architecture already lives by ("labels, not machinery").

## 3. What you can do (the authoring journey)

From the user's seat, Bloom is a conversation that becomes a game:

1. **Describe it.** Say what you want in plain language ("a stormy Norse slot with
   expanding wilds").
2. **Watch it take shape.** The studio generates the game's design and its art and
   shows you a living game-in-progress.
3. **Keep shaping it by talking.** Continue the conversation to adjust anything —
   theme, symbols, layout, behavior. The game bends to the chat.
4. **Prove it's real.** Simulate it to confirm it hits real RTP / volatility /
   hit-rate targets — not a toy, a certifiable real-money game.
5. **Sign it off.** A human approves; the game is frozen into a signed, certified
   package.
6. **It goes live.** Players play the served game; every round is audited and
   replayable.

The magic moment is steps 2–3: **a game appears from a conversation and then bends
to it.**

## 4. Why it's valuable

In priority order — this is the order to pitch in, and it is deliberately _not_
the architecture spec's compliance-first order:

1. **Volume — a fresh-catalog firehose.** Operators are starved for new content.
   The win is output: a large, varied, constantly-fresh catalog at a pace human
   studios cannot match. **This is the product.**
2. **Cost / time collapse.** A slot normally takes a team months and six figures;
   Bloom does it in days with one person plus AI. This is the _engine_ that makes
   the firehose possible.
3. **AI-native novelty.** Games and variety that couldn't exist before — the
   differentiation that keeps the firehose from being generic.
4. **Compliance — the foundation, not the pitch.** The certifiable-AI architecture
   is what makes a generative-AI real-money firehose _legal at all_. It is table
   stakes. Nobody buys "we're compliant"; it is the ground the rest stands on.

## 5. Quality at volume

A firehose's mortal enemy is **slop**. Slots live or die on theme, feel, and
polish, and operators reject generic content — so quality cannot be hand-waved as
"the math is fine, the art is a swappable skin." It isn't.

The defense is a **funnel ending at a dual-purpose gate**:

- AI generates **many** candidates.
- **AI critic agents** (playtester / art-director / math-designer) score and cull
  the weak ones before a human sees them.
- The **human sign-off gate is both compliance _and_ taste** — the curation
  checkpoint where only the good few are approved.

Throughput × selectivity. The gate has been described as pure compliance; it is
also where quality is enforced.

## 6. The one rule that keeps it honest

**AI-designed, never AI-decided.**

Bloom runs on two planes with a shared certified core: AI lives entirely in the
**authoring** plane; the **runtime** plane that decides real-money outcomes has
zero AI and is fully audited; and the only thing that crosses between them is a
**signed package approved by a human**. No AI, no ML, no nondeterminism ever
touches a real-money outcome — AI only helps humans design games. That sentence is
the platform's entire regulatory posture; guard it ruthlessly.

Full mechanics (the seed-pool math, determinism contract, mechanic abstraction,
audit log) live in the
[architecture spec](superpowers/specs/2026-06-18-bloom-platform-architecture-design.md).

## 7. Near-term objective

**A demo compelling enough to create pull** — interest, funding, operator
attention. This is why the build has gone studio-first even though the
architecture's build order is foundation-up: **the studio is the part you can
show.** The runtime/trusted backbone is deferred-but-not-deprioritized plumbing,
built when there is a real game to serve.

The guiding rule for every session until the demo lands:

> **Favor visible, end-to-end-_feeling_ studio experience over invisible backbone
> completeness.**

**Milestone 1 — the living game.** From entered requirements, the studio produces
a game's design and ComfyUI-generated assets and shows it as a game-in-progress
that the user keeps shaping by talking to it. The wow is the conversation→game
loop.

**Milestone 2 — a real spin.** A player actually spins and wins, with the runtime
serving a real, audited outcome. This is when runtime work becomes necessary.

_(How the authored game is represented, compiled, rendered, and frozen is
implementation — it lives in feature specs, not here, and is still forming.)_

## 8. Where things stand

This section deliberately stays thin and points at living sources rather than
duplicating them (they go stale here instantly):

- **Built / in flight:** the studio authoring surface — the Dockview studio shell,
  agentic chat with git-backed skills, game-asset generation, and GDD generation.
- **Stubbed / deferred:** the runtime (game server, client), the simulator, the
  game-package format, and the math engine beyond its determinism slice.
- **Live detail lives in:** `docs/superpowers/specs/` (per-feature designs),
  `docs/superpowers/plans/` (implementation plans), each domain's `AGENTS.md`
  (the per-plane rules), and the project memory index.

## 9. Durable principles

The rules that should survive every session:

- **AI-designed, never AI-decided** — the law of §6.
- **Demo-pull over backbone-completeness** — until the demo lands (§7).
- **Volume is the product; compliance is the floor** — pitch in the order of §4.
- **Quality is curated, not assumed** — the funnel and the taste gate (§5).
- **Labels, not machinery** — name and place future seams; don't build the
  framework until the second case is real.
- **Determinism is sacred** — the math engine is bit-identical in simulator and
  server; that contract is never negotiable.
- **Proven libraries behind thin seams** — reach for mature libraries; keep them
  swappable.
