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

## Environment notes

- Tooling is Windows + PowerShell. `git` and `gh` (GitHub CLI) are installed via winget.
- After a fresh install, **already-open terminals won't have `git`/`gh` on `PATH`**
  until restarted. Open a new terminal, or in PowerShell refresh the session with:

  ```powershell
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  ```
