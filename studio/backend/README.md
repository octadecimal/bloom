# Bloom Studio Backend

Shared, multi-user, multi-room LLM chat. FastAPI + Socket.IO + MongoDB + Langchain.

## Run

    just mongo-up            # ensure native MongoDB service is running
    cd studio/backend && uv sync
    cp .env.example .env     # fill OPENROUTER_API_KEY
    just backend-serve       # uvicorn on :8000

## Test

    just mongo-up
    just backend-test        # unit + integration (needs Mongo)
    just backend-e2e         # two-client realtime suite (needs Mongo)

## Provider modes

Set `PROVIDER_MODE=live` (default) or `PROVIDER_MODE=replay` to choose between real
APIs and recorded-real cassette fixtures. The `/health` endpoint returns
`{"status":"ok","providerMode":"live"|"replay"}` and the frontend `mode-badge` reflects
it. Run `just preflight` before handing the app to a human — it reads `/health` and
exits non-zero with a clear error if the backend is in replay mode. Run
`just record-fixtures` to regenerate cassettes from live providers (requires
`OPENROUTER_API_KEY` + ComfyUI on :8188).

## E2e tiers

- **`just e2e`** — deterministic replay tier; start `just backend-serve-replay` first.
  Requires a backend running on :8000 — the suite's global-setup performs a `/health`
  parity check and will fail fast if no backend is reachable (this is intentional).
- **`just e2e-live`** — same specs against live providers; on-demand only, never CI.
