//! The `checkpoint` fork: one consistent ledger instead of head reads.
//!
//! RPC's `getLedgerEntries` only serves its latest ledger, so a `head` fork
//! that reads lazily over minutes mixes ledgers (the drift report shows it).
//! A checkpoint fork pins a ledger and rolls every read back to it: entries
//! come from RPC at its latest ledger, then every ledger closed since the pin
//! is read through `getLedgers` and each entry takes the before-image of its
//! first change after the pin. Entries nothing changed are already as they
//! were. The result is exactly the pinned ledger's state, however long the
//! session runs, as long as RPC still serves the ledgers since the pin.
//!
//! One value is not in any ledger's meta: the Soroban state-size window that
//! sets the rent rate, which core rewrites every sample period at ledger
//! close. The pin must therefore be no older than the window's last change;
//! the window is read once, when the fork opens, and served as it was then.

use anyhow::{anyhow, bail, Result};
use soroban_env_host::xdr::{ConfigSettingId, LedgerHeader, LedgerKey, LedgerKeyConfigSetting};
use soroban_sim_core::ledger_entry_to_ledger_key;
use soroban_sim_core::session::{FetchedBatch, LedgerSource, StoredEntry};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::meta::{v2, Rollback};
use crate::rpc::RpcClient;

/// How far behind RPC's latest ledger a pin may be: catching up reads the
/// close meta of every ledger since (a few MB each on mainnet).
pub const MAX_CATCH_UP_LEDGERS: u32 = 720;

pub struct CheckpointSource {
    rpc: Rc<RpcClient>,
    pin: u32,
    rollback: RefCell<Rollback>,
    /// Every answer so far: values at the pin never change, so forks share them.
    cache: RefCell<HashMap<LedgerKey, Option<StoredEntry>>>,
}

/// The pinned ledger: its header and the source that serves its state.
pub struct Pinned {
    pub source: Rc<CheckpointSource>,
    pub header: LedgerHeader,
}

impl CheckpointSource {
    /// Pin `ledger` (default: RPC's latest).
    pub fn open(rpc: Rc<RpcClient>, ledger: Option<u32>) -> Result<Pinned> {
        let retention = rpc.retention()?;
        let pin = ledger.unwrap_or(retention.latest);
        if pin > retention.latest {
            bail!("ledger {pin} has not closed yet (latest {})", retention.latest);
        }
        if pin < retention.oldest {
            bail!("{} keeps ledgers {}..={}; ledger {pin} is older", rpc.url, retention.oldest, retention.latest);
        }
        if retention.latest - pin > MAX_CATCH_UP_LEDGERS {
            bail!(
                "ledger {pin} is {} ledgers behind {}; a checkpoint fork reads every ledger since, so pin one at most {MAX_CATCH_UP_LEDGERS} behind",
                retention.latest - pin,
                rpc.url
            );
        }
        let pinned = rpc.ledgers(pin, 1)?;
        let meta = pinned.first().filter(|l| l.sequence == pin).ok_or_else(|| anyhow!("{} did not return ledger {pin}", rpc.url))?;
        let header = v2(&meta.meta)?.ledger_header.header.clone();
        let source = Rc::new(Self { rpc, pin, rollback: RefCell::new(Rollback::new(pin)), cache: Default::default() });
        // The rent-rate window, read now while it is still the pin's.
        let window = LedgerKey::ConfigSetting(LedgerKeyConfigSetting { config_setting_id: ConfigSettingId::LiveSorobanStateSizeWindow });
        let head = source.rpc.ledger_entries(std::slice::from_ref(&window))?;
        let entry = head.entries.into_iter().next().ok_or_else(|| anyhow!("the network has no state-size window"))?;
        if entry.entry.last_modified_ledger_seq > pin {
            bail!(
                "the rent-rate window changed at ledger {} after the pin {pin}, and no ledger meta records its old value; pin ledger {} or later",
                entry.entry.last_modified_ledger_seq,
                entry.entry.last_modified_ledger_seq
            );
        }
        source.cache.borrow_mut().insert(window, Some(entry));
        Ok(Pinned { source, header })
    }

    pub fn pin(&self) -> u32 {
        self.pin
    }

    /// Feed the rollback every ledger through `ledger`.
    fn catch_up(&self, ledger: u32) -> Result<()> {
        let mut rollback = self.rollback.borrow_mut();
        while rollback.indexed_through() < ledger {
            let next = rollback.indexed_through() + 1;
            let batch = self.rpc.ledgers(next, 5.min(ledger - next + 1))?;
            if batch.is_empty() {
                bail!("{} returned no ledgers from {next}", self.rpc.url);
            }
            for l in &batch {
                rollback.add(v2(&l.meta)?)?;
            }
        }
        Ok(())
    }
}

/// Serves a shared [`CheckpointSource`] to each session forked from it.
pub struct CheckpointLedger(pub Rc<CheckpointSource>);

impl LedgerSource for CheckpointLedger {
    fn fetch(&self, keys: &[LedgerKey]) -> Result<FetchedBatch> {
        let s = &self.0;
        let missing: Vec<LedgerKey> = keys.iter().filter(|k| !s.cache.borrow().contains_key(*k)).cloned().collect();
        if !missing.is_empty() {
            let head = s.rpc.ledger_entries(&missing)?;
            s.catch_up(head.served_at_ledger)?;
            let mut found: HashMap<LedgerKey, StoredEntry> = HashMap::new();
            for e in head.entries {
                found.insert(ledger_entry_to_ledger_key(&e.entry)?, e);
            }
            let rollback = s.rollback.borrow();
            let mut cache = s.cache.borrow_mut();
            for key in missing {
                let head_value = found.remove(&key);
                let entry = match rollback.value_at_pin(&key) {
                    Some(before) => before,
                    None => head_value.as_ref().map(|e| e.entry.clone()),
                };
                let value = match entry {
                    None => None,
                    Some(entry) => {
                        let live_until = if matches!(key, LedgerKey::ContractData(_) | LedgerKey::ContractCode(_)) {
                            match rollback.live_until_at_pin(&key)? {
                                Some(t) => t,
                                None => head_value.as_ref().and_then(|e| e.live_until),
                            }
                        } else {
                            None
                        };
                        Some(StoredEntry { entry, live_until })
                    }
                };
                cache.insert(key, value);
            }
        }
        let cache = s.cache.borrow();
        Ok(FetchedBatch { served_at_ledger: s.pin, entries: keys.iter().filter_map(|k| cache.get(k).cloned().flatten()).collect() })
    }

    fn describe(&self) -> String {
        format!("RPC {} pinned at ledger {} (checkpoint: every read rolled back to it through later ledgers' close meta)", self.0.rpc.url, self.0.pin)
    }
}
