# studio/ — the authoring plane

This is **where games are built**, and the **only** plane where AI lives.

- AI-driven, human-in-the-loop, fast-churning. **Not certified.**
- May depend on `trusted/`. **`trusted/` must never depend on `studio/`.**
- Languages here: React/TypeScript (`frontend/`), Python + FastAPI + Langchain
  (`backend/`, all AI orchestration), Rust (`simulator/`).
- Output: a signed **game package**, produced by the simulator and approved by a
  human at the sign-off gate before it can cross into `runtime/`.
