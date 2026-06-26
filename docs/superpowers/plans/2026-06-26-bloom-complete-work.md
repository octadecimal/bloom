# `/bloom:complete-work` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a repo-local `bloom` plugin whose `/bloom:complete-work` skill verifies CI, merges the open PR, cleans up the worktree/branch, switches to `main`, brings up the live stack, and hands the user a change-specific manual test walkthrough.

**Architecture:** A minimal in-repo plugin (`.claude/plugins/bloom/`) registered through a co-located local marketplace (`.claude/plugins/.claude-plugin/marketplace.json`) and enabled in `.claude/settings.json`. The skill itself is **pure instructions** — a `SKILL.md` the model executes with its own `gh`/`git`/`just`/health-check tools, exactly like the existing `/todo` skill. There is no companion script.

**Tech Stack:** Claude Code plugins + marketplaces; `gh` CLI; `git` (worktrees); `just` recipes; Windows + PowerShell (`Invoke-RestMethod` health checks); the Bloom live stack (Mongo, FastAPI backend :8000, Vite studio frontend :4200, Pixi runtime :4300, ComfyUI :8188).

## Global Constraints

- **Semantic commits** (Conventional Commits): `type(scope): imperative subject`, ~50 char subject.
- **Skill invocation is `/bloom:complete-work`** — plugin name `bloom` + `:` + skill name `complete-work`.
- **Plugin & skill artifacts are committed to the repo** so clones inherit them; the marketplace source path is **relative** (`./...`) and resolves against the repo main checkout root — never hardcode an absolute `C:\code\bloom` path.
- **Live stack runs from the primary checkout** `C:\code\bloom` at offset-0 ports: backend `8000`, frontend `4200`, runtime `4300`, ComfyUI `8188`.
- **`just backend-serve` is live by default** (`PROVIDER_MODE=live` is the backend default; `backend-serve-replay` is the replay variant). `just preflight` exits non-zero unless `/health` reports `providerMode: live`.
- **Honest reporting / stop-on-failure:** every skill step stops on first failure with a plain report; never claim success that wasn't verified.
- **`directory` marketplace source shape is not fully confirmed by docs** — Task 1 verifies it empirically and Task 4 documents the manual-install fallback in `AGENTS.md`.

---

## File Structure

- `.claude/plugins/.claude-plugin/marketplace.json` — local marketplace manifest listing the `bloom` plugin (marketplace root = `.claude/plugins/`).
- `.claude/plugins/bloom/.claude-plugin/plugin.json` — the `bloom` plugin manifest.
- `.claude/plugins/bloom/skills/complete-work/SKILL.md` — the skill (full procedure).
- `.claude/settings.json` — add `extraKnownMarketplaces.bloom-local` + `enabledPlugins["bloom@bloom-local"]`.
- `AGENTS.md` — document the plugin under "Tooling & plugins" + the one-time manual-install fallback.

---

## Task 1: Scaffold the `bloom` plugin + local marketplace and register it

**Files:**
- Create: `.claude/plugins/.claude-plugin/marketplace.json`
- Create: `.claude/plugins/bloom/.claude-plugin/plugin.json`
- Create: `.claude/plugins/bloom/skills/complete-work/SKILL.md` (stub — full body lands in Task 2)
- Modify: `.claude/settings.json`

**Interfaces:**
- Produces: a plugin `bloom` from marketplace `bloom-local`, making the skill discoverable as `/bloom:complete-work`. Task 2 fills the skill body; Task 4 documents the install path.

- [ ] **Step 1: Write the marketplace manifest**

`.claude/plugins/.claude-plugin/marketplace.json`:
```json
{
  "name": "bloom-local",
  "description": "Bloom project-local plugins.",
  "owner": { "name": "Bloom" },
  "plugins": [
    {
      "name": "bloom",
      "source": "./bloom",
      "description": "Bloom project workflows and skills."
    }
  ]
}
```
(`source: "./bloom"` resolves relative to the marketplace root `.claude/plugins/`.)

- [ ] **Step 2: Write the plugin manifest**

