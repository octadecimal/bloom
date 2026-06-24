# `/todo` skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-level `/todo` Claude Code skill that captures, lists, and closes personal todos as GitHub issues via the `gh` CLI.

**Architecture:** The skill is a single instruction file — `.claude/skills/todo/SKILL.md` — with no executable code. Its "logic" is prose the model follows: it shells out to `gh` to create/list/close issues, namespacing personal todos with a `todo` label and `@me` assignee. A short `verify.md` reference documents the one-time manual end-to-end check.

**Tech Stack:** Claude Code skills (Markdown + YAML frontmatter), GitHub CLI (`gh`), PowerShell on Windows.

## Global Constraints

- The skill is **pure instructions, no executable code** — no scripts, no source files beyond Markdown.
- Skill lives at `.claude/skills/todo/SKILL.md` (project-level, committed so every worktree/session has it).
- Store = GitHub Issues in the **current repo** (`gh` resolves repo from the worktree's git remote).
- Every created issue carries `--label todo` and `--assignee @me`.
- The `todo` label is bootstrapped idempotently (`gh label create todo`; treat "already exists" as success).
- Preconditions check: `gh auth status` must pass; otherwise the skill stops and tells the user to run `gh auth login`.
- Single intent-based entry point: `/todo <anything>` → skill infers add vs. query vs. complete; ambiguous input → ask one clarifying question.
- No unit tests exist for this work (the deliverable is an instruction file); validation is the manual end-to-end checklist in `verify.md`.
- Commits use Conventional Commits (`feat:`, `docs:`, `chore:`) in the imperative mood.

---

### Task 1: Create the `/todo` skill instruction file

**Files:**
- Create: `.claude/skills/todo/SKILL.md`

**Interfaces:**
- Consumes: the `gh` CLI (`gh auth status`, `gh label create`, `gh issue create`, `gh issue list`, `gh issue close`).
- Produces: a slash command `/todo` available to any session in any bloom worktree. No code symbols are exported; downstream tasks rely only on the file existing at this exact path with valid frontmatter (`name: todo`).

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/todo/SKILL.md` with exactly this content:

````markdown
---
name: todo
description: Capture, list, and complete personal todos as GitHub issues. Use when the user types /todo to jot a task, asks what to do next from their todos, or marks a todo done. Wraps the gh CLI; namespaces personal todos with a `todo` label assigned to @me.
---

# /todo — personal todos as GitHub issues

Capture and manage the user's personal todos as GitHub issues in the current repo.
This skill is pure instructions: you (the model) run `gh` commands directly. There is
no script to execute.

## Preconditions (always check first)

1. Confirm `gh` is authenticated:

   ```
   gh auth status
   ```

   If this fails, STOP and tell the user:
   "GitHub CLI isn't authenticated — run `gh auth login`, then try `/todo` again."
   Do not attempt any issue operation until auth succeeds.

2. Ensure the `todo` label exists (idempotent — safe to run every time before creating):

   ```
   gh label create todo --description "Personal todo captured via /todo" --color ededed
   ```

   If this fails because the label already exists, treat it as success and continue.

## Determine intent

Read whatever the user typed after `/todo` and pick exactly one mode:

- **Complete** — the text starts with `done:` / `done ` / `complete:` / `finish:` /
  `close:`, or otherwise clearly says a task is finished. → go to **Complete**.
- **Query** — the text is a question or a list/show request ("what should I do next?",
  "list", "show", "what's open", "show #chat", or empty input). → go to **Query**.
- **Add** — anything else (an imperative task to capture, e.g. "wire up the Mongo
  checkpointer"). → go to **Add**.

If the input is genuinely ambiguous between capturing a task and asking a question,
ask ONE clarifying question instead of guessing.

## Add

Create an issue from the user's text. The one-liner is the title; if the user supplied
extra detail, put it in the body.

```
gh issue create --title "<the todo text>" --label todo --assignee @me
```

- To add detail: append `--body "<longer detail>"`.
- Optional tags: if the user's text contains `#word` tokens, add each as a label with
  `--label <word>` (bootstrap each first with the same idempotent
  `gh label create <word> ...` as above). The `todo` label is ALWAYS applied regardless.
- Report back the created issue number and URL (gh prints the URL on success).

## Query

List the user's open todos, then reason over them — prioritize, summarize, or answer
"what should I do next?". Do not just dump the raw list; think about it.

```
gh issue list --label todo --assignee @me --state open
```

- If the user narrowed the request (e.g. `show #chat`), add `--label <tag>` or
  `--search "<terms>"`.
- For "what should I do next?", read the titles and creation order and recommend a
  next item with a one-line reason.

## Complete

Close the issue that matches what the user finished.

1. List candidates:

   ```
   gh issue list --label todo --assignee @me --state open
   ```

2. Match the user's text to the best single open todo by title.
3. If exactly one clearly matches, close it:

   ```
   gh issue close <number>
   ```

   Then confirm which issue (number + title) you closed.
4. If two or more plausibly match, or none do, ask the user which issue number to close
   rather than closing the wrong one.

## Out of scope

Don't edit issue bodies, reopen closed issues, set milestones/projects/due dates, or
target any repo other than the current one. Keep it to create / list / close.
````

- [ ] **Step 2: Verify the file is valid and discoverable**

Run (from the worktree root):

```
gh --version && test -f .claude/skills/todo/SKILL.md && echo "skill file present"
```

Expected: `gh` prints a version, and `skill file present` is printed. Confirm the file's frontmatter has `name: todo` and a `description:` line (re-read the top of the file).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/todo/SKILL.md
git commit -m "feat(todo): add /todo skill backed by GitHub issues"
```

---

### Task 2: Add the manual end-to-end verification checklist

**Files:**
- Create: `.claude/skills/todo/verify.md`

**Interfaces:**
- Consumes: the `/todo` skill from Task 1 (the commands it documents must match `SKILL.md`).
- Produces: a human-runnable checklist; no code symbols.

- [ ] **Step 1: Write the verification checklist**

Create `.claude/skills/todo/verify.md` with this content:

````markdown
# `/todo` skill — manual verification

The skill has no unit tests (it is an instruction file). Run this once after any change
to `SKILL.md`. Requires `gh` authenticated against the current repo's remote.

## Checklist

1. **Auth gate** — temporarily ensure you understand the failure path: with `gh`
   authenticated, `/todo ping test` should proceed. (If you ever hit an unauthenticated
   machine, `/todo` must stop and say "run `gh auth login`".)

2. **Add + label bootstrap** — in a repo whose `todo` label may not yet exist:

   ```
   /todo verify the todo skill end to end
   ```

   Expect: a `todo` label is created if absent, a new issue is opened with that label,
   assigned to you, and the skill reports the issue number + URL. Confirm in the GitHub
   Issues UI that the label and assignee are set.

3. **Query** —

   ```
   /todo what should I do next?
   ```

   Expect: the skill runs `gh issue list --label todo --assignee @me --state open` and
   reasons over the results (a recommendation with a short rationale), not a raw dump.

4. **Complete** —

   ```
   /todo done: verify the todo skill end to end
   ```

   Expect: the matching issue from step 2 is closed via `gh issue close`, and the skill
   confirms which number/title it closed.

5. **Ambiguous complete** — with two similarly-titled open todos, `/todo done: verify`
   should ask which issue number rather than closing one blindly.

## Cleanup

Close or delete any issues created during verification:

```
gh issue list --label todo --assignee @me --state open
gh issue close <number>
```
````

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/todo/verify.md
git commit -m "docs(todo): add manual e2e verification checklist for /todo skill"
```

---

### Task 3: Run the end-to-end verification and finish the branch

**Files:**
- Modify: none (this task executes the checklist and opens the PR).

**Interfaces:**
- Consumes: `.claude/skills/todo/SKILL.md` and `.claude/skills/todo/verify.md`.
- Produces: a verified, merged `/todo` skill on `main`.

- [ ] **Step 1: Confirm `gh` auth**

Run:

```
gh auth status
```

Expected: shows a logged-in account for github.com. If not, run `gh auth login` and re-check.

- [ ] **Step 2: Execute the verification checklist**

Work through every numbered item in `.claude/skills/todo/verify.md` against the live repo (add, label bootstrap, query, complete, ambiguous-complete). Note the issue number(s) you create so you can confirm closure.

Expected: each step behaves as the checklist describes. If any step fails, fix `SKILL.md`, re-commit, and re-run the affected step before proceeding.

- [ ] **Step 3: Clean up verification issues**

Close any issues left open by verification:

```
gh issue list --label todo --assignee @me --state open
gh issue close <number>
```

Expected: no stray verification issues remain open.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/todo-skill
gh pr create --fill
```

Expected: a PR is created against `main`. (Per repo policy, `main` is protected; PR is the only path. 0 approvals required — self-merge once checks pass with `gh pr merge --squash --delete-branch`.)

---

## Self-Review

**1. Spec coverage:**
- Skill is `.claude/skills/todo/SKILL.md`, pure instructions → Task 1. ✓
- Store = GitHub Issues in current repo → Task 1 (Add/Query/Complete all use `gh` against current repo). ✓
- `todo` label + `@me` assignee → Task 1 Add step. ✓
- Idempotent label bootstrap → Task 1 Preconditions. ✓
- `gh auth status` precondition with `gh auth login` message → Task 1 Preconditions. ✓
- Intent-based single entry point + ambiguity rule → Task 1 "Determine intent". ✓
- Optional `#tag` → label → Task 1 Add step. ✓
- Manual e2e validation (all 5 spec validation items) → Task 2 checklist + Task 3 execution. ✓
- Out of scope list mirrored → Task 1 "Out of scope". ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases" placeholders; `<number>`, `<the todo text>`, `<tag>` are intentional command-substitution slots the model fills at runtime, documented in surrounding prose. ✓

**3. Type consistency:** No code symbols across tasks. The `gh` invocations are identical between `SKILL.md` (Task 1) and `verify.md` (Task 2): `--label todo --assignee @me --state open` for list, `gh issue close <number>` for close. ✓
