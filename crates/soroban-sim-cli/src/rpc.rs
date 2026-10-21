//! A blocking Stellar RPC client limited to READ methods. A rehearsal must
//! never submit anything, so `sendTransaction` is not just unused: the client
//! refuses every method outside [`READ_ONLY_METHODS`].

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use soroban_env_host::xdr::{
    LedgerCloseMeta, LedgerEntry, LedgerEntryData, LedgerEntryExt, LedgerHeader, LedgerKey,
    Limits, ReadXdr, WriteXdr,
};
use soroban_sim_core::session::{FetchedBatch, LedgerSource, StoredEntry};
use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

/// The only methods this client will call.
pub const READ_ONLY_METHODS: &[&str] =
    &["getLatestLedger", "getNetwork", "getLedgerEntries", "simulateTransaction", "getVersionInfo", "getHealth", "getLedgers"];

pub struct RpcClient {
    pub url: String,
    calls: Cell<u32>,
    throttled: Cell<u32>,
}

pub struct LatestLedger {
    pub sequence: u32,
    pub protocol_version: u32,
    pub header: LedgerHeader,
}

/// The ledgers an RPC still serves history for.
pub struct Retention {
    pub latest: u32,
    pub oldest: u32,
}

/// One closed ledger from `getLedgers`.
pub struct ClosedLedger {
    pub sequence: u32,
    pub meta: LedgerCloseMeta,
}

impl RpcClient {
    pub fn new(url: &str) -> Self {
        Self { url: url.to_string(), calls: Cell::new(0), throttled: Cell::new(0) }
    }

    pub fn calls(&self) -> u32 {
        self.calls.get()
    }

    /// Retries after HTTP 429 or a 5xx.
    pub fn throttled(&self) -> u32 {
        self.throttled.get()
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value> {
        if !READ_ONLY_METHODS.contains(&method) {
            bail!("refusing RPC method {method}: a rehearsal only reads from the network");
        }
        self.calls.set(self.calls.get() + 1);
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        // Public RPCs rate-limit: back off exponentially up to about a minute.
        let mut wait = 1;
        let response: Value = loop {
            match ureq::post(&self.url).timeout(Duration::from_secs(60)).send_json(body.clone()) {
                Ok(r) => break r.into_json().with_context(|| format!("{method}: decoding the response"))?,
                Err(ureq::Error::Status(code, _)) if (code == 429 || code >= 500) && wait <= 32 => {
                    self.throttled.set(self.throttled.get() + 1);
                    std::thread::sleep(Duration::from_secs(wait));
                    wait *= 2;
                }
                Err(e) => return Err(e).with_context(|| format!("{method} to {}", self.url)),
            }
        };
        if let Some(err) = response.get("error") {
            bail!("{method}: {err}");
        }
        response.get("result").cloned().ok_or_else(|| anyhow!("{method}: no result"))
    }

    pub fn latest_ledger(&self) -> Result<LatestLedger> {
        let r = self.call("getLatestLedger", json!({}))?;
        let header_xdr = r["headerXdr"].as_str().ok_or_else(|| anyhow!("getLatestLedger: no headerXdr (RPC too old?)"))?;
        Ok(LatestLedger {
            sequence: r["sequence"].as_u64().ok_or_else(|| anyhow!("getLatestLedger: no sequence"))? as u32,
            protocol_version: r["protocolVersion"].as_u64().ok_or_else(|| anyhow!("getLatestLedger: no protocolVersion"))? as u32,
            header: LedgerHeader::from_xdr(B64.decode(header_xdr)?, Limits::none())?,
        })
    }

    pub fn network_passphrase(&self) -> Result<String> {
        let r = self.call("getNetwork", json!({}))?;
        r["passphrase"].as_str().map(str::to_string).ok_or_else(|| anyhow!("getNetwork: no passphrase"))
    }

    /// `getLedgerEntries` at the RPC's latest ledger (it serves no history).
    /// Evicted entries come back with `liveUntilLedgerSeq = 0`, so archived
    /// stays distinct from absent.
    pub fn ledger_entries(&self, keys: &[LedgerKey]) -> Result<FetchedBatch> {
        let encoded: Vec<String> = keys.iter().map(|k| Ok(B64.encode(k.to_xdr(Limits::none())?))).collect::<Result<_>>()?;
        let r = self.call("getLedgerEntries", json!({ "keys": encoded }))?;
        let mut entries = vec![];
        for e in r["entries"].as_array().into_iter().flatten() {
            let data = LedgerEntryData::from_xdr(B64.decode(e["xdr"].as_str().unwrap_or_default())?, Limits::none())?;
            // `extXdr` carries the entry's sponsorship; RPCs that predate it
            // only serve unsponsored entries correctly.
            let ext = match e["extXdr"].as_str() {
                Some(x) => LedgerEntryExt::from_xdr(B64.decode(x)?, Limits::none())?,
                None => LedgerEntryExt::V0,
            };
            entries.push(StoredEntry {
                entry: LedgerEntry { last_modified_ledger_seq: e["lastModifiedLedgerSeq"].as_u64().unwrap_or(0) as u32, data, ext },
                live_until: e["liveUntilLedgerSeq"].as_u64().map(|v| v as u32),
            });
        }
        Ok(FetchedBatch { served_at_ledger: r["latestLedger"].as_u64().unwrap_or(0) as u32, entries })
    }

    /// The ledger range the RPC keeps history (`getLedgers`) for.
    pub fn retention(&self) -> Result<Retention> {
        let r = self.call("getHealth", json!({}))?;
        let n = |f: &str| r[f].as_u64().map(|v| v as u32).ok_or_else(|| anyhow!("getHealth: no {f}"));
        Ok(Retention { latest: n("latestLedger")?, oldest: n("oldestLedger")? })
    }

    /// Closed ledgers with their full close meta, from `start`, at most
    /// `limit` of them (fewer when the RPC has not closed them yet).
    pub fn ledgers(&self, start: u32, limit: u32) -> Result<Vec<ClosedLedger>> {
        let r = self.call("getLedgers", json!({ "startLedger": start, "pagination": { "limit": limit } }))?;
        let mut out = vec![];
        for l in r["ledgers"].as_array().into_iter().flatten() {
            let field = |f: &str| l[f].as_str().ok_or_else(|| anyhow!("getLedgers: no {f}"));
            out.push(ClosedLedger {
                sequence: l["sequence"].as_u64().ok_or_else(|| anyhow!("getLedgers: no sequence"))? as u32,
                meta: LedgerCloseMeta::from_xdr(B64.decode(field("metadataXdr")?)?, Limits::none())?,
            });
        }
        Ok(out)
    }

    /// `simulateTransaction` of an envelope (base64 XDR). Simulation never
    /// submits anything.
    pub fn simulate_transaction(&self, envelope_xdr: &str) -> Result<Value> {
        self.call("simulateTransaction", json!({ "transaction": envelope_xdr }))
    }
}

/// The fork's base: lazily fetched RPC state.
pub struct RpcSource(pub Rc<RpcClient>);

impl LedgerSource for RpcSource {
    fn fetch(&self, keys: &[LedgerKey]) -> Result<FetchedBatch> {
        self.0.ledger_entries(keys)
    }

    fn describe(&self) -> String {
        format!("RPC {} (getLedgerEntries at its latest ledger)", self.0.url)
    }
}
