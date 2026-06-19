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
- The Superpowers `test-driven-development` skill enforces unit-level
  RED-GREEN-REFACTOR. It does **not** provide an e2e/browser harness — the e2e
  stack (e.g. Playwright) is wired up separately and used to validate client flows.

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

## Environment notes

- Tooling is Windows + PowerShell. `git` and `gh` (GitHub CLI) are installed via winget.
- After a fresh install, **already-open terminals won't have `git`/`gh` on `PATH`**
  until restarted. Open a new terminal, or in PowerShell refresh the session with:

  ```powershell
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  ```
