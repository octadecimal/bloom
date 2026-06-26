---
name: complete-work
description: Use when a development branch is done and its PR is open — verify CI, merge the PR, clean up the worktree/branch, switch to main, bring up the live stack, and produce a change-specific manual test walkthrough through Bloom Studio. Invoke as /bloom:complete-work.
---

# /bloom:complete-work

The closing ritual for a finished development branch. You (the model) run every
step directly with your own tools (`gh`, `git`, `just`, health-check polling).
There is no script.

**Create one todo per numbered step below and work them in order. STOP on the
first failure with a plain report — never press on, never claim success you did
not verify.**

## 1. Identify the PR

Find the open PR for the current branch:

```
gh pr view --json number,state,headRefName,mergeStateStatus,statusCheckRollup
```

If there is no PR for the branch, STOP: tell the user there's nothing to complete.

## 2. Pre-merge gate

Evaluate, in order:

- **PR still open?** If `state` is `MERGED` or `CLOSED`, STOP and report — nothing
  to merge. (The branch may already be done; offer to skip ahead to cleanup + live
  bring-up if the user confirms.)
- **CI still running?** If any check in `statusCheckRollup` is `PENDING`/
  `IN_PROGRESS`/`QUEUED`, do NOT merge. Tell the user CI is still in flight and
  offer to watch it:
  ```
  gh pr checks --watch
  ```
  When it settles, re-evaluate this gate.
- **CI failing?** If any check concluded `FAILURE`/`ERROR`/`CANCELLED`, do NOT
  silently stop. ASK the user which they want:
  1. **Address it now** — help diagnose and fix the failing check, push, and
     re-run this gate.
  2. **Merge anyway** — proceed to step 3 (only if they explicitly choose this).
  3. **Abort** — stop the skill.
- **All green + working tree clean + mergeable?** Confirm `git status` is clean and
  `mergeStateStatus` is mergeable (e.g. `CLEAN`), then proceed.

Do NOT re-run e2e or unit suites here — this gate trusts that the work was
validated before the PR was opened; it only confirms the PR's own CI is green.

## 3. Merge

```
gh pr merge --squash --delete-branch
```

This squash-merges and deletes the remote branch.

## 4. Clean up the worktree + branch

Work from the **primary checkout** `C:\code\bloom` — never from inside the
worktree being removed.

1. Sync main in the primary checkout:
   ```
   git -C C:/code/bloom checkout main
   git -C C:/code/bloom pull
   ```
2. Remove the merged worktree + local branch (substitute the real path/branch):
   ```
   git -C C:/code/bloom worktree remove <worktree-path>
   git -C C:/code/bloom worktree prune
   git -C C:/code/bloom branch -D <branch>
   ```

**Self-rooted special case:** if THIS session is rooted inside the worktree being
removed, the OS locks that folder and `worktree remove` fails. Run
`git worktree prune` + `git branch -D <branch>` anyway, then report the leftover
folder path for the user to delete manually. Do NOT claim the folder was removed.

## 5. Live-stack check + bring-up

All from the primary checkout at offset-0 ports (backend `8000`, frontend `4200`,
runtime `4300`).

First probe health (PowerShell):
```
Invoke-RestMethod http://localhost:8000/health
```

- **Already live?** If it answers `providerMode: live`, the stack is up — skip
  start and just re-report URLs.
- **Replay holding the port?** If it answers `providerMode: replay`, WARN that the
  live stack is one-session-at-a-time and STOP — another session owns the port;
  do not fight it.
- **Down / not answering?** Bring it up as background processes (run each with your
  background-run option so they persist for the session), polling between:
  ```
  just mongo-up
  just backend-serve     # live by default — run in background
  just serve-frontend    # run in background
  just engine-serve      # run in background
  ```
  Then confirm live mode:
  ```
  just preflight
  ```
  `preflight` exits non-zero unless `/health` reports live — treat a non-zero exit
  as a failure and report it.

**ComfyUI (:8188) — health-check only, never launch:**
```
Invoke-RestMethod http://localhost:8188/system_stats
```
If it does not answer, WARN loudly that asset generation will fail and tell the
user to start ComfyUI from `C:\ComfyUI`. Do NOT start the GPU process yourself.

**Lifecycle note to surface:** these background servers terminate when this Claude
session ends — say so, so the user isn't surprised later.

## 6. Change-specific test walkthrough

Read the just-merged PR's title and diff:
```
gh pr view <number> --json title,body,files
gh pr diff <number>
```

Then write the user a **walkthrough tailored to THIS change** — not a generic tour.
Include:

- **URLs:** studio at `http://localhost:4200` AND the LAN URL
  `http://<this-machine-ip>:4200` (the user often browses from another machine —
  never assume localhost on their end).
- **Where to go:** the exact pane/flow the merged change affects.
- **What to do:** the concrete clicks/inputs to exercise the change.
- **What "correct" looks like:** the observable behavior that confirms it works.
- **Caveats:** e.g. "this flow needs ComfyUI" if the change touches asset generation
  and ComfyUI was down in step 5.

## Done

Report a short summary: PR merged (#), worktree/branch cleaned (or leftover folder
noted), live stack status + URLs, ComfyUI status, and the walkthrough above.
