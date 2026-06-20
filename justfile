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

# TypeScript / frontend
ts-test:
    npx nx run-many -t test

e2e:
    npx playwright test --config=studio/frontend/playwright.config.ts

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

# Run the backend with the fake LLM provider for browser e2e (no API key needed).
backend-serve-fake:
    cd studio/backend && LLM_BACKEND=fake uv run uvicorn app.main:app --port 8000

# Browser e2e for the chat plugin. Start `just backend-serve-fake` in another
# terminal first (Playwright starts only the frontend). Local-only; not in CI.
e2e-chat:
    npx playwright test --config=studio/frontend/playwright.config.ts llm-chat
