# Journey Workbench — Design

> Status: **validated 2026-07-17.** Synthesized from a brainstorm session; parts
> lost to a disconnect were re-derived from the locked decisions and confirmed
> by the user.

## Problem

From a user's perspective, building and configuring a game today is
unsatisfying in four ways:

1. **No guided path** — the studio is a bag of panes; nothing walks you from
   blank page to certified game.
2. **Chat vs panes split** — the agentic chat and the pane-based editors feel
   like two disconnected worlds.
3. **Config is too raw** — game configuration reads as developer data
   (JSON-shaped editors), not game-design decisions.
4. **No living game center** — the game-in-progress isn't the visual anchor of
   the experience.

## Locked decisions (from brainstorm)

| Question                              | Decision                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Spine of the authoring experience     | **Hybrid: game + stages** — living game always center, stage rail around it, chat ever-present                          |
| Stage-rail strictness                 | **Free navigation + per-stage health** — no forced order; Certify is the only hard gate                                 |
| Fix for raw config                    | **Intent layer + raw beneath** — design-decision surfaces on top, raw editors reachable underneath                      |
| Stages vs existing Dockview workbench | **Stages = curated layouts** — clicking a stage applies a curated Dockview layout                                       |
| Chat companion activity               | **Stage-aware guide** — one continuous chat that knows the stage + health and proactively suggests the next best action |

## The shape: "Journey workbench"

### Section 1 — The stages

Six stages, mirroring north-star §3:

1. **Describe** — the blank-page moment: prompt + theme intent; produces/edits
   the GDD (intent layer = the editable GDD we already have; raw = GDD JSON).
2. **Art** — asset role coverage board + generation (intent = roles
   missing/covered per the quality-floor vocab; raw = asset board as-is).
3. **Scene** — composed living scene (intent = blueprint layout enums +
   rebuild_scene; raw = scene graph/inspector).
4. **Math** — targets first (RTP/vol/hit-rate band), tuner/simulator/analytics
   beneath (param sidebar + noise-aware verdicts already lead here).
5. **Certify** — the human taste+compliance gate: review summary of all health,
   build/sign the package. **Hard gate.**
6. **Play** — the runtime client playing the signed package.

The stage rail replaces the nav rail's grouping as the primary navigation;
clicking a stage applies its curated layout. Every layout includes the game
preview pane and chat.

### Section 2 — Health model

One per-game journey status aggregate the backend already mostly knows: GDD
exists/stale (watermark sync exists), asset role coverage (critic/floor data
exists), scene composed + critic pass, math verified (noise-aware verdict
exists), package built/signed. Exposed on one endpoint, rendered as per-stage
badges on the rail, and fed to the agent as context so chat can say "Math is
unverified — run a tune?". No new state machines — it's a read-model over what
stores already record.

### Section 3 — Build order (each its own spec→plan→PR cycle)

- **J1: Journey shell** — stage rail + curated layouts + always-on
  preview/chat + health read-model & badges. This alone fixes "no guided path"
  and "no living game center".
- **J2: Stage-aware chat guide** — health context into the agent +
  next-best-action behavior. Fixes "chat vs panes are two disconnected worlds"
  — the chat becomes the guide that walks you down the rail.
- **J3: Intent-first stage surfaces** — the intent layer over
  each stage's raw editors, worst-gap first. Describe and Math are already
  mostly there (editable GDD; targets-first param sidebar), so this is mainly
  **Art** (role-coverage board over the raw asset board) and **Scene**
  (blueprint-enum intent over the scene graph — dovetails with the Scene
  Blueprint A-roadmap, PR #128).
- **J4: Certify + Play** — the review-summary gate (all
  health rolled up, human taste+compliance sign-off per north-star §5),
  build/sign the package, and the Play stage serving it through the runtime
  client. Leans on runtime-server SP1 (#126) already merged; studio-side
  wrapper, not new runtime work.

Ordering rationale: J1/J2 are the demo-pull wins (visible
journey, guided conversation — Milestone 1 energy); J3 deepens each stage
without blocking the others; J4 lands last because it's the only piece needing
the authoring→runtime handoff hardened, and Certify being the sole hard gate
means nothing upstream waits on it.
