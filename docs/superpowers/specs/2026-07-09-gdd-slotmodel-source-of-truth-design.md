# GDD / SlotModel single source of truth — design

> One owner per field: the GDD holds design **intent** (targets, constraints,
> shape, identity), the SlotModel holds **realization** (the numbers the GA
> owns), and everything shared between them is either a live compile link or a
> read-only mirror — never a second editable copy.

- **Status:** approved design, not yet built
- **Delivery:** one spec (this doc), two sequenced implementation plans —
  Plan 1 "ownership rework" (Python/React), Plan 2 "constraint seam" (Rust +
  `derive_target`)
- **Prior art referenced throughout:** scene intent rebuild
  (`app/scene/layout/intent_rebuild.py`), section locks
  (`app/math/models.py:190`, `studio/tuner/src/genome.rs:91`), noise-aware
  verify (`studio/simulator/src/run.rs:19`), the dead realizer
  (`app/math/realize.py`).

## 1. Problem

The GDD and the SlotModel both describe the game's math, and nothing keeps
them honest with each other:

- The GDD's paytable `payouts`, `free_spins` config, `strip_length`,
  `payline_overrides`, `max_win`, `hit_frequency`, and `bet_range` are
  **recorded but never read** by any production path — design fiction with
  status badges.
- The SlotModel is **born from the frozen `video-5x3` template**
  (`app/math/store.py:99`), never from the design conversation; the compiler
  that could do it (`realize_slot_model`, `app/math/realize.py:295`) has zero
  callers outside tests.
- The only live GDD→model link is `derive_target`
  (`app/math/targets.py:63`), which reads `rtp` / `volatility` /
  `bonus_hit_rate` — and even it takes `num_bonuses` from the **model**
  (`app/math/hub.py:73`), not the GDD.
- Nothing flows model→GDD, and no code detects divergence. A user can say
  "make it 3 reels, wilds pay 500×", watch the GDD record it, and the game
  silently stays a 5×3 whose paytable the GA invented.

## 2. Doctrine

Every fact lives in exactly one store. Four classifications:

| Class          | Owner     | Behavior                                                                                                |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| **Target**     | GDD       | Compiled into `TargetSpec` bands; the tuner chases it; verify gates on it.                              |
| **Constraint** | GDD       | Compiled into `TargetSpec` invariants; enforced in GA `repair()` and asserted in verify.                |
| **Shape**      | GDD       | Realize-input. Edits trigger the (gated) re-realization, so shape fields stay true instead of drifting. |
| **Mirror**     | SlotModel | Rendered read-only in the GDD viewer at view time; never persisted into GDD `data`.                     |

## 3. Ownership map (schema changes)

| Aspect         | GDD keeps                                                                                                                                                                | Changes                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| theme          | everything (intent)                                                                                                                                                      | none                                                                                                                                        |
| math-model     | `rtp`, `volatility`, `bonus_hit_rate` (targets); `max_win`, `hit_frequency` (**promoted to real targets**, §6); `reels`, `rows`, `payline_mode`, `payline_count` (shape) | **evict** `payline_overrides` (line geometry = realization; deferred v2 constraint), **evict** `bet_range` (packaging concern → todo issue) |
| symbols-reels  | `symbols` table — slot / name / kind / art_desc (identity + birth roster, shape); `strip_length` (shape); `wild_behavior`, `scatter_behavior` narratives                 | `symbols` table gains machine-managed **`model_id`** column — the stable join key to `model.symbols[].id` (§5)                              |
| paytable       | `notes` narrative; **new `pay_constraints` table** — rows `(symbol, relation ∈ {top-paying, floor, ceiling}, count?, value)`                                             | **evict** `payouts`, `special_pays` → read-only **mirror** of `model.paytable`, rendered with symbol names via the join key                 |
| bonus-features | `features` table (presence/trigger intent — shape; its row count is `num_bonuses` for `derive_target`, replacing the model-side read); `bonus_buy`                       | **evict** `free_spins` table → mirror of `model.bonuses`                                                                                    |
| ui-ux, audio   | everything                                                                                                                                                               | none                                                                                                                                        |

