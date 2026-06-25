# Bloom — Chat-Driven Math Tuning (agent tools over the tuner) Design

- **Date:** 2026-06-25
- **Status:** Draft for review
- **Scope:** Let a designer **read the tuner setup, adjust GA knobs, run a real
  tune, and (human-gated) apply the tuned model — all from chat.** Four thin
  LangGraph agent tools plus one skill, layered over the already-merged
  tuner-studio backend (`TunerHub` / `TunerStore` / `SlotModelStore`). **No Rust,
  no frontend, no new Mongo collection.**
- **Reads first:**
  - the tuner-studio integration that this completes — PR #79 (`8d5cdf8`); its
    backend lives in `studio/backend/app/tuner/` and is the surface we adapt.
  - the simulator-studio design
    [`2026-06-24-simulator-studio-integration-design.md`](2026-06-24-simulator-studio-integration-design.md)
    (§2 intent-vs-realization-reconciled; §3.3 `derive_target`), since the tuner
    reuses the simulator's target derivation and `SlotModelStore`.
  - the math-tuner design [`2026-06-24-math-tuner-design.md`](2026-06-24-math-tuner-design.md)
    (the GA, determinism, and the "AI-designed, never AI-decided" invariant).
  - the agentic-skill-chat slice-3 design
    [`2026-06-22-agentic-skill-chat-slice-3-design.md`](2026-06-22-agentic-skill-chat-slice-3-design.md)
    for the LangGraph `interrupt()` human-approval pattern this reuses for Apply.

---

## 1. What this delivers (and what it deliberately does not)

