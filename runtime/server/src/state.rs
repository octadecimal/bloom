//! Server startup state: the verified package + decoded model, plus the
//! runtime seams. A package that fails to verify or decode aborts boot loudly.

use crate::audit::AuditSink;
use crate::draw::Draw;
use bloom_math::mechanics::composed;
use bloom_math::mechanics::slots::{from_payload, SlotModel};
use bloom_package::{verify_and_load, PackageContent, PackageError};
use ed25519_dalek::{SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

/// The development verifying key (matches the dev signing key `[7u8; 32]`).
/// Real signing-key management is a deferred sign-off-gate concern.
pub fn dev_verifying_key() -> VerifyingKey {
    SigningKey::from_bytes(&[7u8; 32]).verifying_key()
}

#[derive(Debug)]
pub enum StartupError {
    BadPackage(PackageError),
    BadPayload(postcard::Error),
    /// Composed payload failed to parse or compile (umbrella §3: hard errors
    /// before any evaluation).
    BadDefinition(String),
    UnknownMechanic(String),
    Io(std::io::Error),
    EmptyPool,
}

/// The decoded, family-dispatched math artifact.
pub enum LoadedGame {
    Slots(SlotModel),
    Composed(Box<composed::CompiledGame>),
}

/// Lowercase-hex SHA-256 of the math payload — the audit's `definition_hash`
/// (SP2 spec §5.4). Family-agnostic: it hashes whatever bytes are signed.
pub fn payload_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// One verified + decoded package (per-package slice of the old AppState).
pub struct LoadedPackage {
    pub package: PackageContent,
    pub game: LoadedGame,
    pub definition_hash: String,
}

impl LoadedPackage {
    /// Verify the package bytes against the dev key, then decode its model.
    pub fn from_bytes(bytes: &[u8]) -> Result<LoadedPackage, StartupError> {
        let package =
            verify_and_load(bytes, &dev_verifying_key()).map_err(StartupError::BadPackage)?;
        if package.seeds.is_empty() {
            return Err(StartupError::EmptyPool);
        }
        let game = match package.envelope.mechanic.as_str() {
            "slots@1" => LoadedGame::Slots(
                from_payload(&package.math_payload).map_err(StartupError::BadPayload)?,
            ),
            "composed@1" => {
                let def = composed::from_payload(&package.math_payload)
                    .map_err(|e| StartupError::BadDefinition(e.to_string()))?;
                let compiled = composed::compile(&def)
                    .map_err(|errs| StartupError::BadDefinition(format!("{errs:?}")))?;
                LoadedGame::Composed(Box::new(compiled))
            }
            other => return Err(StartupError::UnknownMechanic(other.to_string())),
        };
        let definition_hash = payload_hash(&package.math_payload);
        Ok(LoadedPackage {
            package,
            game,
            definition_hash,
        })
    }
}

pub struct CachedPackage {
    pub mtime: SystemTime,
    pub loaded: Arc<LoadedPackage>,
}

pub enum PackageSource {
    Single(Arc<LoadedPackage>),
    Dir {
        dir: PathBuf,
        cache: RwLock<HashMap<String, CachedPackage>>,
    },
}

#[derive(Debug)]
pub enum ResolveError {
    /// Dir mode requires an explicit package id on every request.
    PackageParamRequired,
    NotFound(String),
    Load(StartupError),
}

pub struct AppState {
    pub source: PackageSource,
    pub draw: Box<dyn Draw>,
    pub audit: Box<dyn AuditSink>,
}

impl AppState {
    /// Verify the package bytes against the dev key, then decode its model.
    pub fn from_package_bytes(
        bytes: &[u8],
        draw: Box<dyn Draw>,
        audit: Box<dyn AuditSink>,
    ) -> Result<AppState, StartupError> {
        Ok(AppState {
            source: PackageSource::Single(Arc::new(LoadedPackage::from_bytes(bytes)?)),
            draw,
            audit,
        })
    }

    /// Load the package file named by `config`, verify + decode it.
    pub fn load(config: &crate::config::ServerConfig) -> Result<AppState, StartupError> {
        if let Some(dir) = &config.packages_dir {
            // Dir mode: nothing is read at boot; packages load lazily per request.
            return Ok(AppState {
                source: PackageSource::Dir {
                    dir: dir.clone(),
                    cache: RwLock::new(HashMap::new()),
                },
                draw: Box::new(crate::draw::OsRngDraw),
                audit: Box::new(crate::audit::JsonlAuditSink::new(config.audit_path.clone())),
            });
        }
        let bytes = std::fs::read(&config.package_path).map_err(StartupError::Io)?;
        AppState::from_package_bytes(
            &bytes,
            Box::new(crate::draw::OsRngDraw),
            Box::new(crate::audit::JsonlAuditSink::new(config.audit_path.clone())),
        )
    }

    /// Resolve the package a request addresses. Single mode ignores the param.
    /// `refresh` (handshake) stats the file and reloads a rebuilt package; spins
    /// serve from cache so a play session keeps its package.
    pub fn resolve(
        &self,
        package: Option<&str>,
        refresh: bool,
    ) -> Result<Arc<LoadedPackage>, ResolveError> {
        match &self.source {
            PackageSource::Single(lp) => Ok(lp.clone()),
            PackageSource::Dir { dir, cache } => {
                let id = package.ok_or(ResolveError::PackageParamRequired)?;
                // Trust boundary: the id becomes a file name. Allow only safe chars.
                if id.is_empty()
                    || !id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                {
                    return Err(ResolveError::NotFound(id.to_string()));
                }
                if !refresh {
                    if let Some(c) = cache.read().unwrap().get(id) {
                        return Ok(c.loaded.clone());
                    }
                }
                let path = dir.join(format!("{id}.pkg"));
                let mtime = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .map_err(|_| ResolveError::NotFound(id.to_string()))?;
                if let Some(c) = cache.read().unwrap().get(id) {
                    if c.mtime == mtime {
                        return Ok(c.loaded.clone());
                    }
                }
                let bytes =
                    std::fs::read(&path).map_err(|e| ResolveError::Load(StartupError::Io(e)))?;
                let loaded =
                    Arc::new(LoadedPackage::from_bytes(&bytes).map_err(ResolveError::Load)?);
                cache.write().unwrap().insert(
                    id.to_string(),
                    CachedPackage {
                        mtime,
                        loaded: loaded.clone(),
                    },
                );
                Ok(loaded)
            }
        }
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
            symbols: vec![SymbolDef {
                id: 0,
                role: SymbolRole::Normal,
            }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry {
                    symbol: 0,
                    count: 3,
                    payout: 2,
                }],
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
        let state = AppState::from_package_bytes(
            &good_package_bytes(),
            Box::new(crate::draw::OsRngDraw),
            Box::new(crate::audit::MemoryAuditSink::new()),
        )
        .expect("loads");
        let PackageSource::Single(lp) = &state.source else {
            panic!("single mode");
        };
        assert_eq!(lp.package.envelope.package_id, "pkg-test");
        assert!(matches!(&lp.game, LoadedGame::Slots(m) if m.reels.len() == 3));
    }

    #[test]
    fn rejects_a_tampered_package() {
        let mut bytes = good_package_bytes();
        let i = 8 + 2 + 1; // inside the signed content region
        bytes[i] ^= 0xFF;
        assert!(matches!(
            AppState::from_package_bytes(
                &bytes,
                Box::new(crate::draw::OsRngDraw),
                Box::new(crate::audit::MemoryAuditSink::new()),
            ),
            Err(StartupError::BadPackage(_))
        ));
    }

    #[test]
    fn rejects_a_zero_seed_package() {
        let content = PackageContent {
            envelope: Envelope {
                package_id: "pkg-empty".into(),
                package_version: 1,
                mechanic: "slots@1".into(),
            },
            math_payload: to_payload(&tiny_model()),
            seeds: vec![],
            presentation: Vec::new(),
        };
        let bytes = build(&content, &dev_signing_key());
        assert!(matches!(
            AppState::from_package_bytes(
                &bytes,
                Box::new(crate::draw::OsRngDraw),
                Box::new(crate::audit::MemoryAuditSink::new()),
            ),
            Err(StartupError::EmptyPool)
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
            AppState::from_package_bytes(
                &content_bytes,
                Box::new(crate::draw::OsRngDraw),
                Box::new(crate::audit::MemoryAuditSink::new()),
            ),
            Err(StartupError::BadPackage(_))
        ));
    }

    use serde_json::json;

    fn tiny_composed_def_json() -> serde_json::Value {
        json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "reels", "type": "reels@1",
                  "config": { "strips": [[0],[0],[0]], "rows": 1,
                              "symbols": [{"id":0,"role":"normal"}],
                              "paylines": [[0,0,0]],
                              "paytable": { "entries": [{"symbol":0,"count":3,"payout":5}] } } }
            ],
            "states": [
                { "id": "base", "bindings": [ { "mechanic": "reels" } ],
                  "steps": { "budget": 1 }, "script": [ { "invoke": "reels.spin" } ] }
            ],
            "start": "base",
            "transitions": [],
            "caps": { "max_steps": 50 }
        })
    }

    fn composed_package_bytes(def_json: &serde_json::Value, mechanic: &str) -> Vec<u8> {
        let content = PackageContent {
            envelope: Envelope {
                package_id: "pkg-composed-test".into(),
                package_version: 1,
                mechanic: mechanic.into(),
            },
            math_payload: serde_json::to_vec(def_json).unwrap(),
            seeds: vec![1, 2, 3],
            presentation: Vec::new(),
        };
        build(&content, &dev_signing_key())
    }

    #[test]
    fn loads_and_compiles_a_composed_package() {
        let bytes = composed_package_bytes(&tiny_composed_def_json(), "composed@1");
        let state = AppState::from_package_bytes(
            &bytes,
            Box::new(crate::draw::OsRngDraw),
            Box::new(crate::audit::MemoryAuditSink::new()),
        )
        .expect("composed package loads");
        let PackageSource::Single(lp) = &state.source else {
            panic!("single mode");
        };
        assert!(matches!(lp.game, LoadedGame::Composed(_)));
        assert_eq!(lp.definition_hash.len(), 64);
        assert!(lp.definition_hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn rejects_an_unknown_mechanic_family() {
        let bytes = composed_package_bytes(&tiny_composed_def_json(), "mystery@9");
        assert!(matches!(
            AppState::from_package_bytes(
                &bytes,
                Box::new(crate::draw::OsRngDraw),
                Box::new(crate::audit::MemoryAuditSink::new()),
            ),
            Err(StartupError::UnknownMechanic(m)) if m == "mystery@9"
        ));
    }

    #[test]
    fn rejects_a_composed_package_with_an_invalid_definition() {
        let mut def = tiny_composed_def_json();
        def["start"] = json!("nope");
        let bytes = composed_package_bytes(&def, "composed@1");
        assert!(matches!(
            AppState::from_package_bytes(
                &bytes,
                Box::new(crate::draw::OsRngDraw),
                Box::new(crate::audit::MemoryAuditSink::new()),
            ),
            Err(StartupError::BadDefinition(_))
        ));
    }

    #[test]
    fn payload_hash_matches_the_sha256_test_vector() {
        // SHA-256("abc") — FIPS 180-2 appendix B.1.
        assert_eq!(
            payload_hash(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
