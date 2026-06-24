# `/todo` skill — design

**Date:** 2026-06-23
**Status:** Approved (brainstorming) → ready for implementation plan
**Branch:** `feat/todo-skill`

## Purpose

Let the user jot a todo from any session with a single command, persisting it to a
known markdown file in the repo. A future session can then read that file and reason
over it — the load-bearing use case being: *"from my todos, what should I do next?"*

The defining insight: a Claude Code skill is **instructions, not code**. "Querying"
therefore needs no search engine — it is simply a session reading a known file and
reasoning about it. The skill's real job is narrow:

1. **Capture well** — append todos in a consistent, human- and machine-readable shape.
2. **Live at a known path** — so any session can read and prioritize, even without
   invoking the skill.

## What it is

A project-level Claude Code skill at `.claude/skills/todo/SKILL.md`. Pure instructions,
no executable code. Committed to the repo so it is available from every worktree and
every session. It manages exactly one file: `docs/TODO.md`.

## The file: `docs/TODO.md`

```markdown
# Bloom TODO

## Open
- [ ] Wire up durable Mongo checkpointer for run state  <!-- 2026-06-23 -->
- [ ] Collapse run steps into persisted chat messages #chat  <!-- 2026-06-22 -->

## Done
- [x] Fuzzy skill autocomplete  <!-- added 2026-06-22, done 2026-06-23 -->
```

- A markdown checkbox list under two headings: `## Open` and `## Done`.
- Each entry: plain-text task + an auto-stamped `added` date inside an HTML comment
  (`<!-- 2026-06-23 -->`). The comment is invisible in rendered markdown but readable
  by a session, and is what lets a future session reason about recency/staleness.
- Optional inline `#tags` — never required.
- If `docs/TODO.md` does not exist, the skill creates it from the template above
  (the two empty headings).

## The three modes (intent-based, single entry point)

The user always invokes `/todo <anything>`; the skill reads what follows and infers
intent. (Approved over explicit subcommands — lower friction.)

- **Add** — e.g. `/todo wire up the Mongo checkpointer`
  Append a `- [ ]` line under `## Open` with today's date.
  Date source on this Windows/PowerShell environment: `Get-Date -Format yyyy-MM-dd`.

- **Query** — e.g. `/todo what should I do next?`, `/todo list`, `/todo show #chat`
  Read `docs/TODO.md` and reason: prioritize, filter by tag, summarize. No parsing
  logic — the model reads and thinks. This path also works by simply asking in a
  session, since the file lives at a known path.

- **Complete** — e.g. `/todo done: fuzzy autocomplete`
  Find the best-matching open item, flip `- [ ]` → `- [x]`, move it from `## Open`
  to `## Done`, and append `, done <date>` to its comment.

**Ambiguity rule:** if the input is neither a clear task to capture nor a clear
question/command, the skill asks one clarifying question rather than guessing.

## Validation

There is nothing to unit-test: the skill is a markdown instruction file, and its
"logic" is the model following it. Validation is end-to-end and manual, done once:

1. In a real session, `/todo <task>` → confirm a new `- [ ]` line appears under
   `## Open` in `docs/TODO.md` with today's date.
2. `/todo what should I do next?` → confirm the session reads the file and reasons
   over the open items.
3. `/todo done: <task>` → confirm the item flips to `- [x]` and moves to `## Done`
   with a `done` date.
4. With `docs/TODO.md` absent → confirm `/todo <task>` creates it from the template.

## Out of scope (YAGNI)

Edit, delete, priority fields, due dates, multiple todo files, configurable sorting.
The model infers priority from text + dates at query time; rigid fields would only add
capture friction.
