# AGENTS.md

Guidance for AI coding agents working in this repository.

For product intent — why Bloom exists, who it's for, and what winning looks like —
read [`docs/north-star.md`](docs/north-star.md) first.

## Commits

- **Always use the semantic (Conventional Commits) format for every commit.**
- Format: `<type>(<optional scope>): <description>`
- Common types:
  - `feat` — a new feature
  - `fix` — a bug fix
  - `docs` — documentation only changes
  - `style` — formatting, no code change
  - `refactor` — code change that neither fixes a bug nor adds a feature
  - `perf` — performance improvement
  - `test` — adding or correcting tests
  - `build` — build system or dependency changes
  - `ci` — CI configuration changes
  - `chore` — other changes that don't modify src or test files
- Use the imperative mood in the description ("add", not "added").
- Keep the subject line concise (~50 chars); add a body for context when needed.
- Use `!` after the type/scope or a `BREAKING CHANGE:` footer for breaking changes.

Examples:

```
feat(auth): add password reset flow
fix: handle empty response from API
docs: clarify setup steps in README
```

## Testing

- **TDD is mandatory.** Default to a test-first workflow: write a failing test,
  watch it fail, write the minimal code to pass, then refactor.
- **End-to-end client-side validation is a top priority.** Features must be
  validated from the real user's perspective, not just at the unit level.
- **Playwright e2e suites MUST be exhaustive and are the authoritative source of
  truth for desired client behavior.** They encode the behavioral contract: when
  prose and the suite disagree, the suite decides. Unit tests (TDD) cover the pure
  logic beneath; e2e covers observable behavior, exhaustively.
- **CI cost policy (repo-wide):** expensive suites stay out of CI until the cost
  calculus changes. **Browser e2e (Playwright) is NOT run in CI** — it is too
  time/money-expensive to gate every PR; run it locally (e.g. `just e2e`). Cheaper
  suites — unit tests and **non-browser e2e (e.g. a Python API/service suite)** — are
  expected to be CI-affordable and SHOULD run in CI once a pipeline exists. Keeping a
  suite out of CI does **not** lower its status as the source of truth; it only changes
  _where_ it runs.
- The Superpowers `test-driven-development` skill enforces unit-level
  RED-GREEN-REFACTOR. It does **not** provide an e2e/browser harness — the e2e
  stack (Playwright) is wired up per client project and used to validate client flows.
- **Backend provider modes:** `PROVIDER_MODE=live` (real APIs, default) or
  `PROVIDER_MODE=replay` (recorded-real cassettes, offline). The `/health` endpoint
  exposes the active mode; the frontend `mode-badge` reflects it. Run
  `just preflight` before any human session — it exits non-zero if the backend is in
  replay mode. Run `just record-fixtures` to refresh cassettes from live providers.
- **E2e tiers:** `just e2e` runs the Playwright suite against a replay backend
  (deterministic, the normal dev loop — start `just backend-serve-replay` first);
  `just e2e-live` sets `BLOOM_E2E_TIER=live` and runs the same specs against live
  providers (on-demand, never CI). The suite requires a backend on :8000 — global-setup
  performs a `/health` parity check and fails fast if none is reachable.

## Coding standards

- Durable, repo-wide coding standards live in [`docs/coding-standards.md`](docs/coding-standards.md)
  and **MUST** be followed. Add new standards there as they are agreed.
- Current highlights: **TypeScript interfaces always use an `I` prefix** (`IPlugin`,
  `IPaneDef`). See the doc for the full, authoritative list.
- The **studio visual design language** is authoritative and lives in
  [`docs/design-language.md`](docs/design-language.md) — 4 surfaces, 2 hairlines,
  3 text tiers, 1 rationed accent, floating-card Dockview model. All
  `studio/frontend` UI MUST follow it; raw colors outside `styles.css` are blocked
  by a guard test.

## Tooling & plugins

