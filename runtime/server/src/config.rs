//! Server configuration, sourced from environment with sane defaults.

use std::net::SocketAddr;
use std::path::PathBuf;

pub struct ServerConfig {
    pub package_path: PathBuf,
    pub packages_dir: Option<PathBuf>,
    pub audit_path: PathBuf,
    pub bind_addr: SocketAddr,
}

impl ServerConfig {
    pub fn from_env() -> ServerConfig {
        let base: u16 = std::env::var("BLOOM_RUNTIME_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(9000);
        let offset: u16 = std::env::var("BLOOM_PORT_OFFSET")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let port = base.saturating_add(offset);

        let package_path = std::env::var("BLOOM_RUNTIME_PACKAGE")
            .unwrap_or_else(|_| "runtime/server/demo/demo.pkg".to_string())
            .into();
        let audit_path = std::env::var("BLOOM_RUNTIME_AUDIT")
            .unwrap_or_else(|_| "runtime/server/var/audit.jsonl".to_string())
            .into();
        let packages_dir = std::env::var("BLOOM_RUNTIME_PACKAGES")
            .ok()
            .map(PathBuf::from);

        ServerConfig {
            package_path,
            packages_dir,
            audit_path,
            bind_addr: SocketAddr::from(([0, 0, 0, 0], port)),
        }
    }
}
