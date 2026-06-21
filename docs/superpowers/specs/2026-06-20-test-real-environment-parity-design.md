# Test/real environment parity — provider replay + honest mode design

- **Date:** 2026-06-20
- **Status:** Design approved (brainstorming complete). Ready for implementation planning.
- **Scope:** The two external-provider seams in `studio/backend` — the LLM seam
  (`app/providers.py`) and the ComfyUI seam (`app/assets/comfy.py`) — plus their
  configuration (`app/config.py`), the `/health` surface (`app/rest.py`), a small
  frontend mode indicator (`studio/frontend`), the serve preflight (`justfile` /
  a tiny script), and the Playwright e2e tiers (`studio/frontend/e2e`).
- **Parent context:** the chat design
  ([`2026-06-19-llm-chat-design.md`](./2026-06-19-llm-chat-design.md)) and the
  game-assets design ([`2026-06-20-game-assets-design.md`](./2026-06-20-game-assets-design.md)),
  which introduced the `Provider` Protocol + `Fake*` doubles this design replaces.
  Repo testing policy: [`AGENTS.md`](../../../AGENTS.md) (Playwright stays out of CI;
  e2e is the behavioural source of truth).

## 1. Summary

A live "serve it up" session handed a human the **fake** backend by accident: chat
replied `echo: <message>` and the asset board produced a 1×1 PNG. `/health` returned
`{"status":"ok"}` — identical for fake and real — so nothing flagged it, and the
session looked broken even though every feature works against real providers
(verified end-to-end: a real `PONG` reply over the live socket; a real **73,862-byte**
PNG from ComfyUI on the GPU).

The root cause is **divergence**: the test doubles (`echo:`, 1×1 PNG) behave nothing
like the real providers, and the active mode is **invisible and unguarded**. A green
test proves little when the double is degenerate, and a human can be dropped onto the
fake stack with no warning.

This design attacks divergence on both axes. It (1) replaces the degenerate fakes with
**recorded-real fixtures** so the non-live mode behaves like the live one, (2) makes the
active mode **honest and visible** end-to-end with a serve-time preflight, and (3) has the
**deterministic tests and the live smoke share the same user flows and assertions**, so
"which world am I in?" can never silently differ again.

## 2. Problem framing: test environment vs user environment

The two environments answer different questions and the incident lived entirely in the
second:

- **Test environment** — _do the integrations work?_ May legitimately use doubles for
  determinism/cost. Green means wiring + provider logic function.
- **User environment** — _is the live stack I just served actually real?_ This is what a
  human clicks on. It broke here, and **no test suite (fake or real) runs when a human
  launches the app to play** — so tests alone cannot defend it.

The guiding principle the user set: **maximise parity between the two; avoid large
divergences.** Everything below follows from that.

## 3. Decisions resolved in brainstorming

1. **The fix is parity, not "more tests."** The degenerate doubles and the invisible
   mode switch are the root cause; both are addressed directly.
2. **Replace fakes with recorded-real fixtures ("replay").** The non-live mode replays
   actual captured outputs from live OpenRouter / live ComfyUI, not fabricated stand-ins.
3. **Fixtures are regenerated from live providers on demand** (a `record` step), so they
   stay current real samples rather than drifting hand-written constants.
4. **One honest, visible mode switch.** `/health` reports per-provider mode; the app shows
   a mode badge; `serve` runs a preflight that refuses/warns before handing a human a
   non-live stack.
5. **Rename to reflect reality:** provider mode is `live` | `replay` (replacing the
   split `openrouter`/`real` vs `fake` vocabulary). One concept, two values, both seams.
6. **Tests and runtime share flows + fixtures.** The fast browser e2e runs against
   `replay` with **strict, realistic assertions** (reply is not an echo; image is
   real-sized). A thin `@live` smoke tier runs the _same_ flows against live providers
   on demand, catching real-world drift and refreshing fixtures.
7. **User-facing coverage = 2 happy-path + 1 error case**, browser-level, as a user:
   (a) chat produces a real reply, (b) assets produce a real image, (c) a provider
   failure surfaces a **visible** error rather than a frozen state.
