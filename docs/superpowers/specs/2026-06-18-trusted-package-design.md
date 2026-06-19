# `trusted/package` — Game-Package Format Design

- **Date:** 2026-06-18
- **Status:** Approved (design); ready for an implementation plan
- **Parent:** `docs/superpowers/specs/2026-06-18-bloom-platform-architecture-design.md` (§8, §18)
- **Component:** `trusted/package` — crate `bloom-package`

This sub-project resolves the two package decisions the umbrella spec deliberately
deferred (§18): **how a game package is structured/serialized, and how it is signed.**

---

## 1. What this is

`bloom-package` defines the **game package** — the signed, frozen artifact that crosses
the studio → runtime gate. It is a **mechanic-agnostic container**: it carries a
mechanic's data without understanding it. The **simulator** (in `studio/`) builds and
signs packages; the **game server** (in `runtime/`) verifies and reads them.

The crate is **pure**: its functions take and return byte slices. **All file I/O happens
in the caller**, never inside the crate — consistent with `trusted/` purity rules.

---

## 2. Locked decisions

1. **Mechanic-agnostic, opaque payloads.** The container is written and certified once.
   Mechanic-specific data rides as **opaque byte blobs** the container never parses:
   - `math_payload` — interpreted only by the **math engine**.
   - `presentation` — forwarded by the server to the **client renderer**.
   Adding a future mechanic never reopens this crate. `bloom-package` therefore depends
   on **neither `bloom-math` nor any mechanic**.

2. **Server-mediated; Rust-only readers.** Only Rust touches the package file — the
   simulator writes it, the server reads it. The **client never reads a package**; it
   receives presentation data as ordinary JSON from the server's API. This keeps the
   untrusted client away from the signed artifact and means the format does **not** need
   to be cross-language.

3. **Serialization: `postcard`** (serde-based, compact, deterministic wire format) —
   deterministic bytes are exactly what canonical signing needs, and it is small for the
   large seed pool.

4. **Integrity: Ed25519** (`ed25519-dalek`). The simulator signs the content bytes; the
   server verifies with the public key. Signatures are deterministic (RFC 8032).
   **Hand-rolling crypto is out of the question** — a vetted, audited crate is the correct,
   certifiable choice.

5. **`package` takes external dependencies, unlike `math`.** The math kernel is
   deliberately dependency-free for determinism. `bloom-package` depends on `serde`,
   `postcard`, and `ed25519-dalek`. This is a deliberate, defensible departure scoped to
   this crate (crypto and serialization are exactly what it is for). The crate remains
   deterministic and free of floats, clock, and I/O.

---

## 3. Structure

```rust
/// Identity + provenance the container itself needs. Mechanic-specific data is NOT here.
pub struct Envelope {
    pub package_id: String,      // stable identifier for this game artifact
    pub package_version: u32,    // the artifact's own version (back-compat per umbrella §8)
    pub mechanic: String,        // e.g. "slots@1" — which mechanic + version the payload targets
}

/// Everything that is signed.
pub struct PackageContent {
    pub envelope: Envelope,
    pub math_payload: Vec<u8>,   // opaque; interpreted by the math engine
    pub seeds: Vec<u64>,         // the curated seed pool
    pub presentation: Vec<u8>,   // opaque; forwarded by the server to the client renderer
}
```

**On-disk frame:**

```
┌────────────┬────────────────┬───────────────────────────┬──────────────────────┐
│ magic (8)  │ format_version │ content (postcard bytes)   │ signature (64, Ed25519)│
│ b"BLOOMPKG"│ u16            │ = postcard(PackageContent) │ over `content`         │
└────────────┴────────────────┴───────────────────────────┴──────────────────────┘
```

`format_version` is the **wire-format** version (distinct from `Envelope.package_version`,
which versions the game artifact). The signature covers exactly the `content` bytes.

---

## 4. Public API

