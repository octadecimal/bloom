//! The append-only audit seam (architecture §9). Each served round appends one
//! record naming the package, the seed drawn, the engine version, the bet, a
//! timestamp, and the outcome — so any historical round is bit-reproducible.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditRecord {
    pub package_id: String,
    pub package_version: u32,
    pub mechanic: String,
    pub math_engine_version: String,
    pub seed: u64,
    pub bet: u64,
    pub timestamp_ms: u128,
    /// The served outcome (mechanic-tagged).
    pub outcome: crate::wire::OutcomeWire,
}

pub trait AuditSink: Send + Sync {
    fn append(&self, rec: &AuditRecord) -> std::io::Result<()>;
}

/// Durable append-only sink: one JSON line per record. Opens the file in append
/// mode per write (create-if-missing) so the sink is cheap to share and never
/// truncates.
pub struct JsonlAuditSink {
    path: PathBuf,
}

impl JsonlAuditSink {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        JsonlAuditSink { path: path.into() }
    }
}

impl AuditSink for JsonlAuditSink {
    fn append(&self, rec: &AuditRecord) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut line = serde_json::to_string(rec).map_err(std::io::Error::other)?;
        line.push('\n');
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        f.write_all(line.as_bytes())
    }
}

/// In-memory sink for tests.
pub struct MemoryAuditSink {
    records: Mutex<Vec<AuditRecord>>,
}

impl Default for MemoryAuditSink {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryAuditSink {
    pub fn new() -> Self {
        MemoryAuditSink {
            records: Mutex::new(Vec::new()),
        }
    }
    pub fn records(&self) -> Vec<AuditRecord> {
        self.records.lock().unwrap().clone()
    }
}

impl AuditSink for MemoryAuditSink {
    fn append(&self, rec: &AuditRecord) -> std::io::Result<()> {
        self.records.lock().unwrap().push(rec.clone());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(seed: u64) -> AuditRecord {
        use bloom_math::mechanics::slots::{
            evaluate, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
        };
        let model = SlotModel {
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
        };
        AuditRecord {
            package_id: "pkg".into(),
            package_version: 1,
            mechanic: "slots@1".into(),
            math_engine_version: "0.0.0".into(),
            seed,
            bet: 1,
            timestamp_ms: 123,
            outcome: crate::wire::OutcomeWire::from_round(&evaluate(&model, seed)),
        }
    }

    #[test]
    fn jsonl_sink_appends_one_line_per_record() {
        let dir = std::env::temp_dir().join(format!("bloom-audit-{}", std::process::id()));
        let path = dir.join("audit.jsonl");
        let _ = std::fs::remove_file(&path);
        let sink = JsonlAuditSink::new(&path);

        sink.append(&sample(10)).unwrap();
        sink.append(&sample(20)).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);

        let r0: AuditRecord = serde_json::from_str(lines[0]).unwrap();
        let r1: AuditRecord = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(r0.seed, 10);
        assert_eq!(r1.seed, 20);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_sink_collects_records() {
        let sink = MemoryAuditSink::new();
        sink.append(&sample(1)).unwrap();
        sink.append(&sample(2)).unwrap();
        let recs = sink.records();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[1].seed, 2);
    }
}
