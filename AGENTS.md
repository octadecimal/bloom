# AGENTS.md

Guidance for AI coding agents working in this repository.

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

## Coding standards

- Durable, repo-wide coding standards live in [`docs/coding-standards.md`](docs/coding-standards.md)
  and **MUST** be followed. Add new standards there as they are agreed.
- Current highlights: **TypeScript interfaces always use an `I` prefix** (`IPlugin`,
  `IPaneDef`). See the doc for the full, authoritative list.

## Tooling & plugins

- The [Superpowers](https://github.com/obra/superpowers) plugin is enabled at the
  repo level via `.claude/settings.json` (`extraKnownMarketplaces` +
  `enabledPlugins`), so cloning the repo makes the same skills available. If the
  install prompt doesn't fire on folder trust, run:
  `claude plugin install superpowers@superpowers-marketplace`.

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
- PRs require no approvals, so a solo author can self-merge once checks pass.
- Force pushes and branch deletions on `main` are disabled.

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
