// contracts/greenpay-contract/src/resource_measurement.rs
//
// Test-only helpers for measuring the resource consumption of contract calls.
//
// WHY: contract calls must not silently blow past Soroban's on-chain resource
// limits (CPU instructions, memory, and the read/write ledger footprint) as
// real-world state accumulates. The functions in this module let the resource
// budget tests record, per entrypoint, how many host CPU instructions and
// memory bytes a call consumes (via the test budget) and how much of the
// recording ledger footprint it touches (reads vs writes, with an XDR byte
// estimate of the keys).
//
// LIMITATIONS (documented for anyone reading the headroom table):
//   * CPU/mem figures come from running the contract natively as Rust inside
//     the test harness, which *underestimates* the WASM execution costs that
//     a real network invocation pays. Treat the absolute numbers here as
//     regression gates and rough relative guidance, not authoritative fees.
//   * This SDK's `ContractCostType` has no storage read/write variants, so
//     ledger-touch counts and byte estimates are derived from the recording
//     footprint (`Storage::with_recording_footprint`) instead of the budget
//     cost-trackers.
//
// Authoritative numbers for a specific transaction are obtained by simulating
// the *built* WASM against a live RPC and reading `sorobanData.resources`
// (instructions, read/write bytes) from the preflight — see
// docs/resource-budgeting.md.
#![allow(dead_code)]

extern crate alloc;
extern crate std;

use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use soroban_sdk::xdr::{Limits, WriteXdr};
use soroban_sdk::{testutils::budget::Budget, Env};

/// How many bytes of a fresh recording footprint pre-existed before any
/// measurement. Every fixture creates a fresh `Env`, so the footprint recorded
/// across the *entire* env lifetime already includes instance contract data
/// touched by `initialize`/`register_project` etc. We only diff our window.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ResourceUsage {
    /// The entrypoint being measured (e.g. "donate", "has_nft", "transfer").
    pub function: String,
    /// A human description of the state the call ran against, e.g.
    /// "1 donor, 200 tokens owned" — mostly for readability of the report.
    pub state: String,
    /// Host CPU instructions consumed by this call (native, underestimated).
    pub cpu_insns: u64,
    /// Host memory bytes consumed by this call (native, underestimated).
    pub mem_bytes: u64,
    /// Distinct ledger keys read (ReadOnly or upgraded to ReadWrite) *by this
    /// call*, from the recording-footprint delta.
    pub ledger_reads: u64,
    /// Distinct ledger keys written (ReadWrite) *by this call*.
    pub ledger_writes: u64,
    /// Sum of XDR-encoded sizes (bytes) of the keys read by this call. This is
    /// the key-size component of the read-write footprint, not the full
    /// ledger-entry cost (which also includes each value/TTL).
    pub read_bytes: u64,
    /// Sum of XDR-encoded sizes (bytes) of the keys written by this call.
    pub write_bytes: u64,
}

/// A single (key_size_bytes, is_write) record extracted from the recording
/// footprint. Determined via the Debug string of the (unnameable, internal)
/// `AccessType` to avoid depending on the host's private type names.
#[derive(Clone, Debug, PartialEq)]
struct FootprintRow {
    key_bytes: u64,
    is_write: bool,
}

impl FootprintRow {
    fn new(key_bytes: u64, access_type_debug: &str) -> Self {
        Self {
            key_bytes,
            is_write: access_type_debug == "ReadWrite",
        }
    }
}

/// Read the current set of recorded footprint keys for `env` as primitive rows.
/// The recording footprint accumulates over the env lifetime, so callers diff
/// the rows before vs. after the call they care about.
///
/// Note: the recording footprint in this SDK records BOTH read-only and
/// read/write access, so the read counts/bytes below can be nonzero. They are
/// the set of distinct keys this call first touched as read-only within the
/// measured window (keys already recorded as read/write during setup are not
/// re-counted). They are not authoritative fee figures: billing for the
/// read-write footprint also includes each value and its TTL, not just the key
/// bytes. The regression gate therefore keys on CPU/MEMORY deltas and WRITE
/// counts, which are the dominant on-chain cost drivers; do not treat the read
/// columns as authoritative.
fn snapshot_footprint(env: &Env) -> Vec<FootprintRow> {
    let host = env.host();
    let rows = host.with_mut_storage(|storage| {
        let mut out = Vec::new();
        // storage.footprint is the (pub) recording Footprint whose .0 is the
        // MeteredOrdMap<Rc<LedgerKey>, AccessType, _>. Neither Host/Storage nor
        // the AccessType type is nameable from the contract crate, so we walk
        // the map by inference with `for (k, v) in &...` and build primitives.
        for (key, access) in &storage.footprint.0 {
            let key_bytes: u64 = key
                .as_ref()
                .to_xdr(xdr_limits())
                .map(|b| b.len() as u64)
                .unwrap_or(0);
            out.push(FootprintRow::new(
                key_bytes,
                &alloc::format!("{:?}", access),
            ));
        }
        Ok(out)
    });
    rows.unwrap_or_default()
}

