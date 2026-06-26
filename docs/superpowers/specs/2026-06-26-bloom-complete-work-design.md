# `/bloom:complete-work` — design

**Date:** 2026-06-26
**Status:** approved (brainstorm) → implementation
**Branch:** `feat/complete-work-skill`

## Purpose

A closing-ritual skill that takes a development session from "I just opened a PR"
to "the live stack is up and here's exactly how to test what we changed." It
collapses the repetitive end-of-branch dance — verify, merge, clean up worktrees,
switch to `main`, bring up the live environment, and hand the user a targeted manual
test walkthrough — into one command.

It is invoked as `/bloom:complete-work`, namespaced under a new **local `bloom`
plugin** so future repo skills can share the namespace.

## Why a plugin (not a plain `.claude/skills/` skill)

The `bloom:` prefix only exists for skills delivered by a plugin. The existing
`/todo` skill lives at `.claude/skills/todo/` and therefore invokes as bare `/todo`.
To get `/bloom:complete-work` we stand up a minimal **in-repo** plugin and register it
in `.claude/settings.json` so every clone of the repo gets it.

### Packaging layout

```
.claude/plugins/bloom/
  .claude-plugin/plugin.json            # plugin manifest (name: bloom)
  skills/complete-work/SKILL.md         # the skill (pure instructions, no script)
.claude/plugins/.claude-plugin/marketplace.json  # local marketplace listing the bloom plugin
.claude/settings.json                   # + extraKnownMarketplaces + enabledPlugins entry
```

**Open implementation risk:** the exact `settings.json` wiring for a _local,
repo-committed_ marketplace (source type + whether the path may be relative so it is
portable across clones, vs. an absolute `C:\code\bloom` path) must be confirmed
against current Claude Code behavior during build. If a portable relative/local
source is not supported, fall back to documenting the one-time
`claude plugin install` step in `AGENTS.md` the same way the superpowers plugin is
handled. The skill content itself is unaffected by this choice.

## The skill is pure instructions

Like `/todo`, `SKILL.md` is a procedure the model executes directly with its own
tools (`gh`, `git`, `just`, health-check polling). There is no companion script. Each
numbered step below becomes a todo item; execution is sequential and **stops on the
first failure** with an honest report rather than pressing on.

## Procedure

### 1. Identify the PR

`gh pr view --json number,state,headRefName,mergeStateStatus,statusCheckRollup` for
the current branch. If there is no PR for the branch, STOP and say so.

### 2. Pre-merge gate

- **PR still open?** If `state` is `MERGED`/`CLOSED`, STOP and report — nothing to
  merge (optionally continue to cleanup/live if already merged, but do not re-merge).
- **CI still running?** If checks are pending/in-progress, do **not** merge. Report
  that CI is in flight and offer to watch it (`gh pr checks --watch`) until it
  settles, then re-evaluate.
- **CI failing?** Do **not** silently stop. **Ask** the user whether to (a) address
  the failures now (and help fix them), (b) merge anyway, or (c) abort.
- **CI green + working tree clean + mergeable?** Proceed to merge.

Do **not** re-run e2e here — the gate trusts that the agent validated the work before
opening the PR; it only confirms the PR's own CI is green.

### 3. Merge

`gh pr merge --squash --delete-branch` (removes the remote branch).

### 4. Worktree + branch cleanup

Following the repo's cleanup convention:

1. Operate from the **primary checkout** `C:\code\bloom` (never from inside the
   worktree being removed).
2. `git checkout main` && `git pull` in the primary checkout.
3. `git worktree remove <path>`, `git worktree prune`, `git branch -D <branch>`.

**Self-rooted special case:** if _this very session is rooted in the worktree being
removed_, the OS locks that directory and `git worktree remove` will fail. Deregister
it anyway (`git worktree prune` after the folder is gone is the fallback), delete the
branch, and report the leftover folder path for the user to `rm` manually. Do not
pretend it was removed.

### 5. Live-stack check + bring-up

All from the **primary checkout** at default ports (offset 0): backend `:8000`,
frontend `:4200`, runtime engine `:4300`.

- **Already live?** If `GET :8000/health` reports `providerMode: "live"`, the stack is
  up — skip start and just re-report URLs.
- **Replay holding the port?** If `/health` answers but `providerMode` is `replay`,
  WARN that live is a one-session-at-a-time singleton and STOP rather than fight the
  other session for the port.
- **Otherwise bring it up** as in-session background processes, polling between:
  `just mongo-up` → `just backend-serve` (PROVIDER_MODE=live) → `just serve-frontend`
  → `just engine-serve`. Poll `:8000/health` until `providerMode: live`
  (equivalent to `just preflight`).
- **ComfyUI (:8188):** health-check only. If down, WARN loudly that asset generation
  will fail and give the start hint (`C:\ComfyUI`), but do **not** launch the GPU
  process.

**Lifecycle note:** in-session background servers terminate when this Claude session
ends. This is the accepted trade-off (chosen over detached terminal windows) for a
hands-off bring-up; the skill states this so the user isn't surprised.

### 6. Targeted test walkthrough

Read the just-merged PR's title and diff and produce a **change-specific** manual test
script — not a generic tour. It must include:

- The studio URL `http://localhost:4200` **and** the LAN URL
  (`http://<this-machine-ip>:4200`) since the user browses from another machine.
- Exactly which pane/flow to open for the merged change.
- The concrete clicks to perform and what correct behavior looks like.
- Any change-specific caveats (e.g. "needs ComfyUI" if the change touches asset gen).

## Behavior summary

- **Safety posture:** auto-merge is intentional — the skill's premise is "it's safe to
  merge the PR I opened" — but it is gated on an open PR, settled+green CI, and a clean
  tree, so it never merges a broken or in-flight PR.
- **Idempotent-ish:** re-running when the stack is already live just re-reports URLs and
  the walkthrough.
- **Honest reporting:** any server that fails to come up, a replay-mode collision, or a
  down ComfyUI is reported plainly; the skill never claims success it didn't verify.

## Out of scope

- Starting/ stopping ComfyUI (health-check only).
- Running or re-running e2e/unit suites (the pre-merge gate trusts prior validation).
- Any repo other than `octadecimal/bloom`.
- Detached/persistent server windows (explicitly chosen against).