8. **Stay proportionate.** Only the two existing provider seams are touched. Recording
   tooling is minimal. No broad live coverage in CI.

## 4. Architecture

### 4.1 The two seams (unchanged shape, new doubles)

Both seams already expose a `Protocol` (`LLMProvider.stream`, `ComfyProvider.generate`)
with a `build_provider(settings)` factory. That seam stays; only the non-live
implementation changes from a degenerate fake to a **replay** provider, and the factory
switches on a single unified mode.

```
LLMProvider   (Protocol)  ── LiveOpenRouterProvider   (was LangchainOpenRouterProvider)
                          └─ ReplayLLMProvider         (was FakeProvider / "echo:")
ComfyProvider (Protocol)  ── LiveComfyProvider         (was RealComfyProvider)
                          └─ ReplayComfyProvider        (was FakeComfyProvider / 1×1 PNG)
```

### 4.2 Mode & configuration

`config.py` collapses `llm_backend` / `comfy_backend` and their differing vocabularies
into one concept with two values:

```
provider_mode: "live" | "replay"     # default "live"
```

- A single knob keeps the two seams from diverging from each other (you cannot end up
  "live LLM + fake comfy" by accident, which is part of what made the incident confusing).
- Backwards compatibility: continue to read the old `LLM_BACKEND` / `COMFY_BACKEND`
  env vars during a deprecation window, mapping `fake → replay`, `openrouter|real → live`,
  and **warn** if they disagree. `.env.example` is updated to the new knob.
- The committed `.env` default and `.env.example` are **`live`** — the safe default for a
  human is the real stack.

### 4.3 Recorded-real fixtures ("cassettes")

The replay providers serve fixtures captured from the live providers:

- **LLM cassette:** a captured real streamed completion for a known prompt, stored as an
  ordered list of text chunks (so streaming shape/length match real), replayed with a
  small inter-chunk delay. Keyed by a normalised prompt with a default fallback cassette,
  so unknown prompts still yield a realistic (not empty, not `echo:`) reply.
- **Comfy cassette:** captured real progress events plus a real generated PNG at the
  requested dimensions, stored as a fixture (metadata JSON + image file). Replay emits the
  recorded progress ticks then the recorded image bytes.

Fixtures live under a versioned fixtures dir (e.g. `studio/backend/tests/fixtures/replay/`)
and are committed (the PNG is small — hundreds of KB). A **record step** regenerates them:

```
just record-fixtures      # runs the live providers once, writes/refreshes cassettes
```

Recording reuses the live providers behind the same Protocol, so a cassette is by
construction a faithful real sample. Where a proven record/replay library fits the
transport cleanly (the LLM seam is HTTP via langchain/httpx), prefer it over hand-rolling;
the ComfyUI seam (HTTP POST + WebSocket progress + image fetch) gets a minimal purpose-built
recorder behind the `ComfyProvider` Protocol. (Repo standard: reach for proven libraries,
keep them behind a thin swappable seam.)

### 4.4 Honest, visible mode (the user-environment guard)

- **`/health`** reports the active mode without leaking secrets:
  `{"status":"ok","providerMode":"live"}` (and, if the seams are ever split again,
  per-seam fields). No API key, no URLs.
- **In-app indicator:** a small, always-present badge in the studio chrome shows
  `LIVE` vs `REPLAY`, read from `/health` at boot. A human can never again mistake one
  for the other.
- **Serve preflight:** `serve` (and the documented "serve it up" path) runs a preflight
  that checks `/health` mode and **refuses or loudly warns** before handing a human a
  `replay` stack, and also detects a _stale/leftover_ backend on the port whose mode
  differs from what was requested. This is the specific guard that would have stopped the
  incident.

## 5. Testing strategy (parity in the tests, not just the data)

Two tiers exercising the **same user flows** through the **same UI**:

| Tier                        | Mode     | When                           | Cost          | Asserts                           |
| --------------------------- | -------- | ------------------------------ | ------------- | --------------------------------- |
| Deterministic e2e (default) | `replay` | local + (cheap enough to gate) | low, offline  | strict, realistic (recorded-real) |
| Live smoke `@live`          | `live`   | on demand only (never CI)      | GPU + API key | real output + refreshes fixtures  |

Because `replay` is recorded-real, the **default e2e can assert the realistic shape** the
old fakes prevented:

- **Chat is real:** send a constrained prompt; assert the streamed assistant reply is
  **not** an `echo:` and matches the cassette's realistic content; assert
  `data-status="complete"`.
- **Assets are real:** author + Generate; assert the displayed image's
  `naturalWidth`/`naturalHeight` **match the requested dimensions** (a 1×1 double fails
  this) and the fetched bytes exceed a real-image threshold.
- **Errors are visible:** drive a provider failure (invalid model id → real error path,
  no reconfig needed) and assert the UI shows a **visible error affordance** (stable
  `data-testid`, added if missing) rather than a frozen "generating" state.

The `@live` tier runs the identical specs against live providers (Playwright project
grep `@live`, excluded from the default run). New recipes:

```
just e2e            # default: replay-backed, deterministic
just e2e-live       # @live tier: live providers, on demand (needs key + ComfyUI up)
```

Per `AGENTS.md`, Playwright stays out of CI; the `replay` tier is CI-affordable if/when a
pipeline runs it, the `@live` tier never is.

## 6. Components & files (anticipated)

- `app/config.py` — `provider_mode`; legacy env mapping + disagreement warning.
- `app/providers.py` — `LiveOpenRouterProvider`, `ReplayLLMProvider`, factory on mode.
- `app/assets/comfy.py` — `LiveComfyProvider`, `ReplayComfyProvider`, factory on mode.
- `app/replay/` — cassette load/record helpers shared by both seams.
- `tests/fixtures/replay/` — committed LLM + Comfy cassettes.
- `app/rest.py` — `/health` reports `providerMode`.
- `studio/frontend` — boot reads `/health`; mode badge component.
- `justfile` — `record-fixtures`, `e2e`, `e2e-live`, and a `serve` preflight.
- `studio/frontend/e2e/` — flows shared by replay + `@live`; strict assertions; error testid.

## 7. Non-goals (recorded, not built)

- Broad live coverage in CI (GPU/cost/key) — `@live` stays on demand.
- Provider seams beyond LLM + ComfyUI.
- A full secrets-management overhaul — `/health` simply omits secrets.
- Multi-client/realtime re-coverage against live providers (already proven by the
  deterministic tier; provider-agnostic).

## 8. Risks & mitigations

- **Cassette drift** (provider changes shape) → the `@live` tier exercises live and the
  `record` step refreshes fixtures; drift surfaces as an `@live` failure, not a silent
  user-environment break.
- **Replay over-fitting** (tests pass only on the exact recorded prompt) → default
  fallback cassette + assertions on _shape/size/realness_, not exact bytes, where the
  output is nondeterministic.
- **Live-test flakiness** (nondeterministic real output) → constrained prompts + sentinel
  matching for LLM; dimension/byte assertions (not pixel content) for images; generous
  timeouts; unique room/game names per test.
- **Legacy env confusion** during the rename → read old vars with a deprecation warning;
  update `.env.example`; document the one-knob model.

## 9. Build order (for the implementation plan)

1. Unify config to `provider_mode` (+ legacy mapping/warning); update `.env(.example)`.
2. `/health` reports `providerMode`; frontend mode badge.
3. Serve preflight (refuse/warn on `replay`; detect leftover mismatched backend).
4. Replay providers + cassette load; rename live providers.
5. `record-fixtures` tooling; capture and commit initial cassettes.
6. Strict `replay`-backed e2e (chat real, asset real, error visible); add error `data-testid`.
7. `@live` tier (same specs, live mode) + `just e2e-live`.
8. Docs: AGENTS.md / READMEs describe the modes, the guard, and the two tiers.