```rust
/// Serialize + sign. Returns the full on-disk package bytes. Pure (no I/O).
pub fn build(content: &PackageContent, signing_key: &SigningKey) -> Vec<u8>;

/// Check magic + format_version, verify the signature over the content, then
/// deserialize. Rejects tampered, unsigned, wrong-key, bad-magic, or
/// unsupported-format packages. Pure (no I/O).
pub fn verify_and_load(
    bytes: &[u8],
    verifying_key: &VerifyingKey,
) -> Result<PackageContent, PackageError>;

pub enum PackageError {
    BadMagic,
    UnsupportedFormatVersion(u16),
    Truncated,              // too short to contain frame + signature
    BadSignature,
    Deserialize(String),    // postcard failure
}
```

`SigningKey` / `VerifyingKey` are `ed25519-dalek` types. **Key management — generation,
storage, rotation — is out of scope**; the API only consumes a key the caller supplies.

`verify_and_load` MUST verify the signature **before** deserializing, so malformed/hostile
content is never fed to the deserializer with an invalid signature.

---

## 5. Threat model / what signing guarantees

- A package whose content was altered after signing → `BadSignature`.
- A package signed by the wrong key (not the operator's trusted key) → `BadSignature`.
- A truncated/garbage file → `Truncated` / `BadMagic` / `UnsupportedFormatVersion`.
- The **client never parses a package**, so the untrusted client cannot be tricked by a
  malformed artifact — it only ever sees server-vetted JSON.

Not in this crate's threat model: key compromise, replay/freshness, and authorization
(who may publish) — those live at the operator/server layer.

---

## 6. Determinism & purity

- `build` is deterministic: same `PackageContent` + same key → byte-identical output
  (postcard is deterministic; Ed25519 signatures are deterministic per RFC 8032).
- No floats, no clock, no randomness, no I/O inside the crate. Callers in `studio/` and
  `runtime/` do file I/O at the edges.

---

## 7. Out of scope (built elsewhere / later)

- **Key management** (generation, storage, rotation) — operator/server concern.
- **The concrete `SlotModel` ↔ `math_payload` bytes encoding** — defined by the math
  engine / simulator (this crate only carries opaque bytes).
- **The presentation manifest schema** — defined by the client renderer / mechanic (this
  crate only carries opaque bytes; the server forwards them).
- **The server's client-facing API** (how presentation JSON is served) — the `runtime/server`
  sub-project.
- **Richer cert/provenance metadata** (achieved RTP, sim-report references, approver) —
  added to `Envelope` when the simulator and sign-off gate are built; the format versioning
  is the mechanism for that growth.

---

## 8. Build slice (this round's deliverable)

The `bloom-package` crate with:

1. `Envelope`, `PackageContent`, `PackageError` (with `serde` derives where needed).
2. `build` — frame + postcard + Ed25519 sign.
3. `verify_and_load` — frame check + signature verify + deserialize.

**Tests (TDD):**

- **Round-trip:** `build` then `verify_and_load` with the matching key returns an equal
  `PackageContent` (including opaque payloads and the full seed pool).
- **Byte-determinism:** `build` of the same content + key twice yields identical bytes.
- **Tamper rejection:** flipping any byte of a built package → `BadSignature`.
- **Wrong-key rejection:** verifying with a different public key → `BadSignature`.
- **Bad magic:** corrupt the magic prefix → `BadMagic`.
- **Unsupported format version:** set an unknown `format_version` → `UnsupportedFormatVersion`.
- **Truncated:** bytes shorter than frame + signature → `Truncated`.

Tests use a fixed test keypair (constructed from fixed bytes) so they are deterministic.

---

## 9. Open / deferred decisions

- Whether `package_id` should be a typed id (ULID/UUID) rather than `String` — defer to the
  simulator sub-project, which generates ids; `String` is sufficient for the format.
- Compression of the seed pool — defer until pool sizes prove it necessary (YAGNI).
- A documented, byte-exact format spec for the certification lab — produced when the format
  stabilizes; `postcard`'s layout is deterministic and will be documented then.
