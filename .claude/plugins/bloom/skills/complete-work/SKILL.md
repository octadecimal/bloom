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
- **CI green but branch is BEHIND main?** If `mergeStateStatus` is `BEHIND`, update
  the branch first (`gh pr update-branch` or rebase/merge main in) and then
  re-evaluate this gate — do not silently stall.
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

**Self-rooted special case:** detect this first — compare your current working
directory (`git rev-parse --show-toplevel`) against the worktree path from
`git worktree list`. If THIS session is rooted inside the worktree being removed,
BOTH `git worktree remove` AND `git branch -D <branch>` will fail: the OS locks
the directory so the worktree cannot be removed, and git refuses to delete a branch
that is still checked out in an existing worktree. These are **expected failures in
this case — do NOT STOP**. Note them and continue: report to the user BOTH the
leftover folder path AND the still-present branch name for manual cleanup after this
session ends (delete the folder, then run `git worktree prune` +
`git branch -D <branch>` from the primary checkout in a later session). Do NOT
claim either was removed.

## 5. Live-stack check + bring-up

**Every command in this step MUST run with the working directory set to the primary
checkout `C:\code\bloom` (where `BLOOM_PORT_OFFSET` is 0) — NEVER from a worktree,
because `just` loads the cwd's `.env` and a worktree's offset would bind the wrong
ports while the URLs below assume offset 0.**

All from the primary checkout at offset-0 ports (backend `8000`, frontend `4200`,
runtime `4300`).

First probe health (PowerShell):

```
Invoke-RestMethod http://localhost:8000/health
```

- **Already live? RESTART it — do NOT skip, because we just merged.** A
  long-running `uvicorn --reload` backend does **not** reload a `git pull`/merge:
  the atomic rename slips the file watcher, so a backend that was up _before_ the
  step-3 merge is now serving **stale code without this PR's changes**. `/health`
  saying `live` only proves a process is up, not that it has the merged code —
  skipping here is exactly how a just-merged change appears "broken" in the live
  app while every test passed. So when `/health` reports `providerMode: live`,
  **restart the backend** so the merged code is actually served:
  - From `C:\code\bloom` (PowerShell, offset 0), kill the **whole** :8000 process
    tree — the listener PID **and** its parent (the `--reload` supervisor) **and**
    its child (the worker that inherited the :8000 socket; killing only the
    listener leaves the socket held and the next bind fails). Confirm :8000 is
    free, then `just backend-serve` in the background and poll `/health` until it
    answers `live` again.
  - The Vite frontend and engine **hot-reload from disk**, so they pick up the
    merge automatically — only restart them if they're down or visibly stale.
  - Verify the restart actually loaded the new code (a fresh `/health`, and where
    practical a quick check that this PR's change is now served) before reporting
    success.
- **Replay holding the port?** If it answers `providerMode: replay`, another
  session owns the live port in replay mode — WARN that the live stack is
  one-session-at-a-time and STOP. Do **not** restart or fight it (that would
  clobber their stack); the merged code can't be served live until they free it.
- **Down / not answering?** Bring it up as background processes (run each with your
  background-run option so they persist for the session), polling between:
  ```
  Set-Location C:\code\bloom   # PowerShell — ensures offset 0
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

**ComfyUI — health-check only, never launch:**

ComfyUI is **not necessarily local**. Read the configured URL first and probe
*that* — probing `localhost` unconditionally reports a false failure whenever the
GPU lives on another box:

```
$u = (Select-String -Path studio/backend/.env -Pattern '^\s*COMFYUI_URL\s*=\s*(.+)$').Matches.Groups[1].Value
if (-not $u) { $u = 'http://127.0.0.1:8188' }   # matches Settings.comfyui_url default
Invoke-RestMethod "$u/system_stats"
```

If it does not answer, WARN loudly that asset generation will fail. Where to
point the user depends on the URL: a local one means starting ComfyUI from
`C:\ComfyUI`; a LAN one means that machine is off, ComfyUI isn't running on it,
or its firewall is blocking the port. Either way, do NOT start the GPU process
yourself, and never assume a remote host is reachable just because the URL is set.

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
  never assume localhost on their end). Find the LAN IP by running `ipconfig` and
  reading the IPv4 address of the active adapter.
- **Where to go:** the exact pane/flow the merged change affects.
- **What to do:** the concrete clicks/inputs to exercise the change.
- **What "correct" looks like:** the observable behavior that confirms it works.
- **Caveats:** e.g. "this flow needs ComfyUI" if the change touches asset generation
  and ComfyUI was down in step 5.

## Done

Report a short summary: PR merged (#), worktree/branch cleaned (or leftover folder
noted), live stack status + URLs, ComfyUI status, and the walkthrough above.
