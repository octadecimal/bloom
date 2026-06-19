# ADR 0001 — Dev orchestration & studio datastore

- **Date:** 2026-06-19
- **Status:** Accepted (direction only — no infrastructure wired yet)
- **Context doc:** [`../superpowers/specs/2026-06-18-bloom-platform-architecture-design.md`](../superpowers/specs/2026-06-18-bloom-platform-architecture-design.md)

## Context

Bloom needs a story for standing up local dev services, and a database is coming.
The architecture is **two planes + a trusted core** (spec §3): `studio/` is the
AI-driven authoring plane, `runtime/` is the zero-AI authoritative plane, and the
data layer must respect that split. Today only `trusted/math` (a library) and
`studio/frontend` (a native Vite server) exist; `studio/backend`, `runtime/server`,
and any DB are still stubs in the spec.

The triggering question was whether to adopt **Tilt** to orchestrate dev, with Docker
for a database later.

## Decision

### 1. Dev orchestration: `justfile` + Docker Compose. Not Tilt (yet).

- The **`justfile` stays the cross-cutting orchestration seam** (architecture §13).
- **Docker Compose** owns containerized infra (the DB now; backend/runtime services
  later, when they are real). Conventional, Windows-friendly, no surprises.
- **Native dev servers stay native** (Vite now; `uv` / `cargo` later) for a fast inner
  loop with no rebuild-into-container tax on Windows.
- **Tilt is rejected for now**, because its core value — live-update into pods and
  dev/prod parity with a cluster — depends on a **Kubernetes target, which Bloom does
  not have or plan** (containers, but no k8s). Without k8s, Tilt is a dashboard over
  Compose, and the extra moving part is not worth it while there is essentially one
  service to run.
- **Tilt remains a no-throwaway upgrade path.** It speaks Docker Compose natively, so
  if the multi-service dev loop later becomes painful (log juggling, rebuild latency
  across 3–4 services), Tilt can be layered on top of the same `compose.yaml` then.

### 2. Studio datastore: MongoDB (studio plane only).

- **`studio/backend`** (Python / FastAPI + Langchain) uses **MongoDB**. Its data —
  design intent, AI-agent outputs, evolving art / ComfyUI metadata, authoring-session
  state — is variable, nested, AI-produced, and fast-churning. Document storage fits,
  and it avoids schema-migration friction where the schema genuinely churns. The
  Mongo (Atlas) vector-search path also keeps future RAG/embeddings over design docs
  open.

### 3. Provisioning is deferred.

- **No `compose.yaml` is written yet.** The first real consumer (`studio/backend`)
  does not exist, so this ADR records *direction only*. The Mongo + `justfile` wiring
  lands when `studio/backend` does.

## Explicitly open (decided NOT to decide here)

- **Runtime audit-log persistence is OUT OF SCOPE for this ADR.** The `runtime/`
  append-only audit log (spec §9) is the compliance / dispute / certification artifact;
  its schema is deliberately **rigid** (a certified record), so the "avoid migrations"
  rationale does **not** transfer to it. Its store must be chosen on durability and
  compliance grounds in the **runtime sub-spec**, where the spec already parks it as an
  open decision (§18).
- **Do not default the runtime audit store to MongoDB** just because the studio uses it.
  The two-plane law (§3) applies to the data layer: the planes may use different stores,
  and keeping them separate is the expected outcome, not an inconsistency.

## Revisit triggers

- Adopt **Tilt-over-Compose** if/when ≥3 long-running services make the dev loop painful.
- Reconsider **Mongo for the studio** if the authoring side turns out to need strong
  relational/transactional guarantees it serves poorly.
- The **runtime store** decision happens in the runtime sub-spec — not here.
