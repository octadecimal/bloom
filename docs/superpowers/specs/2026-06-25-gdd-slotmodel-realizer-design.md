# GDD→SlotModel realizer (SP2)

**Status:** Design — approved, pending implementation plan
**Date:** 2026-06-25
**Branch:** `feat/gdd-realizer`

## 1. Context — where this sits

Bloom's pipeline is **design intent (the GDD "spec") → executable slot math (the
realization) → reconciliation (simulate/tune/verify)**. SP1
([`2026-06-25-gdd-structured-math-structure-design.md`](2026-06-25-gdd-structured-math-structure-design.md))
made the structural identity of the math **addressable as typed GDD fields**
(payline topology, the symbol `kind` enum, a `strip_length` range). SP1 shipped no
realizer: structural intent now _lands_ in a typed field but still does not reach the
math.

SP2 builds the missing arrow — the **GDD→SlotModel realizer**: a pure, deterministic
compiler from the structured GDD to a structurally-valid (numerically rough)
`SlotModel`. It is the structural complement of the one GDD→math bridge that already
exists, `derive_target()` (`studio/backend/app/simulator/targets.py`), which reads
`rtp`/`volatility`/`bonus_hit_rate` and emits a `TargetSpec` for the verify side. The
realizer emits the **build** side.

```
                 ┌─────────────────────────────────────────────┐
   GDD intent ───┤ derive_target() ─► TargetSpec  (verify side) │  ✅ exists (SP0)
   (the "spec")  │ realize_slot_model() ─► SlotModel (build side)│  ◀── SP2 builds this
                 └─────────────────────────────────────────────┘
   realized SlotModel ─► tuner mutates the numbers ─► reconcile vs TargetSpec   (SP3)
```

**Division of labor (locked in SP1, unchanged here):** the **GDD owns identity** (reel
count, rows, strip-length guardrail, payline topology, symbol set + roles); the
**tuner owns the counts** (per-reel symbol distribution, payouts). So the realizer's
job is to emit a model that is _structurally_ correct and _numerically_ a placeholder
the tuner will reconcile. Strip length is the one identity field that becomes a
tunable range later (SP3); SP2 seeds a single concrete length within the guardrail.

## 2. Scope and boundary

**In scope:** one pure module, `studio/backend/app/simulator/realize.py`, plus its
unit tests (golden-vector + diagnostics) and one parity-oracle test that runs a
realized model through the real simulator binary.

**Out of scope (explicit handoff to SP3):** any REST endpoint, chat tool, UI
"Realize" action, auto-realize trigger, human-gated apply write-back, and **any
Rust/tuner change** (the `genome.rs` per-reel strip-length gene and `repair` rework).
SP2 changes no Rust and wires into nothing — it is a library function with tests,
mirroring how SP1 stayed pure-backend.

**Language decision:** **pure Python**, co-located with the GDD layer it reads and
beside its sibling `targets.py`. Rationale: the realizer is a **design-time, one-shot
compile** (a handful of reels/symbols/paylines), _not_ on any server-runtime hot path
— the performance-critical spin/simulate/tune loop is already Rust (`eval.rs`, the
simulator + tuner binaries) and is untouched by SP2. With performance irrelevant, the
deciding axis is cleanliness/extensibility, and the realizer's reason to exist is to
**grow as the GDD gains structured fields** — cleanest where the GDD lives (Python),
with no FFI/JSON-contract ceremony. A Rust realizer would be architecturally remote
from its Python inputs and would force every future GDD-field addition across the
language boundary. The only thing a Rust core buys — self-validating construction — is
obtained instead via the **parity-oracle test** (§7), which uses the real kernel as
the validity oracle.

## 3. The SlotModel target shape

The realizer emits a `dict` matching the Rust `SlotModel` serde shape
(`trusted/math/src/mechanics/slots/model.rs`):

```rust
pub struct SlotModel {
    pub symbols: Vec<SymbolDef>,     // SymbolDef { id: u8, role: SymbolRole }
    pub reels:   Vec<Vec<Symbol>>,   // one strip per reel; .len() IS the strip length
    pub rows:    usize,              // visible rows in the window
    pub paylines: Vec<Vec<usize>>,   // row index per reel; each line's len == reel count
    pub paytable: Paytable,          // { entries: [ { symbol, count, payout } ] }
    pub bonuses: Vec<BonusFeature>,  // FreeSpins { trigger:{symbol,min_count}, config:{...} }
}
// SymbolRole = Normal | Wild | Scatter         (Symbol = u8 id; art/name live elsewhere)
```

