# Code Duplication Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a single ranked, actionable code-duplication backlog at `docs/reports/2026-06-25-code-duplication.md` covering the Python, TS, and Rust stacks — report only, no application-code changes.

**Architecture:** Hybrid pipeline. Stage 1 runs `jscpd` for an objective exact/near-exact clone baseline (JSON). Stage 2 dispatches three parallel reading agents (one per stack) that consume their stack's jscpd hits and read code to surface structural/semantic and boilerplate duplication, returning findings in a fixed schema. Stage 3 synthesizes, dedupes, ranks, writes the report, and commits.

**Tech Stack:** `jscpd` (via `npx`, supports TS/Python/Rust), parallel subagents for semantic reading, markdown output committed to git.

> **Note on TDD:** This plan produces a report, not code. The standard red/green test cycle does not apply. Each task instead ends with an explicit verification check on its artifact (file exists/parses, schema conformance, section completeness).

## Global Constraints

- Run all commands from `C:\code\bloom` (committed `main`, `a5fc012`). The session's `gdd-structured-content` worktree folder is empty.
- Work on branch `docs/code-duplication-report` (already created; spec already committed there).
- **No application code is modified.** Only `docs/reports/...` and (transiently) scratchpad artifacts are written.
- Excluded from all scanning: `node_modules`, `target`, `.venv`, `dist`, `__pycache__`.
- Excluded from scope: sibling worktrees `symbol-reshape`, `tuner-studio` (uncommitted in-flight work). Report reflects committed `main` only.
- Severity = High | Med | Low; Effort = S | M | L (rubrics in the spec).
- Scratchpad dir for transient artifacts: `C:\Users\dheye\AppData\Local\Temp\claude\C--code-bloom-wt-gdd-structured-content\286072b1-2574-4c48-b30c-80f2be58fa29\scratchpad` (referred to below as `$SCRATCH`).

## Source roots

| Stack | Roots |
| --- | --- |
| Python | `studio/backend/app` |
| TS/TSX | `studio/frontend/src`, `runtime/client` |
| Rust | `trusted/math`, `trusted/package`, `studio/simulator`, `studio/tuner` |

## File structure

- Create: `docs/reports/2026-06-25-code-duplication.md` — the deliverable.
- Transient (not committed): `$SCRATCH/jscpd/jscpd-report.json` — tool baseline consumed by agents.

---

### Task 1: jscpd tool baseline

**Files:**
- Create (transient): `$SCRATCH/jscpd/jscpd-report.json`

**Interfaces:**
- Produces: a jscpd JSON report at `$SCRATCH/jscpd/jscpd-report.json` containing a `duplicates[]` array (each with `firstFile`, `secondFile`, `start`/`end` lines, `fragment`, `lines`, `tokens`) and a `statistics` block (per-format and total clone counts / duplicated-line percentages). Also the recorded jscpd version + flags, for the report's method note.

- [ ] **Step 1: Run jscpd across all source roots with JSON + console reporters**

Run from `C:\code\bloom`:

```bash
npx --yes jscpd@4 \
  studio/frontend/src runtime/client \
  studio/backend/app \
  trusted/math trusted/package studio/simulator studio/tuner \
  --min-tokens 50 --min-lines 5 --mode mild \
  --reporters json,console \
  --output "$SCRATCH/jscpd" \
  --ignore "**/node_modules/**,**/target/**,**/.venv/**,**/dist/**,**/__pycache__/**,**/*.snap,**/*.lock" \
  --absolute
```