/// XDR limits loose enough to serialize any ledger key we actually produce.
fn xdr_limits() -> Limits {
    Limits::none()
}

/// Snapshot of the two monotonic budget consume counters, used to compute a
/// per-call delta (the budget does not expose a reset-for-winnow primitive).
#[derive(Clone, Copy, Debug, Default)]
pub struct BudgetSnapshot {
    pub cpu: u64,
    pub mem: u64,
}

impl BudgetSnapshot {
    pub fn take(env: &Env) -> Self {
        let b: Budget = env.budget();
        Self {
            cpu: b.cpu_instruction_cost(),
            mem: b.memory_bytes_cost(),
        }
    }

    pub fn delta(&self, other: &BudgetSnapshot) -> (u64, u64) {
        (
            other.cpu.saturating_sub(self.cpu),
            other.mem.saturating_sub(self.mem),
        )
    }
}

/// Collapse footprint rows into (reads, writes, read_bytes, write_bytes).
fn summarize(rows: &[FootprintRow]) -> (u64, u64, u64, u64) {
    let mut reads = 0u64;
    let mut writes = 0u64;
    let mut read_bytes = 0u64;
    let mut write_bytes = 0u64;
    for r in rows {
        if r.is_write {
            writes += 1;
            write_bytes += r.key_bytes;
        } else {
            reads += 1;
            read_bytes += r.key_bytes;
        }
    }
    (reads, writes, read_bytes, write_bytes)
}

/// The delta between two footprint row sets: how many rows (and their bytes)
/// are present in `after` but not in `before`. Since recording mode only ever
/// adds entries, this is the per-call touch set.
fn footprint_delta(before: &[FootprintRow], after: &[FootprintRow]) -> (u64, u64, u64, u64) {
    let mut before_map: BTreeMap<(u64, bool), u64> = BTreeMap::new();
    for r in before {
        *before_map.entry((r.key_bytes, r.is_write)).or_insert(0) += 1;
    }
    let added: Vec<FootprintRow> = after
        .iter()
        .filter(|r| {
            let key = (r.key_bytes, r.is_write);
            let count = before_map.get(&key).copied().unwrap_or(0);
            if count > 0 {
                before_map.insert(key, count - 1);
                false
            } else {
                true
            }
        })
        .cloned()
        .collect();
    summarize(&added)
}

/// Measure one contract call. `name`/`state` describe the entrypoint for the
/// report; `f` is the closure that performs the call via the contract client.
/// Returns the ResourceUsage recorded for exactly one invocation of `f`.
pub fn measure<F, T>(env: &Env, name: &str, state: &str, f: F) -> (ResourceUsage, T)
where
    F: FnOnce() -> T,
{
    let budget_before = BudgetSnapshot::take(env);
    let footprint_before = snapshot_footprint(env);

    let result = f();

    let budget_after = BudgetSnapshot::take(env);
    let footprint_after = snapshot_footprint(env);

    let (cpu_insns, mem_bytes) = budget_before.delta(&budget_after);
    let (ledger_reads, ledger_writes, read_bytes, write_bytes) =
        footprint_delta(&footprint_before, &footprint_after);

    let usage = ResourceUsage {
        function: name.to_string(),
        state: state.to_string(),
        cpu_insns,
        mem_bytes,
        ledger_reads,
        ledger_writes,
        read_bytes,
        write_bytes,
    };
    (usage, result)
}

/// Render a human-readable table of usages (one row per entry) to stdout for
/// the `print`/update mode of the budget tests.
pub fn print_report(usages: &[ResourceUsage]) {
    std::println!();
    std::println!(
        "{:<22} {:<34} {:>10} {:>12} {:>8} {:>8} {:>10} {:>10}",
        "FUNCTION",
        "STATE",
        "CPU_INSNS",
        "MEM_BYTES",
        "READS",
        "WRITES",
        "READ_B",
        "WRITE_B"
    );
    std::println!("{}", "-".repeat(130));
    for u in usages {
        std::println!(
            "{:<22} {:<34} {:>10} {:>12} {:>8} {:>8} {:>10} {:>10}",
            u.function,
            u.state,
            u.cpu_insns,
            u.mem_bytes,
            u.ledger_reads,
            u.ledger_writes,
            u.read_bytes,
            u.write_bytes
        );
    }
    std::println!();
}

/// Serialize a collection of usages to pretty JSON (the baseline file format).
pub fn to_json(usages: &[ResourceUsage]) -> String {
    serde_json::to_string_pretty(usages).expect("serialize resource usage")
}

/// Parse a baseline file (the JSON emitted by `to_json`).
pub fn from_json(blob: &str) -> Vec<ResourceUsage> {
    serde_json::from_str(blob).expect("parse resource usage baseline")
}
