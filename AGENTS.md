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