`.claude/plugins/bloom/.claude-plugin/plugin.json`:
```json
{
  "name": "bloom",
  "description": "Bloom project workflows and skills.",
  "version": "0.1.0"
}
```

- [ ] **Step 3: Write a minimal skill stub** (real body comes in Task 2)

`.claude/plugins/bloom/skills/complete-work/SKILL.md`:
```markdown
---
name: complete-work
description: Use when a development branch is done and its PR is open — verify CI, merge the PR, clean up the worktree/branch, switch to main, bring up the live stack, and produce a change-specific manual test walkthrough. Invoke as /bloom:complete-work.
---

# /bloom:complete-work

Stub — implemented in Task 2.
```

- [ ] **Step 4: Register the marketplace + enable the plugin in `.claude/settings.json`**

Merge these keys into the existing object (keep the superpowers entries intact):
```json
{
  "extraKnownMarketplaces": {
    "superpowers-marketplace": { "source": { "source": "github", "repo": "obra/superpowers-marketplace" } },
    "bloom-local": { "source": { "source": "directory", "path": "./.claude/plugins" } }
  },
  "enabledPlugins": {
    "superpowers@superpowers-marketplace": true,
    "bloom@bloom-local": true
  }
}
```

- [ ] **Step 5: Validate the JSON files parse**

Run (Bash tool):
```bash
for f in .claude/plugins/.claude-plugin/marketplace.json .claude/plugins/bloom/.claude-plugin/plugin.json .claude/settings.json; do
  python -c "import json,sys; json.load(open(sys.argv[1])); print('OK', sys.argv[1])" "$f" || echo "BAD $f"
done
```
Expected: three `OK` lines, no `BAD`.

- [ ] **Step 6: Empirically verify the plugin installs and the skill is discoverable**

Run from the worktree root:
```bash
claude plugin marketplace add ./.claude/plugins
claude plugin install bloom@bloom-local
claude plugin list
```
Expected: `claude plugin list` shows `bloom` enabled.

**If `directory` source is rejected** (the one unconfirmed bit), try the string shorthand `"bloom-local": "./.claude/plugins"` in settings.json, then retry. If neither registers via settings.json, keep the artifacts as-is — they are correct — and rely on the documented manual `claude plugin marketplace add ./.claude/plugins` + `claude plugin install bloom@bloom-local` (added to `AGENTS.md` in Task 4). Record in the commit body which wiring worked.

- [ ] **Step 7: Commit**

```bash
git add .claude/plugins .claude/settings.json
git commit -m "feat(plugin): scaffold local bloom plugin + complete-work skill stub"
```

---

## Task 2: Author the `complete-work` skill procedure

**Files:**
- Modify: `.claude/plugins/bloom/skills/complete-work/SKILL.md` (replace stub body with full procedure)

**Interfaces:**
- Consumes: the plugin scaffold from Task 1 (skill is already discoverable).
- Produces: the complete operator procedure for `/bloom:complete-work`.

- [ ] **Step 1: Replace the file with the full skill**

Write `.claude/plugins/bloom/skills/complete-work/SKILL.md` verbatim:

````markdown
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
````

- [ ] **Step 2: Lint the skill structure**

Run (Bash tool) — confirm frontmatter + all six step headings are present:
```bash
python - <<'PY'
import re, sys
t = open(".claude/plugins/bloom/skills/complete-work/SKILL.md", encoding="utf-8").read()
assert t.startswith("---"), "missing frontmatter"
assert "name: complete-work" in t, "missing name"
assert "description:" in t.split("---")[1], "missing description"
for h in ["## 1. Identify the PR","## 2. Pre-merge gate","## 3. Merge",
          "## 4. Clean up the worktree","## 5. Live-stack check","## 6. Change-specific test walkthrough"]:
    assert h in t, f"missing section: {h}"
print("SKILL.md structure OK")
PY
```
Expected: `SKILL.md structure OK`.

- [ ] **Step 3: Commit**

