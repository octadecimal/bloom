# Cross-cutting commands. Only Rust is populated this round; TS/Python join later.
set dotenv-load := true

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

# Build the release curation binary the studio backend shells out to.
sim-build:
    cargo build --release -p bloom-simulator

# Tune a slot model toward a target: seed model + target + tuner config ->
# tuned model JSON + audit report. Exits non-zero on a near-miss.
# Usage: just tune game/model.json game/target.json game/tuner.json out.model.json out.report.txt
tune model target config out_model out_report:
    cargo run -p bloom-tuner --bin tune -- {{model}} {{target}} {{config}} {{out_model}} {{out_report}}

# Build the release tuning binary (for later studio-backend shelling out).
tuner-build:
    cargo build --release -p bloom-tuner

# TypeScript / frontend
ts-test:
    npx nx run-many -t test

# Dev server binds 0.0.0.0 and proxies the API + WebSocket to the backend (see
# vite.config.mts), so the app is reachable from other devices on your LAN at
# http://<this-machine-ip>:4200 — just run `backend-serve` alongside it. No need
# to expose the backend port; the browser only ever talks to :4200.
serve-frontend:
    npx nx serve frontend

# Serve the runtime client Pixi engine. Port derives from BLOOM_PORT_OFFSET inside
# vite.config.mts (base 4300; e.g. offset 2 → :4302). Binds 0.0.0.0 for LAN access.
engine-serve:
    cd runtime/client && npx vite --host 0.0.0.0

# Python / studio backend
mongo-up:
    powershell -NoProfile -Command "if ((Get-Service MongoDB).Status -ne 'Running') { Start-Service MongoDB }"

mongo-down:
    powershell -NoProfile -Command "Stop-Service MongoDB"

backend-install:
    cd studio/backend && uv sync

# Binds 0.0.0.0 so the engine iframe's host-derived mediaBase (and any LAN browser) can
# reach /media — mirrors engine-serve's --host 0.0.0.0. Without it uvicorn binds 127.0.0.1
# only, so a LAN-IP studio shows a blank Game Scene (textures fail to load).
backend-serve:
    cd studio/backend && off="${BLOOM_PORT_OFFSET:-0}"; if [ "$off" = "0" ]; then db=bloom_studio; media=var/media; else db=bloom_studio_wt$off; media=var/media_wt$off; fi; MONGO_DB="$db" MEDIA_DIR="$media" uv run uvicorn app.main:app --reload --host 0.0.0.0 --port $((8000 + off))

backend-test:
    cd studio/backend && uv run pytest -m "not e2e"

backend-e2e:
    cd studio/backend && uv run pytest -m e2e

# Serve the backend in replay mode (recorded-real fixtures; offline, no API key/GPU).
# Backend port + Mongo DB + media dir all follow BLOOM_PORT_OFFSET so parallel
# worktrees never share data. Offset 0 keeps the defaults (8000 / bloom_studio / var/media).
backend-serve-replay:
    cd studio/backend && off="${BLOOM_PORT_OFFSET:-0}"; if [ "$off" = "0" ]; then db=bloom_studio; media=var/media; else db=bloom_studio_wt$off; media=var/media_wt$off; fi; PROVIDER_MODE=replay RUNTIME_SERVER_URL="http://localhost:$((9300 + off))" MONGO_DB="$db" MEDIA_DIR="$media" uv run uvicorn app.main:app --port $((8000 + off))

# Preflight: refuse to "serve to a human" if the backend is in replay mode.
preflight:
    powershell -NoProfile -Command "$off = [int]($env:BLOOM_PORT_OFFSET); $port = 8000 + $off; $h = Invoke-RestMethod ('http://localhost:{0}/health' -f $port); Write-Host ('Provider mode: ' + $h.providerMode.ToUpper() + ' (port ' + $port + ')'); if ($h.providerMode -ne 'live') { Write-Error 'Backend is in REPLAY mode — not safe to hand to a user. Start it with PROVIDER_MODE=live.'; exit 1 }"

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

# Create a sibling worktree on a new branch, copy local .env, and auto-assign the
# lowest free BLOOM_PORT_OFFSET so its dev stack never collides with another worktree.
# Usage:  just wt-new gdd-viewer            -> ..\bloom.wt\gdd-viewer  on feat/gdd-viewer
#         just wt-new audit-store fix       -> ..\bloom.wt\audit-store on fix/audit-store
wt-new name type='feat':
    git worktree add ../bloom.wt/{{name}} -b {{type}}/{{name}}
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/wt-assign-offset.ps1 ../bloom.wt/{{name}}
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

# ── Runtime game server ──────────────────────────────────────────────────────

# Mint the runtime/server demo package (dev-signed) from its committed fixtures.
runtime-demo-pkg:
    cargo run --release -p bloom-simulator --bin curate -- \
      runtime/server/demo/model.json runtime/server/demo/target.json \
      bloom-demo-slots runtime/server/demo/demo.pkg runtime/server/demo/demo.report.txt \
      runtime/server/demo/presentation.json

# Run the authoritative runtime game server on the demo package.
runtime-serve: runtime-demo-pkg
    cargo run --release -p bloom-runtime-server

# Mint the composed@1 demo package (dev-signed, uncurated pool) from its fixture.
composed-demo-pkg:
    cargo run --release -p bloom-simulator --bin compose -- \
      runtime/server/demo/composed.definition.json \
      bloom-demo-composed 10000 20260709 \
      runtime/server/demo/composed.pkg \
      runtime/server/demo/composed.presentation.json

# Run the authoritative runtime game server on the composed demo package.
runtime-serve-composed: composed-demo-pkg
    BLOOM_RUNTIME_PACKAGE=runtime/server/demo/composed.pkg cargo run --release -p bloom-runtime-server

# Serve every studio-built package from var/packages (dir mode, lazy load).
runtime-serve-packages:
    BLOOM_RUNTIME_PACKAGES=var/packages cargo run --release -p bloom-runtime-server

# Print the direct play-mode URL. Start the two servers first (separate shells):
#   just runtime-serve            # authoritative server on 9000+offset
#   just serve-runtime-client     # Pixi client on 4300+offset
# then open the printed URL from any LAN browser.
runtime-playmode:
    @off="${BLOOM_PORT_OFFSET:-0}"; echo "Open: http://<dev-host>:$((4300 + off))/?server=http://<dev-host>:$((9000 + off))"
