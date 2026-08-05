from fastapi import FastAPI

app = FastAPI(title="matte-bench")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
