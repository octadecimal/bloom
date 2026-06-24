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

**Offset-addressable per worktree (replay stacks run in parallel):** every dev-stack
port derives from the worktree's `BLOOM_PORT_OFFSET` (primary = `0`), which
`wt-new` auto-assigns:

| Resource          | Base / form                   | Per worktree         |
| ----------------- | ----------------------------- | -------------------- |
| Vite frontend     | `:4200`                       | `4200 + offset`      |
| Backend (uvicorn) | `:8000`                       | `8000 + offset`      |
| Runtime client    | `:4300`                       | `4300 + offset`      |
| Mongo database    | `bloom_studio` (one `mongod`) | `bloom_studio_wt{N}` |
| Media dir         | `var/media`                   | `var/media_wt{N}`    |

So two worktrees can each run `just backend-serve-replay` + `just e2e` at once
without colliding on a port or on Mongo data.

**Still single-tenant:** MongoDB itself (one native service on `:27017`, many logical
DBs) and ComfyUI / the GPU (`:8188`). **Only one session runs the _live_ app stack
at a time** — the offset shifts ports + data, never the GPU. Need the live app
(`just serve-frontend` + `just backend-serve`, `just e2e-live`, asset generation)?
Take it solo.

## Cleanup

```
just wt-rm <name>              # remove the worktree directory
git branch -d <type>/<name>    # delete its branch once merged
git worktree prune             # tidy stale metadata if a dir was deleted by hand
```

## Overriding individual ports

`BLOOM_PORT_OFFSET` is the one knob you normally set (and `wt-new` sets it for you).
For the rare case where one service needs a fixed port, the explicit per-service
variables override the derived value: `VITE_BLOOM_BACKEND_PORT`,
`BLOOM_FRONTEND_PORT` (alias `VITE_FRONTEND_PORT`), `BLOOM_RUNTIME_PORT`, and
`VITE_BLOOM_BACKEND_URL` (a full backend base URL, e.g. for a LAN/remote backend).

To set an offset by hand (e.g. a worktree created with raw `git worktree add`),
add a line to that worktree's `.env`:

```
BLOOM_PORT_OFFSET=1
```

## Still shared regardless of offset

- **Cut Rust disk/recompile cost:** point all worktrees at one shared
  `CARGO_TARGET_DIR`. Saves disk and recompiles, but concurrent `cargo` builds will
  serialize on a shared lock — so it's a deliberate trade, not the default. (Not
  built yet — YAGNI.)