```bash
git add .claude/plugins/bloom/skills/complete-work/SKILL.md
git commit -m "feat(skill): author /bloom:complete-work procedure"
```

---

## Task 3: Document the plugin + manual-install fallback in `AGENTS.md`

**Files:**
- Modify: `AGENTS.md` (under "## Tooling & plugins")

**Interfaces:**
- Consumes: the working (or fallback) wiring confirmed in Task 1 Step 6.

- [ ] **Step 1: Add a Bloom-plugin subsection**

Append to the "## Tooling & plugins" section of `AGENTS.md`:
```markdown
- The repo ships a **local `bloom` plugin** (`.claude/plugins/bloom/`) registered via
  a co-located marketplace (`.claude/plugins/.claude-plugin/marketplace.json`) and
  enabled in `.claude/settings.json`. It provides `/bloom:complete-work` — the
  end-of-branch ritual that verifies CI, merges the open PR, cleans up the
  worktree/branch, brings up the live stack, and prints a change-specific test
  walkthrough. If folder-trust doesn't auto-install it on a fresh clone, run once:
  `claude plugin marketplace add ./.claude/plugins` then
  `claude plugin install bloom@bloom-local`.
```

- [ ] **Step 2: Verify markdown formatting passes the repo gate**

Run:
```bash
node_modules/.bin/prettier --check AGENTS.md
```
Expected: `All matched files use Prettier code style!` (or the file listed as already formatted). If it reports a diff, run `node_modules/.bin/prettier --write AGENTS.md` and re-check.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document the bloom plugin + /bloom:complete-work"
```

---

## Task 4: End-to-end smoke + whole-branch review

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1–3.

- [ ] **Step 1: Confirm the skill is invokable end-to-end**

In a fresh session (or via `claude plugin list`), confirm `bloom` is enabled and
`/bloom:complete-work` resolves. Expected: the skill appears in the available-skills
list with its description.

- [ ] **Step 2: Dry-read the procedure for command accuracy**

Re-read `SKILL.md` and cross-check every command against the repo:
- `just mongo-up`, `just backend-serve`, `just serve-frontend`, `just engine-serve`,
  `just preflight` all exist in the `justfile`. ✓ (confirm by grep)
- The health endpoint is `:8000/health` returning `providerMode`. ✓
Run:
```bash
grep -E "^(mongo-up|backend-serve|serve-frontend|engine-serve|preflight):" justfile
```
Expected: all five recipes listed.

- [ ] **Step 3: Prettier gate on all changed docs/JSON**

```bash
node_modules/.bin/prettier --check "docs/**/*.md" AGENTS.md ".claude/**/*.json"
```
Expected: clean. Fix with `--write` + re-check if needed.

- [ ] **Step 4: Final review + push**

Confirm `git log --oneline main..HEAD` shows the spec, scaffold, skill, and docs
commits. Push and open the PR:
```bash
git push -u origin feat/complete-work-skill
gh pr create --fill
```

---

## Self-Review

**Spec coverage:**
- Packaging (plugin + marketplace + settings) → Task 1. ✓
- Pure-instructions skill, six-step procedure → Task 2 (full SKILL.md). ✓
- Pre-merge gate incl. PR-open + CI-running + CI-failing-asks → Task 2 §2. ✓
- Worktree cleanup incl. self-rooted case → Task 2 §4. ✓
- Live bring-up (background, poll, replay-collision, already-live) → Task 2 §5. ✓
- ComfyUI health-check-only → Task 2 §5. ✓
- Change-specific walkthrough + LAN URL → Task 2 §6. ✓
- Local-marketplace risk + manual-install fallback → Task 1 Step 6 + Task 3. ✓

**Placeholder scan:** No "TBD"/"handle errors"-style placeholders; the SKILL.md body is provided verbatim, not summarized. The one stub (Task 1 Step 3) is explicitly replaced in Task 2.

**Type/name consistency:** marketplace name `bloom-local`, plugin name `bloom`, skill `complete-work`, invocation `/bloom:complete-work`, enable key `bloom@bloom-local` — consistent across Tasks 1–4 and AGENTS.md.
