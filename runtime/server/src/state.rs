//! Server startup state: the verified package + decoded model, plus the
//! runtime seams. A package that fails to verify or decode aborts boot loudly.

use bloom_math::mechanics::slots::{from_payload, SlotModel};
use bloom_package::{verify_and_load, PackageContent, PackageError};
use ed25519_dalek::{SigningKey, VerifyingKey};

/// The development verifying key (matches the dev signing key `[7u8; 32]`).
/// Real signing-key management is a deferred sign-off-gate concern.
pub fn dev_verifying_key() -> VerifyingKey {
    SigningKey::from_bytes(&[7u8; 32]).verifying_key()
}

#[derive(Debug)]
pub enum StartupError {
    BadPackage(PackageError),
    BadPayload(postcard::Error),
    Io(std::io::Error),
}

pub struct AppState {
    pub package: PackageContent,
    pub model: SlotModel,
}

impl AppState {
    /// Verify the package bytes against the dev key, then decode its model.
    // TASK-1 FORM: signature is `from_package_bytes(bytes: &[u8])`.
    // Tasks 2–3 will widen this to take `draw: Box<dyn Draw>` and `audit: Box<dyn AuditSink>`.
    pub fn from_package_bytes(bytes: &[u8]) -> Result<AppState, StartupError> {
        let package =
            verify_and_load(bytes, &dev_verifying_key()).map_err(StartupError::BadPackage)?;
        let model = from_payload(&package.math_payload).map_err(StartupError::BadPayload)?;
        Ok(AppState { package, model })
    }

    /// Load the package file named by `config`, verify + decode it.
    pub fn load(config: &crate::config::ServerConfig) -> Result<AppState, StartupError> {
        let bytes = std::fs::read(&config.package_path).map_err(StartupError::Io)?;
        AppState::from_package_bytes(&bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{
        to_payload, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
    };
    use bloom_package::{build, Envelope, PackageContent};

    fn dev_signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn tiny_model() -> SlotModel {
        SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry { symbol: 0, count: 3, payout: 2 }],
            },
            bonuses: vec![],
        }
    }

    fn good_package_bytes() -> Vec<u8> {
        let content = PackageContent {
            envelope: Envelope {
                package_id: "pkg-test".into(),
                package_version: 1,
                mechanic: "slots@1".into(),
            },
            math_payload: to_payload(&tiny_model()),
            seeds: vec![1, 2, 3, 4, 5],
            presentation: Vec::new(),
        };
        build(&content, &dev_signing_key())
    }

    #[test]
    fn loads_and_decodes_a_valid_package() {
        let state = AppState::from_package_bytes(&good_package_bytes()).expect("loads");
        assert_eq!(state.package.envelope.package_id, "pkg-test");
        assert_eq!(state.model.reels.len(), 3);
    }

    #[test]
    fn rejects_a_tampered_package() {
        let mut bytes = good_package_bytes();
        let i = 8 + 2 + 1; // inside the signed content region
        bytes[i] ^= 0xFF;
        assert!(matches!(
            AppState::from_package_bytes(&bytes),
            Err(StartupError::BadPackage(_))
        ));
    }

    #[test]
    fn rejects_a_wrong_key_package() {
        let content_bytes = {
            let other = SigningKey::from_bytes(&[9u8; 32]);
            let content = PackageContent {
                envelope: Envelope {
                    package_id: "pkg-x".into(),
                    package_version: 1,
                    mechanic: "slots@1".into(),
                },
                math_payload: to_payload(&tiny_model()),
                seeds: vec![1],
                presentation: Vec::new(),
            };
            build(&content, &other)
        };
        assert!(matches!(
            AppState::from_package_bytes(&content_bytes),
            Err(StartupError::BadPackage(_))
        ));
    }
}