Record the printed jscpd version and the exact flags used (needed for the report's method note). `--mode mild` ignores empty lines and block comments so cosmetic gaps don't split clones.

- [ ] **Step 2: Verify the JSON report exists and parses**

Run:

```bash
node -e "const r=require('$SCRATCH/jscpd/jscpd-report.json'); console.log('duplicates:', r.duplicates.length); console.log('formats:', Object.keys(r.statistics.formats||{}));"
```

Expected: prints a duplicate count (may be 0) and the list of detected formats (should include `typescript`/`tsx`, `python`, and `rust` if any of those files were scanned). If a format is missing, confirm whether jscpd recognized that language; note any unscanned language as a caveat for the report rather than failing.

- [ ] **Step 3: No commit**

This artifact is transient (lives in scratchpad, outside the repo). Nothing to commit in this task.

---

### Task 2: Per-stack reading agents

Dispatch three subagents **in parallel** (single message, three Agent calls), one per stack. Each agent is a reading/analysis agent (`Explore` or `general-purpose`) given: (a) its stack's source roots, (b) the path to `$SCRATCH/jscpd/jscpd-report.json` and instruction to filter it to files under its roots, and (c) the finding schema and rubrics below. No agent writes code.

**Files:**
- Read-only: source roots per stack; `$SCRATCH/jscpd/jscpd-report.json`.

**Interfaces:**
- Produces: each agent returns a JSON object `{ "stack": "...", "findings": [ ... ] }` where each finding has exactly these keys: `type` (`"clone"`|`"structural"`|`"boilerplate"`), `title` (string), `locations` (array of `"path:line"` or `"path:start-end"` strings), `description` (string), `severity` (`"High"`|`"Med"`|`"Low"`), `suggested_fix` (string), `effort` (`"S"`|`"M"`|`"L"`).

- [ ] **Step 1: Dispatch the three agents in parallel**

Each agent prompt must include this shared contract verbatim:

> You are auditing **one stack** of the Bloom monorepo for code duplication. Working dir: `C:\code\bloom`. Do NOT modify any code — produce findings only.
>
> 1. Read the jscpd baseline at `$SCRATCH/jscpd/jscpd-report.json`. Filter `duplicates[]` to pairs where BOTH files are under your stack's roots. These are candidate exact/near-exact clones — confirm each by reading the code; discard false positives (e.g. generated code, unavoidable boilerplate) with a one-line reason.
> 2. Read through your stack's source roots and find duplication the tokenizer missed: **structural/semantic** (same logic/shape, different names or types — parallel functions, repeated branch ladders) and **boilerplate/pattern** (recurring hand-written patterns signalling a missing abstraction or seam; pay special attention to registries/factories and `__init__`/constructor wiring that every feature edits).
> 3. Emit findings in the schema below. Rank each: **Severity** — High = large or divergence-prone duplication, or hot files that force merge conflicts; Med = clear abstraction opportunity, moderate footprint; Low = small/cosmetic, low payoff. **Effort** — S = local extract (<~1h); M = introduce a seam/helper (a few hours); L = cross-cutting refactor. Give a concrete `suggested_fix` (name the helper/seam/module).
> 4. Return ONLY the JSON object `{ "stack": "<name>", "findings": [...] }`. No prose around it.

Per-stack roots to substitute into each prompt:
- **Python agent:** `studio/backend/app`
- **TS agent:** `studio/frontend/src`, `runtime/client`
- **Rust agent:** `trusted/math`, `trusted/package`, `studio/simulator`, `studio/tuner`

Use the `schema` mechanism (or explicit instruction) to force the exact key set above so synthesis needs no parsing fixups.

- [ ] **Step 2: Verify each agent returned schema-valid findings**

For each returned object, confirm: top-level `stack` + `findings` present; every finding has all eight keys with values from the allowed enums; every `locations` entry points to a real file under that stack's roots (spot-check 2-3 paths with the Read tool). If an agent returned malformed output or empty findings without justification, re-dispatch that single agent with the contract re-stated.

- [ ] **Step 3: Persist raw findings**

Write the three returned objects to `$SCRATCH/jscpd/findings-python.json`, `findings-ts.json`, `findings-rust.json` so synthesis is restartable. No git commit (transient).

---

### Task 3: Synthesize, write, and commit the report

**Files:**
- Create: `docs/reports/2026-06-25-code-duplication.md`

**Interfaces:**
- Consumes: `findings-python.json`, `findings-ts.json`, `findings-rust.json` from Task 2; jscpd version/flags + `statistics` block from Task 1.

- [ ] **Step 1: Merge, dedupe, and rank**

Combine all findings. Dedupe: collapse findings whose `locations` sets overlap substantially into one (keep the higher severity, union the locations). Within each stack, sort by severity (High → Med → Low), then by effort ascending (S first) as a tiebreak. Compute per-stack severity counts for the summary table.

- [ ] **Step 2: Write the report**

Create `docs/reports/2026-06-25-code-duplication.md` with exactly these sections (matches the spec's report structure):

```markdown
# Code Duplication Report — 2026-06-25

**Commit:** a5fc012 (main)
**Scope:** Python (studio/backend/app), TS (studio/frontend/src, runtime/client), Rust (trusted/math, trusted/package, studio/simulator, studio/tuner). Each stack analyzed independently.
**Method:** jscpd <version> (flags: --min-tokens 50 --min-lines 5 --mode mild; ignored node_modules/target/.venv/dist/__pycache__) for exact/near-exact clones, plus per-stack agent reading for structural/semantic and boilerplate duplication.
**Caveat:** Reflects committed `main` only. In-flight worktrees `symbol-reshape` and `tuner-studio` are excluded.

## Executive summary

| Stack | High | Med | Low | Total |
| --- | --- | --- | --- | --- |
| Python | … | … | … | … |
| TS | … | … | … | … |
| Rust | … | … | … | … |

**Top findings (whole codebase):**
1. …  (link to the per-stack detail)

## Python

| # | Type | Title | Severity | Effort | Locations |
| --- | --- | --- | --- | --- | --- |
| P1 | … | … | … | … | … |

### P1 — <title>
<description, suggested fix, effort rationale>

## TS
<same shape, T-prefixed ids>

## Rust
<same shape, R-prefixed ids>

## Appendix: raw jscpd metrics

<per-format clone counts, duplicated-line %, total from statistics block>
<exclusions and any unscanned-language caveats>
```

Fill every `…`/`<…>` placeholder with real content from the merged findings and jscpd statistics. Use `file:line` references (clickable). No placeholders may remain.

- [ ] **Step 3: Verify the report is complete**

Run:

```bash
node -e "const t=require('fs').readFileSync('docs/reports/2026-06-25-code-duplication.md','utf8'); for (const s of ['## Executive summary','## Python','## TS','## Rust','## Appendix']) if(!t.includes(s)) throw new Error('missing '+s); if(/…|<title>|<version>|TBD|TODO/.test(t)) throw new Error('placeholder left'); console.log('report OK, '+t.split('\n').length+' lines');"
```

Expected: `report OK, N lines`, no thrown error.

- [ ] **Step 4: Commit**

```bash
git add docs/reports/2026-06-25-code-duplication.md
git commit -m "docs: add code duplication report (Python/TS/Rust ranked backlog)"
```

---

## Self-review

- **Spec coverage:** Scope/source roots → Global Constraints + Source roots table (Task 1/2). Three duplication types → Task 1 (clones) + Task 2 contract (structural, boilerplate). Finding schema → Task 2 interface. Severity/effort rubrics → Global Constraints + Task 2 contract. Report structure (header/summary/per-stack/appendix) → Task 3 Step 2. Output path + commit → Task 3. Worktree caveat → Global Constraints + report header. All spec sections map to a task.
- **Placeholders:** Plan contains no TBD/TODO; the `…` tokens appear only inside the report *template* and Task 3 Step 3 explicitly fails the build if any survive.
- **Type consistency:** Finding key set (`type`, `title`, `locations`, `description`, `severity`, `suggested_fix`, `effort`) is defined once in Task 2's interface and reused unchanged in the report table/detail in Task 3. Severity/effort enums identical across Global Constraints, Task 2, Task 3.