The tuner-studio slice (PR #79) shipped the full machine: a persisted
`TuningParams` per game (`TunerStore`), a `TunerRunner` subprocess seam over the
`bloom-tuner` GA, a `TunerHub` that derives the target from GDD intent, runs the
GA to completion, streams convergence to the Tuner pane, and persists a
`TuneResult`; plus a human-gated REST `POST /tuner/apply` that writes the tuned
model back into `SlotModelStore`. It explicitly **deferred the agent tools** —
the chat way to drive all of that. This effort delivers exactly that deferred
slice, and nothing more.

**In scope — four LangGraph tools + one skill:**

1. **`read_tuner_setup`** _(read)_ — report the seed model shape, current GA
   params, the derived target bands (the same intent the simulator verifies), and
   the last verdict.
2. **`set_tuner_params`** _(write)_ — patch the GA knobs (population, seeds,
   candidate counts, weights, …). **Not** the design intent — that stays in the
   GDD.
3. **`tune_slot_model`** _(action)_ — run a real tune to completion and report the
   verdict (PASS / NEAR-MISS, measured metrics, missed bands) in chat. Progress
   still streams to the Tuner pane.
4. **`apply_tuned_model`** _(action, human-gated)_ — write the last tuned model
   back into `SlotModelStore`, behind a LangGraph `interrupt()` approval.

Plus a `skills/tune-math.md` skill that declares these four tools and guides the
agent through read → adjust → tune → report → (human-confirmed) apply.

**Out of scope (deferred, by decision):**

- **Changing design _intent_ from the tuner tools.** RTP / volatility /
  bonus-hit-rate targets live in the GDD `math-model` doc and already have a chat
  path (`set_gdd_fields` via the `design-game` skill). Duplicating that here would
  re-create two sources of truth for intent — the exact thing the simulator design
  forbids. The tuner tools change GA _knobs_ only.
- **Auto-apply.** Apply is always a human approval, never automatic — the
  "AI-designed, never AI-decided" invariant from the math-tuner design. The agent
  may _propose_ Apply; only a human confirms it.
- **New tuner mechanics / strategies / Rust changes.** This is a pure
  chat-adapter slice over the merged engine. No `bloom-tuner`, `TunerRunner`,
  `TunerHub`, or REST changes beyond what the tools call.
- **New frontend.** The Tuner pane already renders live convergence and the
  verdict; chat-triggered tunes light it up through the existing sockets. No pane
  changes.

---

## 2. Architecture: thin chat adapters over the merged hub

The merged backend already exposes everything we need; the tools are thin
adapters that call it and format human-readable strings. Confirmed signatures
(from `origin/main`):

```python
# app/tuner/store.py
TunerStore.get(game_id) -> TunerJobDoc | None
TunerStore.get_or_seed(game_id) -> TunerJobDoc           # default_tuning_params()
TunerStore.put(game_id, *, params: TuningParams|None) -> TunerJobDoc

# app/tuner/hub.py
TunerHub.request_tune(game_id) -> None
#   runs the real GA to COMPLETION, emits tuning_progress / tuning_complete /
#   tuning_failed to the game room, and persists the TuneResult via save_result.
#   Raises nothing on a TargetGap — it emits tuning_failed and returns.

# app/simulator/store.py
SlotModelStore.get_or_seed(game_id) -> SlotModelDoc      # .model, .params
SlotModelStore.put(game_id, *, model=None, params=None) -> SlotModelDoc

# app/simulator/targets.py
derive_target(math_model, params, num_bonuses) -> dict   # raises TargetGap
```

`request_tune` already does the heavy lifting AND streams to the pane. So
`tune_slot_model` is: `await tuner_hub.request_tune(game_id)` → re-read
`tuner_store.get(game_id).result` → format the verdict. The pane lights up for
free because `request_tune` emits the same socket events whether triggered by
REST or by chat.

### 2.1 The data flow

```
chat turn ──▶ tune_slot_model tool
                 │  await tuner_hub.request_tune(game_id)
                 │      ├─ derive_target(GDD intent, params)         (reused)
                 │      ├─ runner.run(...) → real GA to completion
                 │      ├─ emit tuning_progress/_complete ──▶ Tuner pane (live)
                 │      └─ tuner_store.save_result(result)
                 │  result = tuner_store.get(game_id).result
                 ▼  format PASS/NEAR-MISS + metrics + missed bands
            chat feed (verdict in prose)

chat turn ──▶ apply_tuned_model tool
                 │  tuned = tuner_store.get(game_id).result.tuned_model
                 │  interrupt({tool, label}) ── human approves? ──▶ no → no-op
                 │                                            └──▶ yes
                 │  sim_store.put(game_id, model=tuned)             (reused)
                 ▼
            chat feed ("applied" / "declined")
```

### 2.2 Why `request_tune` runs in-turn (and what that means)

`request_tune` is `await`ed inside the tool, so the chat turn blocks until the GA
finishes — exactly like `generate_asset` awaits `asset_hub.generate_and_wait`.
A tune is seconds to tens of seconds at default params; that is acceptable for a
chat action the user explicitly asked for, and the Tuner pane gives live feedback
during the wait. If a user wants a fast smoke tune, they can lower
`search_candidate_count` / `population` via `set_tuner_params` first.

`request_tune` does not return the result (it returns `None` and persists). The
tool re-reads `tuner_store.get(game_id).result` after the await — the freshly
saved result — rather than threading a return value through the hub. This keeps
the hub's REST contract untouched (no new return type) and is race-free because
`request_tune` persists before it returns.

---

## 3. The four tools

All live in `app/agent_tools.py` as `build_<name>_tool(ctx: ToolContext) ->
BaseTool`, returning `StructuredTool.from_function(coroutine=...)`, matching the
existing builders. They read three new `ToolContext` fields: `sim_store`,
`tuner_store`, `tuner_hub` (see §4).

### 3.1 `read_tuner_setup() -> str`

Reads and summarizes, never mutates:

- **Seed model shape** from `sim_store.get_or_seed(game_id).model` — reel count,
  rows, symbol count, paytable entry count, bonus count. (Not the full JSON — a
  shape summary the agent can reason about.)
- **GA params** from `tuner_store.get_or_seed(game_id).params` — population,
  generations, candidate counts, master seed, weights.
- **Derived target** via `derive_target(gdd_math_model, sim_doc.params,
num_bonuses)` — RTP target, volatility band, per-bonus hit-rate bands. On
  `TargetGap`, report the gap ("design intent incomplete: <message> — fill it via
  the GDD") instead of bands.
- **Last verdict** from `tuner_store.get(game_id).result` if present — status,
  measured RTP/volatility, and whether a tuned model is pending Apply.

Returns a compact human-readable block.

### 3.2 `set_tuner_params(...) -> str`

Signature — every field optional, snake_case scalar params (LangChain renders
these as the tool's JSON args):

```python
async def set_tuner_params(
    master_seed: int | None = None,
    population: int | None = None,
    max_generations: int | None = None,
    search_candidate_count: int | None = None,
    final_candidate_count: int | None = None,
    elitism: int | None = None,
    mutation_rate: float | None = None,
    crossover_rate: float | None = None,
    stagnation_window: int | None = None,
    weight_rtp: float | None = None,
    weight_volatility: float | None = None,
    weight_hit_rate: float | None = None,
) -> str
```

Loads current `params` via `tuner_store.get_or_seed`, overlays only the provided
fields (the three `weight_*` map onto the nested `TuneWeights`), validates by
constructing a `TuningParams`, and persists via `tuner_store.put(game_id,
params=...)`. Returns the effective params so the agent can confirm. **The GA
knobs only** — there is intentionally no RTP / volatility / bonus-rate intent
field here; that is the GDD's job.

### 3.3 `tune_slot_model() -> str`

No args. `await ctx.tuner_hub.request_tune(ctx.game_id)`, then read
`ctx.tuner_store.get(ctx.game_id).result` and format:

- **PASS** → "Tuned to PASS: RTP X, volatility Y, hit-rates … — say 'apply it' to
  write this model into the slot model."
- **NEAR-MISS** → name each missed band (`result.missed`: metric, measured,
  band_lo, band_hi) and suggest a remedy (raise candidate counts / generations,
  re-weight, or relax GDD intent).
- **error / TargetGap** → `request_tune` emitted `tuning_failed` and saved no
  result (or an error result); the tool reports the failure string and, for a
  missing-intent gap, tells the user to complete the GDD `math-model` first.

Because `request_tune` emits `tuning_progress` / `tuning_complete` to the game
room, the Tuner pane animates live during the awaited call with zero extra work.

### 3.4 `apply_tuned_model() -> str` (human-gated)

```python
async def apply_tuned_model() -> str:
    doc = await ctx.tuner_store.get(ctx.game_id)
    tuned = doc.result.tuned_model if (doc and doc.result) else None
    if not tuned:
        return "No tuned model to apply yet — run a tune first."
    label = "Apply the tuned model to the slot model? This overwrites the current realization."
    decision = interrupt({"tool": "apply_tuned_model", "args": {}, "label": label})
    if decision != "approve":
        return "Apply declined by the user; the slot model is unchanged."
    await ctx.sim_store.put(ctx.game_id, model=tuned)
    return "Applied the tuned model to the slot model. Re-curate to confirm."
```

This is the chat twin of `POST /tuner/apply` (same `sim_store.put(game_id,
model=tuned)`), gated by the slice-3 `interrupt()` pattern — identical in shape
to `delete_asset`. The studio surfaces the approval to the human; the GA's output
never lands in the realization without a person saying yes.

---

## 4. Wiring (the hot-collision edits)

Per the `avoid-merge-conflicts` lesson, these touch the two central registries
every feature edits — coordinate with any active chat session and land fast.

- **`ToolContext`** (`app/agent_tools.py`) gains three fields, default `None`:
  `sim_store`, `tuner_store`, `tuner_hub`.
- **`ToolFactory.__init__`** gains the same three keyword params and stores them;
  `build()` is unchanged (it already passes `ctx` to each builder). `_BUILDERS`
  gains four entries: `read_tuner_setup`, `set_tuner_params`, `tune_slot_model`,
  `apply_tuned_model`.
- **`RoomHub.__init__`** gains `sim_store` / `tuner_store` / `tuner_hub` kwargs
  (default `None`), stored as instance vars; `_run_skill`'s `ToolContext(...)`
  construction passes them through alongside the existing stores/hubs.
- **`main.py build()`** passes the already-constructed `sim_store`,
  `tuner_store`, `tuner_hub` into both `ToolFactory(...)` and `RoomHub(...)`.
  (All three objects already exist in `build()` — they are only newly _threaded_
  to the tool layer.)

No other production module changes.

### 4.1 The skill

New `skills/tune-math.md`, mirroring `manage-assets.md` / `design-game.md`:

```yaml
---
name: tune-math
description: Tune the slot model's math (reels + paytable + bonus) toward the
  game's design intent, then optionally apply the result. Applying is confirmed
  by a human.
args:
  - { name: focus, type: string, required: false, description: 'Optional nudge, e.g. "lower volatility" or "use a bigger population".' }
tools: [read_tuner_setup, set_tuner_params, tune_slot_model, apply_tuned_model]
---
```

Body guidance: call `read_tuner_setup` first to ground the run; if the user asked
for a knob change, `set_tuner_params`; run `tune_slot_model`; report the verdict
plainly; on PASS, offer to apply and only call `apply_tuned_model` when the user
agrees (a human still confirms). If the target derivation reports a gap, tell the
user to complete the GDD `math-model` via the design skill — do **not** invent
intent here.

`SkillRegistry` validates a skill's `tools:` against
`tool_factory.known_tool_names()`, so the four `_BUILDERS` keys must be in place
for the skill to load.

---

## 5. Error handling

- **No tuned model yet** → `apply_tuned_model` returns a friendly "run a tune
  first" (not an error).
- **Missing/incomplete GDD intent** (`TargetGap`) → `read_tuner_setup` and
  `tune_slot_model` surface the gap message and point at the GDD; tuning does not
  proceed against an undefined target.
- **NEAR-MISS** → first-class, informative result, not an error: the missed bands
  are named with measured-vs-band numbers and a concrete remedy.
- **Subprocess / runner failure** → `request_tune` emits `tuning_failed` and
  saves no pass result; the tool reports the failure string surfaced by the hub.
- **Invalid `set_tuner_params`** (e.g. a non-positive population) → constructing
  `TuningParams` raises; the tool returns the validation message without
  persisting a partial write.
- **Apply denied** → no-op; the slot model is unchanged and the tool says so.

---

## 6. Testing strategy

### 6.1 Backend (pytest, TDD, CI-affordable, authoritative for the tool contract)

In the `tests/test_agent_tools.py` style — build each tool via
`factory.build([name], ctx)` and `await tool.ainvoke({...})`:

- **`read_tuner_setup`** — against real Mongo `TunerStore` + `SlotModelStore`
  (seeded) and a stub GDD store: reports params, seed shape, derived bands; and
  the `TargetGap` path reports the gap.
- **`set_tuner_params`** — partial patch leaves untouched fields intact, persists,
  returns effective params; weights overlay the nested `TuneWeights`; invalid
  value → validation message, no write.
- **`tune_slot_model`** — `TunerHub` wired with a `FakeTunerRunner` (scripted
  progress + a PASS result, and a separate NEAR-MISS result): asserts the tool
  awaits the run, reads the saved result, and formats PASS / NEAR-MISS (with
  missed bands) / failure correctly.
- **`apply_tuned_model`** — `monkeypatch agent_tools.interrupt`: `"approve"`
  writes `tuned_model` into `SlotModelStore` (assert via `sim_store.get`),
  `"deny"` is a no-op; the no-result path returns "run a tune first."
- **Skill loads** — `SkillRegistry` accepts `tune-math.md` because the four tool
  names are now known (guards the wiring).

### 6.2 Playwright e2e (authoritative for client behavior)

One spec driving the full chat loop, against a **replay** chat backend + the
**real deterministic** tuner (the tuner needs no cassette — it is offline and
reproducible; only the chat LLM's tool-calling turn does):

1. Seed a game whose slot model is detuned (RTP off-target) with GDD intent set.
2. In chat, ask the agent to tune the math.
3. Assert the agent runs the tune and the **PASS verdict appears in the chat
   feed**, and that the Tuner pane reflects the completed run.
4. Tell the agent to apply; assert the **`interrupt()` approval** surfaces,
   approve it, and verify the write-back (the slot model now holds the tuned
   model — re-curate or read it back to confirm).

**Cost flagged:** this requires **recording one run cassette** for the agent's
tool-calling turn (a live provider session to capture it, then committed for
deterministic replay), following the agentic-skill-chat run-cassette convention
(prompt-keyed). This is the main added cost of the slice. Run locally via
`just e2e` (replay backend) per repo policy — not in CI.

---

## 7. Module-level change list

**Backend** (`studio/backend`):

- `app/agent_tools.py` — `ToolContext` += 3 fields; `ToolFactory.__init__` += 3
  params; `_BUILDERS` += 4 entries; 4 new `build_*_tool` functions.
- `app/room_hub.py` — `__init__` += 3 kwargs + instance vars; `_run_skill`
  `ToolContext(...)` threads them.
- `app/main.py` — pass `sim_store` / `tuner_store` / `tuner_hub` into
  `ToolFactory` and `RoomHub`.
- `skills/tune-math.md` — new skill (repo-root `skills/`).
- `tests/test_agent_tools.py` (or a focused `tests/test_tuner_tools.py`) — the
  unit/integration tests in §6.1.

**Frontend** (`studio/frontend`):

- `e2e/tuner-chat.spec.ts` — the §6.2 e2e + its recorded run cassette.

No Rust, no new collection, no pane changes.

---

## 8. Build order within this effort

1. **`ToolContext` + `ToolFactory` + `_BUILDERS` wiring and the 4 tool stubs**
   (TDD: the skill-loads test + read/set-params tests drive the shapes first).
2. **`read_tuner_setup` + `set_tuner_params`** — pure read/write over the stores,
   unit-first.
3. **`tune_slot_model`** — against a `FakeTunerRunner`-backed hub; PASS /
   NEAR-MISS / failure formatting.
4. **`apply_tuned_model`** — `interrupt()` approve/deny over `SlotModelStore`.
5. **`RoomHub` + `main.py` threading** — wire the context through end-to-end.
6. **`skills/tune-math.md`** — author + the skill-loads guard.
7. **e2e** (`tuner-chat.spec.ts`) + record the run cassette — the full chat loop.
