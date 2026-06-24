# `/todo` skill — design

**Date:** 2026-06-23
**Status:** Approved (brainstorming) → ready for implementation plan
**Branch:** `feat/todo-skill`

## Purpose

Let the user jot a todo from any session with a single command, persisting it as a
**GitHub issue** in the repo. A future session can then list those issues and reason
over them — the load-bearing use case being: *"from my todos, what should I do next?"*

The defining insight: a Claude Code skill is **instructions, not code**. "Querying"
therefore needs no search engine — it is a session running `gh issue list` and
reasoning about the results. GitHub Issues give this for free: native open/closed
state, labels (tags), full-text search, timestamps, and assignees. The skill's job is
narrow:

1. **Capture well** — create a labelled, assigned issue from a one-line todo.
2. **Use a known, filterable store** — so any session can list and prioritize.

## What it is

A project-level Claude Code skill at `.claude/skills/todo/SKILL.md`. Pure instructions,
no executable code. Committed to the repo so it is available from every worktree and
every session. It wraps the `gh` CLI; it does **not** create or edit any file in the
repo.

## Store: GitHub Issues in the current repo

- Issues are created in the **current repo**. `gh` resolves the repo from the
  worktree's git remote, so the skill works unchanged from any bloom worktree.
- Every `/todo` issue carries **`--label todo`** and **`--assignee @me`**. This keeps
  personal captures cleanly separable from the repo's real bug/feature issues, and lets
  queries scope to "my open todos."
- **Label bootstrap:** before creating an issue, ensure the `todo` label exists. Run
  `gh label create todo` and treat an "already exists" failure as success (idempotent).

## Preconditions

The skill needs `gh` authenticated. It first checks `gh auth status`; if that fails it
stops and tells the user to run `gh auth login`, rather than surfacing a cryptic error.

## The three modes (intent-based, single entry point)

The user always invokes `/todo <anything>`; the skill reads what follows and infers
intent. (Approved over explicit subcommands — lower friction.)

- **Add** — e.g. `/todo wire up the Mongo checkpointer`
  Create an issue: `gh issue create --title "<text>" --label todo --assignee @me`.
  The one-liner is the title; longer detail (if the user gave any) goes in `--body`.
  Report the resulting issue number and URL back to the user.

- **Query** — e.g. `/todo what should I do next?`, `/todo list`, `/todo show #chat`
  Run `gh issue list --label todo --assignee @me --state open` (adding `--search` or an
  extra `--label` when the user narrows it), then **reason** over the results:
  prioritize, filter, summarize. No parsing logic — the model reads and thinks.

- **Complete** — e.g. `/todo done: fuzzy autocomplete`
  List open todo issues, match the best one to the user's text, then
  `gh issue close <number>`. If the match is ambiguous, ask the user which issue
  rather than closing the wrong one.

**Ambiguity rule:** if the input is neither a clear task to capture nor a clear
question/command, the skill asks one clarifying question rather than guessing.

## Tags

Native issue labels *are* the tags. Keep it light: an optional inline `#tag` in the
user's input maps to an additional label (created via the same idempotent
`gh label create` bootstrap if missing). Tags are never required — the `todo` label is
always applied regardless.

## Validation

There is nothing to unit-test: the skill is a markdown instruction file, and its
"logic" is the model following it. Validation is end-to-end and manual, done once:

1. `/todo <task>` → a `todo`-labelled issue assigned to the user is created; its number
   and URL are reported.
2. Fresh repo with no `todo` label → the label is auto-created, then the issue.
3. `/todo what should I do next?` → the session lists open todo issues and reasons over
   them.
4. `/todo done: <task>` → the matching issue closes; an ambiguous match asks first.
5. `gh` not authenticated → the skill stops with a clear "run `gh auth login`" message.

## Out of scope (YAGNI)

Editing issue bodies, reopening closed issues, milestones/projects, due dates, a
dedicated separate todos repo, and cross-repo todos. The model infers priority from the
issue text + timestamps at query time.
