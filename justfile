# Cross-cutting commands. Only Rust is populated this round; TS/Python join later.
default:
    @just --list

build:
    cargo build --workspace

test:
    cargo test --workspace

fmt:
    cargo fmt --all

lint:
    cargo clippy --workspace --all-targets

# Run a slot curation: model + target JSON -> signed package + report.
# Usage: just sim-curate game/model.json game/target.json my-game out.pkg out.report.txt
sim-curate model target id pkg report:
    cargo run -p bloom-simulator --bin curate -- {{model}} {{target}} {{id}} {{pkg}} {{report}}

# TypeScript / frontend
ts-test:
    npx nx run-many -t test

# Dev server binds 0.0.0.0 and proxies the API + WebSocket to the backend (see
# vite.config.mts), so the app is reachable from other devices on your LAN at
# http://<this-machine-ip>:4200 — just run `backend-serve` alongside it. No need
# to expose the backend port; the browser only ever talks to :4200.
serve-frontend:
    npx nx serve frontend

# Python / studio backend
mongo-up:
    powershell -NoProfile -Command "if ((Get-Service MongoDB).Status -ne 'Running') { Start-Service MongoDB }"

mongo-down:
    powershell -NoProfile -Command "Stop-Service MongoDB"

backend-install:
    cd studio/backend && uv sync

backend-serve:
    cd studio/backend && uv run uvicorn app.main:app --reload --port 8000

backend-test:
    cd studio/backend && uv run pytest -m "not e2e"

backend-e2e:
    cd studio/backend && uv run pytest -m e2e

# Serve the backend in replay mode (recorded-real fixtures; offline, no API key/GPU).
backend-serve-replay:
    cd studio/backend && PROVIDER_MODE=replay uv run uvicorn app.main:app --port 8000

# Preflight: refuse to "serve to a human" if the backend is in replay mode.
preflight:
    powershell -NoProfile -Command "$h = Invoke-RestMethod http://localhost:8000/health; Write-Host ('Provider mode: ' + $h.providerMode.ToUpper()); if ($h.providerMode -ne 'live') { Write-Error 'Backend is in REPLAY mode — not safe to hand to a user. Start it with PROVIDER_MODE=live.'; exit 1 }"

# Deterministic e2e against a replay backend (start `just backend-serve-replay` first).
e2e:
    npx playwright test --config=studio/frontend/playwright.config.ts

# Live e2e: same specs against LIVE providers (start a live backend + ComfyUI first). Never in CI.
e2e-live:
    cd studio/frontend && BLOOM_E2E_TIER=live npx playwright test --config=playwright.config.ts

# Regenerate recorded-real replay fixtures from the LIVE providers.
# Requires OPENROUTER_API_KEY in .env and ComfyUI running on :8188.
record-fixtures:
    cd studio/backend && PROVIDER_MODE=live uv run python -m app.replay.record

# ── Parallel worktrees (see docs/worktrees.md) ──────────────────────────────
# Run wt-new / wt-rm from the PRIMARY checkout (C:\code\bloom). Worktrees are
# created as siblings at ..\bloom.wt\<name>, one Claude session each. Each
# worktree installs its own deps; the live stack stays one-session-at-a-time.

# List every worktree and the branch it's on.
wt-ls:
    git worktree list

# Create a sibling worktree on a new branch and copy local .env into it.
# Usage:  just wt-new gdd-viewer            -> ..\bloom.wt\gdd-viewer  on feat/gdd-viewer
#         just wt-new audit-store fix       -> ..\bloom.wt\audit-store on fix/audit-store
wt-new name type='feat':
    git worktree add ../bloom.wt/{{name}} -b {{type}}/{{name}}
    powershell -NoProfile -Command "if (Test-Path .env) { Copy-Item .env '../bloom.wt/{{name}}/.env' -Force }"
    @echo "Worktree ..\bloom.wt\{{name}} on {{type}}/{{name}} is ready. Inside it run: just bootstrap"
    @echo "── active worktrees (who else is working where) ──"
    git worktree list

# Remove a worktree's directory (its branch is left intact).
wt-rm name:
    git worktree remove ../bloom.wt/{{name}}
    @echo "Removed worktree {{name}}. Branch kept — delete it with: git branch -d {{name}}"

# Install all per-worktree deps. Run this INSIDE a freshly-created worktree.
bootstrap:
    npm install
    cd studio/backend && uv sync
    @echo "Bootstrapped. (Cargo builds on demand; Mongo is shared — start it with: just mongo-up)"
