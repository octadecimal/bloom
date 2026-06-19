//! `bloom-package` — the signed, frozen game-package container.
//! See `docs/superpowers/specs/2026-06-18-trusted-package-design.md`.
//!
//! A mechanic-agnostic container: it carries a mechanic's data as opaque byte
//! blobs without understanding them. Pure — all functions take and return byte
//! slices; file I/O happens in the caller, never here.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// 8-byte magic prefix identifying a Bloom package.
const MAGIC: &[u8; 8] = b"BLOOMPKG";
/// Wire-format version (distinct from `Envelope.package_version`).
const FORMAT_VERSION: u16 = 1;
/// Bytes of the fixed frame fields: magic (8) + format_version (2) + signature (64).
const FRAME_OVERHEAD: usize = MAGIC.len() + 2 + Signature::BYTE_SIZE;

/// Identity + provenance the container itself needs. Mechanic-specific data is NOT here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    /// Stable identifier for this game artifact.
    pub package_id: String,
    /// The artifact's own version (back-compat per umbrella §8).
    pub package_version: u32,
    /// Which mechanic + version the payload targets, e.g. "slots@1".
    pub mechanic: String,
}

/// Everything that is signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageContent {
    pub envelope: Envelope,
    /// Opaque; interpreted by the math engine.
    pub math_payload: Vec<u8>,
    /// The curated seed pool.
    pub seeds: Vec<u64>,
    /// Opaque; forwarded by the server to the client renderer.
    pub presentation: Vec<u8>,
}

/// Why a package failed to verify or load.
#[derive(Debug, PartialEq, Eq)]
pub enum PackageError {
    BadMagic,
    UnsupportedFormatVersion(u16),
    /// Too short to contain frame + signature.
    Truncated,
    BadSignature,
    /// postcard failure.
    Deserialize(String),
}

/// Serialize + sign. Returns the full on-disk package bytes. Pure (no I/O).
pub fn build(content: &PackageContent, signing_key: &SigningKey) -> Vec<u8> {
    let content_bytes =
        postcard::to_stdvec(content).expect("PackageContent is always serializable");
    let signature = signing_key.sign(&content_bytes);

    let mut out = Vec::with_capacity(FRAME_OVERHEAD + content_bytes.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&content_bytes);
    out.extend_from_slice(&signature.to_bytes());
    out
}

/// Check magic + format_version, verify the signature over the content, then
/// deserialize. Rejects tampered, unsigned, wrong-key, bad-magic, or
/// unsupported-format packages. Pure (no I/O).
pub fn verify_and_load(
    bytes: &[u8],
    verifying_key: &VerifyingKey,
) -> Result<PackageContent, PackageError> {
    if bytes.len() < FRAME_OVERHEAD {
        return Err(PackageError::Truncated);
    }

    let (magic, rest) = bytes.split_at(MAGIC.len());
    if magic != MAGIC {
        return Err(PackageError::BadMagic);
    }

    let (version_bytes, rest) = rest.split_at(2);
    let format_version = u16::from_le_bytes([version_bytes[0], version_bytes[1]]);
    if format_version != FORMAT_VERSION {
        return Err(PackageError::UnsupportedFormatVersion(format_version));
    }

    // The remaining bytes are the content followed by the trailing signature.
    let sig_start = rest.len() - Signature::BYTE_SIZE;
    let (content_bytes, signature_bytes) = rest.split_at(sig_start);

    let signature =
        Signature::from_slice(signature_bytes).map_err(|_| PackageError::BadSignature)?;
    verifying_key
        .verify(content_bytes, &signature)
        .map_err(|_| PackageError::BadSignature)?;

    // Signature is valid before we ever feed bytes to the deserializer.
    postcard::from_bytes(content_bytes).map_err(|e| PackageError::Deserialize(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed test keypair so tests are deterministic (no key generation).
    fn test_signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn sample_content() -> PackageContent {
        PackageContent {
            envelope: Envelope {
                package_id: "pkg-001".to_string(),
                package_version: 1,
                mechanic: "slots@1".to_string(),
            },
            math_payload: vec![0xDE, 0xAD, 0xBE, 0xEF],
            seeds: vec![1, 2, 3, 9_999_999_999],
            presentation: vec![1, 2, 3],
        }
    }

    #[test]
    fn round_trip_returns_equal_content() {
        let sk = test_signing_key();
        let vk = sk.verifying_key();
        let content = sample_content();

        let bytes = build(&content, &sk);
        let loaded = verify_and_load(&bytes, &vk).expect("valid package should load");

        assert_eq!(loaded, content);
    }

    #[test]
    fn build_is_byte_deterministic() {
        let sk = test_signing_key();
        let content = sample_content();

        assert_eq!(build(&content, &sk), build(&content, &sk));
    }

    #[test]
    fn tampered_content_is_rejected() {
        let sk = test_signing_key();
        let vk = sk.verifying_key();
        let mut bytes = build(&sample_content(), &sk);

        // Flip a byte inside the content region (past the frame header).
        let i = MAGIC.len() + 2 + 1;
        bytes[i] ^= 0xFF;

        assert_eq!(
            verify_and_load(&bytes, &vk),
            Err(PackageError::BadSignature)
        );
    }

    #[test]
    fn wrong_key_is_rejected() {
        let sk = test_signing_key();
        let bytes = build(&sample_content(), &sk);

        let other_vk = SigningKey::from_bytes(&[9u8; 32]).verifying_key();

        assert_eq!(
            verify_and_load(&bytes, &other_vk),
            Err(PackageError::BadSignature)
        );
    }

    #[test]
    fn bad_magic_is_rejected() {
        let sk = test_signing_key();
        let vk = sk.verifying_key();
        let mut bytes = build(&sample_content(), &sk);

        bytes[0] ^= 0xFF;

        assert_eq!(verify_and_load(&bytes, &vk), Err(PackageError::BadMagic));
    }

    #[test]
    fn unsupported_format_version_is_rejected() {
        let sk = test_signing_key();
        let vk = sk.verifying_key();
        let mut bytes = build(&sample_content(), &sk);

        // Overwrite the u16 format_version field with an unknown value.
        let unknown = 999u16.to_le_bytes();
        bytes[MAGIC.len()] = unknown[0];
        bytes[MAGIC.len() + 1] = unknown[1];

        assert_eq!(
            verify_and_load(&bytes, &vk),
            Err(PackageError::UnsupportedFormatVersion(999))
        );
    }

    #[test]
    fn truncated_input_is_rejected() {
        let sk = test_signing_key();
        let vk = sk.verifying_key();
        let bytes = build(&sample_content(), &sk);

        let short = &bytes[..FRAME_OVERHEAD - 1];

        assert_eq!(verify_and_load(short, &vk), Err(PackageError::Truncated));
    }
}