Evicted fields disappear from `ASPECT_SCHEMAS` (`app/gdd/schemas.py`), so the
agent's `field_catalog()` and `set_gdd_fields` validation stop accepting them
with no router-prompt surgery.

## 4. Birth realization and the re-realize gate

**Birth.** When the GDD becomes _realizable_ — math-model shape fields
present and the symbols table non-empty — the model is compiled from the GDD
via `realize_slot_model`. `get_or_seed` keeps seeding the template only as
the fallback for GDD-less access (e.g. opening the scene before any design
chat). The model doc gains provenance: `origin: template | realized` and a
`touched` flag (set by manual `PUT /slot-model` or tuner apply).

**Gate.** A shape-field edit follows the scene-intent precedent
(`rebuild_after_intent`):

- Model **untouched** (pristine template, or realization never edited/tuned)
  → re-realize silently; a gate here is noise.
- Model **touched** → pause the run on the existing LangGraph `interrupt()`
  approval card, naming the affected sections. Approve → sectional
  re-realize. Deny → the GDD keeps the new value and the game is marked
  `shape_stale` (§5) until re-approved or reverted.
- Direct REST edits (`PUT /games/{id}/gdd/{aspect}`) get the same semantics
  without chat: untouched → silent; touched → a pending state surfaced in
  the GDD viewer with approve/revert affordances.

**Sectional and lock-respecting.** Re-realization regenerates only the model
sections a change implies (symbol roster → symbols + reel strips + affected
paytable rows; dims → reels/paylines; bonus presence → bonuses), merged into
the live model. `SectionLocks` are honored verbatim — a locked section is
never regenerated, the same contract the GA already obeys
(`genome.rs:91-167`).

**After any re-realize:** the math verdict is invalidated (`verdict_stale`,
§5) — the measured RTP no longer describes the current model.

## 5. Mirrors, staleness, join key

**Mirrors** render client-side in `GddViewerPane` from the live model (the
frontend already subscribes to `slot_model_changed`), labeled
"Realized — from the game model", symbol names resolved through the join
key. The stored GDD `body` markdown keeps only intent fields; mirrors are
view-time composition — no second persisted copy.

**Join key.** Birth realization assigns `model.symbols[].id` values and
writes each back into the GDD symbols table's `model_id` column.
`realize_symbol` (art) and the mirrors resolve through it. Sectional
re-realize preserves ids for surviving slots and assigns fresh ids for new
ones, so scene textures stay attached across roster edits.

**Staleness flags** on the model doc, each cleared by the action that
resolves it:

- `verdict_stale` — set by any re-realize, or by a target/constraint GDD
  edit after a verified tune; cleared by the next verify/tune. Math pane
  shows a **STALE** badge on the old verdict (same slot as the RUNNING
  badge) rather than hiding it.
- `shape_stale` — set when a gated re-realize is denied (GDD shape ≠
  model); cleared by approving or reverting. Surfaced on the affected GDD
  aspect and as a warning pill in Game Config's sync strip.

**`derive_target` changes:** `num_bonuses` from the GDD features table;
emits the two new bands and compiled `pay_constraints` (§6).

## 6. Constraint seam (Rust)

`TargetSpec` (`studio/simulator/src/target.rs:71`) gains:

- `hit_frequency_band: HitRateBand` — statistical; joins the verify gate
  (`run.rs:19`) and `fitness`/`band_misses` with a binomial SE, exactly the
  `bonus_hit_rate` pattern; `Weights` (`studio/tuner/src/config.rs:20`)
  gains a matching term. Already measured (`measure.rs:63`).
