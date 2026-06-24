# Parallel worktrees

Run several sessions (e.g. multiple Claude sessions) on different branches at once,
without them fighting over a single checkout.

## Why

`git switch` changes the branch for the **whole working tree**. With two sessions in
one folder, whoever switches last wins and pulls files out from under the other. Git
**worktrees** fix this: one repository, several working directories, each on its own
branch, sharing the same history. No more collisions.

## The convention

- The **primary checkout** stays at `C:\code\bloom`.
- Each parallel task gets a **sibling** worktree at `C:\code\bloom.wt\<name>` — a
  sibling, **never nested inside the repo** (nesting confuses Nx and ignore globs).
- **One session per worktree directory.** Inside its own folder a session can
  `git switch`, commit, and rebase freely with zero effect on the others.

## Commands

Run `wt-new` / `wt-rm` from the **primary checkout** (`C:\code\bloom`):

```
just wt-ls                     # list all worktrees and their branches
just wt-new gdd-viewer         # -> ..\bloom.wt\gdd-viewer on branch feat/gdd-viewer
just wt-new audit-store fix    # -> ..\bloom.wt\audit-store on branch fix/audit-store
just wt-rm gdd-viewer          # remove the worktree dir (branch is kept)
```

`wt-new` also copies your local `.env` into the new worktree. Then, **inside** the new
worktree, install its dependencies:

```
cd ..\bloom.wt\gdd-viewer
just bootstrap                 # npm install + uv sync for this worktree
```

## What is and isn't isolated

**Isolated per worktree (each gets its own):** branch + working files,
`node_modules`, `studio/backend/.venv`, Cargo `target/`, `.env`. Editing, building,
and unit tests (`cargo test`, `just ts-test`, `just backend-test`) all run in parallel
across worktrees safely.

**Shared — single-tenant — across the whole machine:**

| Resource | Port / form | Rule |
| --- | --- | --- |
| Vite frontend | `:4200` | one at a time |
| Backend (uvicorn) | `:8000` | one at a time |
| MongoDB | native Windows Service, `:27017` | one shared instance |
| ComfyUI | `:8188`, one GPU | one at a time |

**The rule: only one session runs the live app stack at a time.** Whoever needs the
running app (`just serve-frontend` + `just backend-serve`, `just e2e`, asset
generation) takes it solo. Everyone else does code + unit-test work, which is freely
parallel.

## Cleanup

```
just wt-rm <name>              # remove the worktree directory
git branch -d <type>/<name>    # delete its branch once merged
git worktree prune             # tidy stale metadata if a dir was deleted by hand
```

## Upgrade path (only if "one stack at a time" starts to hurt)

Designed to be a small change, not a rewrite:

- **Two live stacks at once:** give each worktree a port offset (`:8001`/`:4201`) and
  its own **Mongo database name** via env — one Mongo instance hosts many databases,
  so no second server is needed. The GPU/ComfyUI stays single regardless.
- **Cut Rust disk/recompile cost:** point all worktrees at one shared
  `CARGO_TARGET_DIR`. Saves disk and recompiles, but concurrent `cargo` builds will
  serialize on a shared lock — so it's a deliberate trade, not the default.

Neither is built yet (YAGNI); the env layout above leaves room for both.