**The exact serde field/enum spelling is authoritative from the Rust source and an
existing stored model**, not guessed. The implementation pins it by reading
`model.rs` (and its `serde` attributes) plus a real stored `SlotModel` (e.g. the demo
game's), and the parity-oracle test (§7) makes any drift fail loudly. Notable: the
kernel has **no built-in "ways" mode** — every payline is an explicit `Vec<usize>`.

## 4. The realizer contract

```python
@dataclass(frozen=True)
class RealizeResult:
    model: dict | None       # the SlotModel dict, or None iff a hard error occurred
    errors: list[str]        # hard, blocking structural contradictions
    warnings: list[str]      # soft issues: clamped/seeded/placeholder/defaulted

def realize_slot_model(
    math_model: dict,        # the 4 GDD aspect `data` dicts, as stored
    symbols_reels: dict,
    paytable: dict,
    bonus_features: dict,
) -> RealizeResult: ...
```

**Fail-loud, not coerce-silently.** This deliberately departs from SP1's normalizers
(which coerce-and-warn, never raise) because a realized model is either structurally
valid or must be refused — there is no "rough but broken" middle. A returned `model`
(non-`None`) is guaranteed structurally valid; hard contradictions yield `model=None`
plus actionable `errors`; auto-fixable issues set the model and append a `warning`.
The function is **pure and deterministic** (no IO, no RNG) so golden vectors pin it
exactly.

### 4.1 Diagnostic taxonomy

**Hard errors (→ `model=None`):**

- No symbols defined (cannot build a model with an empty symbol set).
- A `payline_overrides` pattern whose length ≠ reel count, or a row index ≥ `rows`.
- `strip_length.max` < distinct symbol count (the guardrail forbids any strip that
  contains every symbol at least once).
- `payline_mode="lines"` (or default) with `payline_count` > `rows ** reel_count`
  (more distinct lines requested than geometrically exist).
- `payline_mode="ways"` where `rows ** reel_count` exceeds a perf cap
  (`MAX_PAYLINES`, default 4096) — protects the hot eval loop; the error advises
  `payline_overrides` or fewer rows/reels.

**Soft issues (→ model built, `warnings` appended):**

- `strip_length` absent (default applied) or its midpoint clamped up to the distinct
  symbol count.
- `paytable` absent/empty (placeholder payouts seeded) or a payout row whose `symbol`
  cell does not resolve to a known symbol (row skipped).
- `bonus_features` defines a free-spins feature but no `scatter`/`bonus` symbol exists
  to trigger it (bonus skipped; model stays valid).
- Optional fields absent and defaulted (`reels`→5, `rows`→3, `payline_mode`→`lines`).
- `payline_mode="ways"` whose informational `payline_count` ≠ `rows ** reel_count`
  (advisory mismatch).

## 5. Realization rules (per SlotModel field)

### 5.1 Symbols

From `symbols_reels["symbols"]` (the table rows: `slot`, `name`, `kind`, `art_desc`).
Assign integer ids `0,1,2,…` in row order; retain a `{slot→id, name→id}` map for the
paytable and bonus cross-references. Map `kind → SymbolRole` (per SP1 §3.2):

| GDD `kind`     | kernel `SymbolRole` | note                                             |
| -------------- | ------------------- | ------------------------------------------------ |
| `wild`         | `Wild`              |                                                  |
| `scatter`      | `Scatter`           |                                                  |
| `bonus`        | `Scatter`           | bonus symbols trigger features via scatter-count |
| `high` / `low` | `Normal`            | paying symbols; rarity is the tuner's job        |

`distinct_symbol_count` = number of symbol rows. Hard error if zero.

### 5.2 Reels / strip length

`reel_count = math_model.reels` (default 5), `rows = math_model.rows` (default 3).
Seed length `L = round(mean(strip_length.min, strip_length.max))`, **the same length
for every reel** (per-reel variation is SP3's tuner gene). Absent `strip_length`:
`L = max(distinct_symbol_count, DEFAULT_STRIP_LEN)` (`DEFAULT_STRIP_LEN`, e.g. 30) +
warning. Hard error if `strip_length.max < distinct_symbol_count`; else clamp `L` into
`[distinct_symbol_count, strip_length.max]` and warn if the midpoint was clamped.

Compose each reel by distributing all distinct symbols round-robin across `L`
positions so every symbol appears ≥1 — deterministic and numerically rough; every reel
is identical in SP2 (the tuner redistributes per-reel counts in SP3).

### 5.3 Paylines — one unified generator

A single deterministic generator enumerates **all** `rows ** reel_count`
row-combinations, **straight horizontals first** (the `rows` constant patterns), then
the remainder in lexicographic order. Then:

- `payline_overrides` present and non-empty → parse each `"0,1,2,1,0"` string to a
  `list[int]` and use directly (hard error on length ≠ `reel_count` or any index ≥
  `rows`). Overrides bypass the generator.
- `payline_mode="ways"` → take **all** `rows ** reel_count` patterns (243 for 5×3),
  subject to the `MAX_PAYLINES` cap.
- `payline_mode="lines"` (or default) → take the **first `payline_count`** generated
  patterns (hard error if `payline_count` > the generated total).

### 5.4 Paytable

From `paytable["payouts"]` (rows: `symbol`, `3oak`, `4oak`, `5oak`). Resolve each
`symbol` cell → id via the §5.1 map; emit one `PaytableEntry{symbol, count, payout}`
per OAK column present (`count ∈ {3,4,5}`). Unresolved `symbol` cell → warn + skip the
row. Absent/empty paytable → seed **placeholder ascending payouts** for each `Normal`
symbol + warn (the tuner tunes payouts regardless, so the placeholder only needs to be
structurally present and non-zero).

### 5.5 Bonuses

From `bonus_features["free_spins"]` (rows: `trigger`, `count`, `retrigger`,
`multiplier`). Emit `BonusFeature::FreeSpins{ trigger: TriggerSpec{ symbol = the
scatter/bonus symbol id, min_count = 3 }, config: FreeSpinsConfig{ spins_awarded =
count, retrigger, multiplier, feature_reels = None } }`. If a free-spins feature is
declared but no `scatter`/`bonus` symbol exists, warn + skip (the model stays valid;
the `bonus_hit_rate` target simply won't be met until the GDD names a trigger symbol).

### 5.6 Constants

`MAX_PAYLINES` (4096), `DEFAULT_STRIP_LEN` (30), `DEFAULT_REELS` (5), `DEFAULT_ROWS`
(3), `BONUS_MIN_COUNT` (3) are module-level named constants, not magic numbers.

## 6. Where it does NOT plug in (SP3 preview)

SP2 ships the function only. SP3 will: add `POST /games/{id}/realize` →
`SlotModelStore.put`; a `realize_slot_model` chat tool; an auto-realize trigger
(realize-on-structural-edit) feeding the existing `CurationHub`/`TunerHub`;
human-gated apply ("AI-designed, never AI-decided"); and the tuner `genome.rs`
strip-length gene + `repair` rework that relaxes the fixed-length invariant within the
`strip_length` range.

## 7. Testing (TDD)

**Golden-vector unit tests (the authoritative pure-logic layer).** A canonical GDD
(the demo game's four aspect dicts, inline in the test) → the **exact** expected
`SlotModel` dict, pinned. Covers: id assignment + `kind→role` mapping, reel
composition at the seeded length, `ways` expansion (243-line cartesian product),
`lines` truncation to `payline_count`, `payline_overrides` passthrough, paytable
resolution, and bonus mapping.

**Diagnostic tests.** Each hard-error case (§4.1) → `model is None` and the expected
error substring; each soft case → `model is not None` and the expected warning
substring. One test per branch so failures localize.

**Parity-oracle test (kernel as validity oracle).** Realize the demo GDD, then feed
the resulting model dict to the **real simulator binary** via the existing
`CurationRunner` path, and assert it evaluates to a finite `RoundOutcome` (no panic,
finite RTP, non-empty result). This guarantees the emitted dict matches the kernel's
serde shape and is structurally coherent — without re-hosting the realizer in Rust.
It requires the Rust toolchain/built binary, so it is marked like the existing
simulator e2e (not a pure-unit gate) and is excluded from the cheap unit run.

**Determinism.** `realize_slot_model` is pure and RNG-free, so the golden vectors are
stable and the parity test is reproducible.

## 8. Files touched (SP2)

- `studio/backend/app/simulator/realize.py` — **create.** `RealizeResult`,
  `realize_slot_model`, the unified payline generator, the `kind→role` map, the
  module constants.
- `studio/backend/tests/test_realize.py` — **create.** Golden-vector + diagnostic
  unit tests.
- `studio/backend/tests/e2e/test_realize_parity.py` — **create.** The parity-oracle
  test against the real simulator binary.

No Rust, no frontend, no schema change, no wiring.

## 9. Self-review checklist (filled at plan time)

- Every SlotModel field has a realization rule (§5) and a golden assertion (§7).
- Every diagnostic in §4.1 has a dedicated test (§7).
- The serde shape is pinned from real sources, not invented (§3), and the
  parity-oracle test is the backstop (§7).
- No magic numbers — all thresholds are named constants (§5.6).
