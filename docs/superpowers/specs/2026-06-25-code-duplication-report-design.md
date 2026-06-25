# Code Duplication Report — Design

**Date:** 2026-06-25
**Status:** Approved design, pending implementation plan
**Deliverable:** A report only. This pass changes no application code.

## Goal

Produce a single, actionable refactoring backlog cataloguing code duplication
across the three stacks of the Bloom monorepo, each analyzed independently
within its own stack. Every finding is ranked by severity and paired with a
concrete suggested fix and a rough effort estimate.

## Scope

Analysis runs against committed `main` at `C:\code\bloom` (`a5fc012`). The
session's `gdd-structured-content` worktree folder is empty (cleaned up after a
prior merge), and the two sibling worktrees with in-flight work
(`symbol-reshape`, `tuner-studio`) are **excluded** — the report reflects
committed `main` only. This caveat is stated in the report header.

Source roots:

| Stack | Roots |
| --- | --- |
| Python backend | `studio/backend/app` |
| TS/TSX frontend | `studio/frontend/src`, `runtime/client` |
| Rust crates | `trusted/math`, `trusted/package`, `studio/simulator`, `studio/tuner` |

Excluded from all scanning: `node_modules`, `target`, `.venv`, `dist`,
`__pycache__`.

### Duplication types in scope

1. **Exact / near-exact clones** — literal copy-paste blocks (same tokens).
   Detected objectively by tooling.
2. **Structural / semantic** — same logic or shape with different names/types
   (parallel functions, repeated patterns a tokenizer misses). Detected by
   agent reading + judgment.
3. **Boilerplate / pattern repetition** — recurring hand-written patterns that
   hint at a missing abstraction or seam (e.g. `ToolFactory._BUILDERS`,
   `RoomHub.__init__` — files every feature edits). Detected by agent judgment.

## Approach (selected: Hybrid)

Tool baseline for objective clone metrics, plus an agent semantic pass for the
structural and boilerplate categories a tokenizer cannot see. Chosen over a
pure-agent sweep (loses reproducible metrics, more token-heavy) and a tool-only
run (structurally blind — would miss two of the three requested types).

## Pipeline

Three stages, all run against `C:\code\bloom`:

1. **Tool baseline.** Run `jscpd` across the source roots above (it supports
   TypeScript, Python, and Rust). Emit a JSON report of exact/near-exact clone
   pairs with file locations, line counts, and duplication percentages. Record
   the jscpd version and config (min-tokens / min-lines thresholds) for the
   report's method note.
2. **Per-stack reading agents (3, parallel).** One agent each for Python, TS,
   and Rust. Each receives its stack's jscpd hits and reads the code to:
   (a) confirm/interpret the tool's clones, and (b) find structural/semantic and
   boilerplate duplication the tokenizer misses. Each returns findings in the
   fixed schema below.
3. **Synthesis.** Dedupe overlapping findings, rank by severity, write the
   single markdown report, and commit it.

## Finding schema

Each finding records:

- `stack` — Python | TS | Rust
- `type` — clone | structural | boilerplate
- `title` — short description
- `locations` — list of `file:line` references
- `description` — what is duplicated and why it matters
- `severity` — High | Med | Low (rubric below)
- `suggested fix` — concrete action (extract helper, introduce seam, etc.)
- `effort` — S | M | L (rubric below)

### Severity rubric

- **High** — large or divergence-prone duplication, or hot files that force
  merge conflicts (e.g. `ToolFactory._BUILDERS`, `RoomHub.__init__`).
- **Med** — clear abstraction opportunity, moderate footprint.
- **Low** — small/cosmetic, low payoff.

### Effort rubric

- **S** — local extract (<~1h).
- **M** — introduce a seam/helper (a few hours).
- **L** — cross-cutting refactor.

## Report structure

Output: `docs/reports/2026-06-25-code-duplication.md`, committed to git.

- **Header** — date, commit SHA, scope, method note (jscpd config + version),
  worktree caveat.
- **Executive summary** — severity-count table per stack, plus the top findings
  across the whole codebase.
- **Per-stack sections** (Python / TS / Rust) — a ranked findings table, then
  detail per finding.
- **Appendix** — raw jscpd metrics and exclusions/caveats.

## Out of scope

- Changing any application code (this is report-only).
- Cross-language conceptual duplication (same concept mirrored across stacks) —
  each stack is analyzed independently; cross-language notes may appear
  incidentally but are not a primary deliverable.
- In-flight worktree branches (`symbol-reshape`, `tuner-studio`).