- `max_win_band: Option<Band>` — **static** invariant on the candidate's
  theoretical max win (top line pay × multiplier bounds). Observed max is a
  noisy tail statistic, so this is checked as deterministic pass/fail with
  no SE term.
- `pay_constraints: Vec<PayConstraint { symbol: u8, relation: TopPaying |
Floor | Ceiling, count: Option<u8>, value: u64 }>` — symbols referenced by
  model id (Python compiles GDD slots through the join key).

**Enforcement is repair, not rejection.** Every mutate/crossover already
funnels through the deterministic `repair()` clamp (`genome.rs:181-221`):
floors/ceilings become per-gene clamps layered onto `GeneBounds`;
`TopPaying` is a deterministic post-clamp fix-up (cap competitors at the
designated symbol's top pay, applied in fixed order — common-random-numbers
determinism preserved). Verify asserts the same invariants as hard
pass/fail, so a Verify-only run on a hand-edited model reports violations
too — constraints are properties of the game, not of tuning.

**Touch points** (all TargetSpec-reading sites): `target.rs`, `run.rs`,
`fitness.rs`, both duplicated `TargetJson` parsers (`tune_json.rs:22`,
`curate_json.rs:20`) and Python `targets.py`. The plan extracts the shared
JSON→`TargetSpec` mapping into the simulator crate rather than growing both
copies a third time.

**Up-front validation** (`studio/tuner/src/validate.rs`, plus
`validate_target` for curate): referenced symbol exists, floor ≤ ceiling,
at most one `TopPaying`, bands non-inverted.

## 7. Chat wiring

`field_catalog()` reflects the schema automatically. The design-router body
(`app/gdd/router.py:30`) gains one branch instruction: pay-relation intents
("wilds should pay the most") → `set_gdd_fields` on
`paytable.pay_constraints`; shape edits → expect the re-realize approval.
No new agent tools; `set_gdd_fields`, locks, and approval plumbing are
reused unchanged.

## 8. Testing

Per repo doctrine — TDD units beneath, exhaustive Playwright e2e as the
behavioral contract:

- **Rust:** unit tests per constraint relation in `repair()`/verify,
  determinism test (same seed + constraints → identical genome),
  `validate.rs` rejection cases, `band_misses`-vs-`verify` agreement
  extended to the new bands (the PR #156 pattern).
- **Python:** realize-at-birth; sectional re-realize with locks; join-key
  stability across roster edits; `derive_target` compilation (GDD-side
  `num_bonuses`, constraint compile, `TargetGap` on missing intent);
  `test_realize_parity.py` round-trip extended to the new TargetSpec JSON.
- **Playwright e2e:** chat sets shape → gate card → approve → Game Config
  reflects it → GDD mirror updates → verdict shows STALE → re-verify clears
  it; deny path leaves `shape_stale` visible. Replay cassettes per the
  established recipe.

## 9. Migration

Lazy, on first read per game: evicted keys stripped from GDD `data`
(unread fiction; nothing worth preserving); `model_id` back-filled for
template-born models by roster-order match where possible, else left
unlinked until the next realize. Existing models get
`origin: template, touched: true` (conservative — gates apply).

## 10. Phasing

- **Plan 1 — ownership rework:** schema eviction + `pay_constraints` field,
  birth/sectional re-realization + gate, join key, mirrors, staleness
  flags/badges, `num_bonuses` fix, migration. Lands standalone value.
- **Plan 2 — constraint seam:** TargetSpec extension, repair/verify
  enforcement, shared `TargetJson` extraction, `derive_target` compile of
  the new bands/constraints, router branch, e2e for constraint flows.

## 11. Deferred (tracked as `todo` issues)

- Feature-level bands (bonus RTP share, trigger-frequency attribution in
  the Rust profile).
- Line/shape constraints (payline geometry pinning, strip composition
  rules).
- `bet_range` → runtime packaging/presentation.
- Richer prose-constraint language beyond the typed `pay_constraints`
  table.
