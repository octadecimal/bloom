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

serve-frontend:
    npx nx serve frontend