- The [Superpowers](https://github.com/obra/superpowers) plugin is enabled at the
  repo level via `.claude/settings.json` (`extraKnownMarketplaces` +
  `enabledPlugins`), so cloning the repo makes the same skills available. If the
  install prompt doesn't fire on folder trust, run:
  `claude plugin install superpowers@superpowers-marketplace`.
- The repo ships a **local `bloom` plugin** (`.claude/plugins/bloom/`) registered via
  a co-located marketplace (`.claude/plugins/.claude-plugin/marketplace.json`) and
  enabled in `.claude/settings.json`. It provides `/bloom:complete-work` — the
  end-of-branch ritual that verifies CI, merges the open PR, cleans up the
  worktree/branch, brings up the live stack, and prints a change-specific test
  walkthrough. If folder-trust doesn't auto-install it on a fresh clone, run once:
  `claude plugin marketplace add ./.claude/plugins` then
  `claude plugin install bloom@bloom-local`.

## Branching & pull requests

The `main` branch is protected: **direct pushes are blocked (even for admins)** and
every change must land through a pull request.

Standard flow for any change:

```
git checkout -b <type>/<short-name>   # e.g. docs/contributing-workflow
# ...make changes...
git commit -m "type: message"          # semantic format, see above
git push -u origin <branch>
gh pr create
gh pr merge --squash --delete-branch   # 0 approvals required; self-merge is OK
```

- Branch names use the same semantic prefixes as commits (`feat/`, `fix/`, `docs/`, ...).
- For parallel sessions on different branches, use **git worktrees** so they don't
  collide over one checkout — see [`docs/worktrees.md`](docs/worktrees.md)
  (`just wt-new <name>`).
- PRs require no approvals, so a solo author can self-merge once checks pass.
- Force pushes and branch deletions on `main` are disabled.
- **When finishing a development branch, don't present a merge/PR options menu —
  default to push + open a PR** (`git push -u` then `gh pr create`). `main` is
  protected, so PR is the only path anyway; just do it without asking.
- **After a PR merges, always clean up its worktree and branch.** Merge with
  `gh pr merge --squash --delete-branch` (removes the remote branch), then from
  the **primary checkout** (`C:\code\bloom`, never from inside the worktree being
  removed) run `git worktree remove <path>`, `git worktree prune`, and
  `git branch -D <branch>`. You can't delete the worktree the current session is
  rooted in (the OS locks the directory) — deregister it and delete the branch
  anyway, then note the leftover folder for manual `rm`. Keeps `git worktree list`
  and the branch list from accumulating merged cruft.

## Working alongside other sessions

Several sessions (e.g. parallel Claude sessions) may share this one repository.
Worktrees make branch/file collisions impossible — each session gets its own
directory and branch — so the protocol is short:

- **Never do feature work in the primary checkout (`C:\code\bloom`).** Spin your
  own worktree first: `just wt-new <name>` (full guide in
  [`docs/worktrees.md`](docs/worktrees.md)). Treat the primary checkout as
  coordination-only.
- **`git worktree list` (or `just wt-ls`) is the registry.** Run it first to see
  every active worktree and the branch it's on — that's how you know who else is
  working where before you touch anything.
- **Per-worktree port offset.** Each worktree gets a `BLOOM_PORT_OFFSET` (the
  primary checkout is `0`); every dev-stack port derives as `base + offset` —
  backend `8000+N`, studio frontend `4200+N`, runtime client `4300+N`, runtime
  game server `9000+N` (the e2e harness boots its own on `9300+N`) — and the
  replay backend isolates its data as `bloom_studio_wt{N}` / `var/media_wt{N}` on
  the one shared `mongod`. `just wt-new` auto-assigns the lowest free offset into
  the new worktree's `.env`. This lets parallel worktrees run `just
backend-serve-replay` + `just e2e` at the same time without colliding. Each config
  derives its port inline from `BLOOM_PORT_OFFSET` (the Vite/Playwright configs and
  e2e helpers read it; the `justfile` does the same in `sh` for the backend) — the
  base values (`8000` / `4200` / `4300`) are repeated in a few spots, so keep them in
  sync. See [`docs/worktrees.md`](docs/worktrees.md).
- **Live mode is still a singleton.** The offset shifts ports + data, not the one
  GPU/ComfyUI (`:8188`) or a live OpenRouter session — only one session runs the
  **live** stack at a time.

## Session hygiene

- At **sub-project boundaries** — after a PR merges, or once a spec or plan is
  committed — suggest the user run `/clear` so the next unit of work starts with a
  clean context window. This matches the repo's spec → plan → build rhythm
  (see `docs/superpowers/`).
- When suggesting `/clear`, **proactively hand the user a paste-ready resume
  prompt** for the fresh session — don't just suggest clearing. The prompt must be
  self-contained: the relevant spec/plan file paths, the skill to use, and any
  branch/scoping notes — nothing that relies on the about-to-be-cleared
  conversation. Keep it tight; the skill will read the plan itself.

## Plan execution

- Execute implementation plans with the **Superpowers
  `subagent-driven-development`** approach by default — fresh implementer subagent
  per task, a task review after each, and a broad whole-branch review at the end.
  Don't ask which execution mode to use; default to subagent-driven. Carry this
  same default into any `/clear` resume prompt (see Session hygiene).

## Environment notes

- Tooling is Windows + PowerShell. `git` and `gh` (GitHub CLI) are installed via winget.
- After a fresh install, **already-open terminals won't have `git`/`gh` on `PATH`**
  until restarted. Open a new terminal, or in PowerShell refresh the session with:

  ```powershell
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  ```
