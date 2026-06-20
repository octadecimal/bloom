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
