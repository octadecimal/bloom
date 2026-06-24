# `/todo` skill — design

**Date:** 2026-06-23
**Status:** Approved (brainstorming) → ready for implementation plan
**Branch:** `feat/todo-skill`

## Purpose

Let the user jot a todo from any session with a single command, persisting it as a
**GitHub issue** in the repo. A future session can then list those issues and reason
over them — the load-bearing use case being: _"from my todos, what should I do next?"_

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

## Store: GitHub Issues in `octadecimal/bloom`

- The skill is **bound to a fixed repo: `octadecimal/bloom`**. Every `gh` command passes
  `--repo octadecimal/bloom`, so todos always land in that repo regardless of which
  directory or worktree `/todo` is invoked from. (Pinned explicitly rather than relying
  on `gh`'s ambient repo resolution, so the binding is deterministic.)
- Every `/todo` issue carries **`--label todo`** and **`--assignee @me`**. This keeps
  personal captures cleanly separable from the repo's real bug/feature issues, and lets
  queries scope to "my open todos."
- **Label bootstrap:** before creating an issue, force-upsert the `todo` label with
  `gh label create todo … --force --repo octadecimal/bloom` (idempotent — exits 0 even
  when the label already exists).

## Preconditions

The skill needs `gh` authenticated. It first checks `gh auth status`; if that fails it
stops and tells the user to run `gh auth login`, rather than surfacing a cryptic error.

## The three modes (intent-based, single entry point)

The user always invokes `/todo <anything>`; the skill reads what follows and infers
intent. (Approved over explicit subcommands — lower friction.)

All `gh` commands below pass `--repo octadecimal/bloom` (omitted here for brevity).

- **Add** — e.g. `/todo wire up the Mongo checkpointer`
  Create an issue: `gh issue create --title "<text>" --label todo --assignee @me`.
  The one-liner is the title; longer detail (if the user gave any) goes in `--body`.
  Recognized `#tags` become extra labels and are stripped from the title.
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

Native issue labels _are_ the tags. Keep it light: an optional inline `#tag` in the
user's input maps to an additional label (created via the same idempotent
`gh label create` bootstrap if missing). Tags are never required — the `todo` label is
always applied regardless.

## Validation

There is nothing to unit-test: the skill is a markdown instruction file, and its
"logic" is the model following it. Validation is end-to-end and manual, done once:

1. `/todo <task>` → a `todo`-labelled issue assigned to the user is created; its number
   and URL are reported.
2. `octadecimal/bloom` with no `todo` label yet → the label is force-upserted, then the issue.
3. `/todo what should I do next?` → the session lists open todo issues and reasons over
   them.
4. `/todo done: <task>` → the matching issue closes; an ambiguous match asks first.
5. `gh` not authenticated → the skill stops with a clear "run `gh auth login`" message.

## Out of scope (YAGNI)

Editing issue bodies, reopening closed issues, milestones/projects, due dates, a
dedicated separate todos repo, and cross-repo todos. The model infers priority from the
issue text + timestamps at query time.
