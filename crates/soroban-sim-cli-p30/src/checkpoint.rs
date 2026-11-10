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
//! Nor is an evicted entry's value: a read of one evicted since the pin with
//! no earlier change recording it fails rather than serving it as absent.

use anyhow::{anyhow, bail, Result};
use soroban_env_host::xdr::{ConfigSettingId, LedgerHeader, LedgerKey, LedgerKeyConfigSetting};
use soroban_sim_core::ledger_entry_to_ledger_key;
use soroban_sim_core::session::{FetchedBatch, LedgerSource, StoredEntry};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use crate::meta::{v2, Rollback};
use crate::rpc::{RpcClient, RpcError};

/// How far behind RPC's latest ledger a pin may be: catching up reads the
/// close meta of every ledger since (a few MB each on mainnet).
pub const MAX_CATCH_UP_LEDGERS: u32 = 720;

/// Waits before re-reading from an RPC node that answered from before the pin
/// (load-balanced RPCs lag each other by a ledger or so; ledgers close every
/// ~5 seconds).
const LAG_RETRIES: [Duration; 4] = [Duration::from_secs(1), Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(4)];

/// Run `read` until `caught_up` accepts its answer, waiting `retries` between
/// attempts; returns the last answer either way.
fn until_caught_up<T>(retries: &[Duration], mut read: impl FnMut() -> Result<T>, caught_up: impl Fn(&T) -> bool) -> Result<T> {
    let mut answer = read()?;
    for wait in retries {
        if caught_up(&answer) {
            break;
        }
        std::thread::sleep(*wait);
        answer = read()?;
    }
    Ok(answer)
}

/// A `getLedgers` from `start` that a node not yet at `start` refused
/// (stellar-rpc answers InvalidParams naming its latest ledger) reads as no
/// ledgers yet; every other error stands.
fn not_closed_yet_as_empty<T>(start: u32, read: Result<Vec<T>>) -> Result<Vec<T>> {
    let behind = |e: &anyhow::Error| {
        let error = &e.downcast_ref::<RpcError>()?.error;
        if error["code"].as_i64() != Some(-32602) {
            return None;
        }
        let message = error["message"].as_str()?;
        let rest = &message[message.find("latest ledger: ")? + "latest ledger: ".len()..];
        let latest: u32 = rest[..rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len())].parse().ok()?;
        Some(latest < start)
    };
    match read {
        Err(e) if behind(&e) == Some(true) => Ok(vec![]),
        r => r,
    }
}

/// Run `read` until it answers at or after `pin`; an answer from before the
/// pin cannot be rolled back to it.
fn served_from_pin(pin: u32, retries: &[Duration], read: impl FnMut() -> Result<FetchedBatch>) -> Result<FetchedBatch> {
    let batch = until_caught_up(retries, read, |b| b.served_at_ledger >= pin)?;
    if batch.served_at_ledger < pin {
        bail!(
            "RPC answered getLedgerEntries at ledger {} after {} retries, still before the pinned ledger {pin}; its value at the pin is unknown",
            batch.served_at_ledger,
            retries.len()
        );
    }
    Ok(batch)
}

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
        let head = served_from_pin(pin, &LAG_RETRIES, || source.rpc.ledger_entries(std::slice::from_ref(&window)))?;
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

    /// Feed the rollback every ledger through `ledger`.
    fn catch_up(&self, ledger: u32) -> Result<()> {
        let mut rollback = self.rollback.borrow_mut();
        while rollback.indexed_through() < ledger {
            let next = rollback.indexed_through() + 1;
            let batch = until_caught_up(
                &LAG_RETRIES,
                || not_closed_yet_as_empty(next, self.rpc.ledgers(next, 5.min(ledger - next + 1))),
                |b| !b.is_empty(),
            )?;
            if batch.is_empty() {
                bail!("{} returned no ledgers from {next} after {} retries", self.rpc.url, LAG_RETRIES.len());
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
            let head = served_from_pin(s.pin, &LAG_RETRIES, || s.rpc.ledger_entries(&missing))?;
            s.catch_up(head.served_at_ledger)?;
            let mut found: HashMap<LedgerKey, StoredEntry> = HashMap::new();
            for e in head.entries {
                found.insert(ledger_entry_to_ledger_key(&e.entry)?, e);
            }
            let rollback = s.rollback.borrow();
            let mut cache = s.cache.borrow_mut();
            for key in missing {
                let head_value = found.remove(&key);
                let entry = match rollback.value_at_pin(&key)? {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(served_at_ledger: u32) -> FetchedBatch {
        FetchedBatch { served_at_ledger, entries: vec![] }
    }

    #[test]
    fn a_lagging_node_is_re_read_until_it_reaches_the_pin() {
        let mut answers = vec![99, 99, 100].into_iter();
        let mut reads = 0;
        let got = served_from_pin(100, &[Duration::ZERO; 4], || {
            reads += 1;
            Ok(batch(answers.next().unwrap()))
        })
        .unwrap();
        assert_eq!((got.served_at_ledger, reads), (100, 3));
    }

    #[test]
    fn a_node_that_stays_behind_the_pin_fails_the_read() {
        let mut reads = 0;
        let err = match served_from_pin(100, &[Duration::ZERO; 2], || {
            reads += 1;
            Ok(batch(98))
        }) {
            Ok(_) => panic!("served a read from before the pin"),
            Err(e) => e.to_string(),
        };
        assert_eq!(reads, 3);
        assert!(err.contains("ledger 98") && err.contains("pinned ledger 100"), "{err}");
    }

    #[test]
    fn an_empty_ledger_batch_from_a_lagging_node_is_re_read() {
        let mut answers = vec![vec![], vec![], vec![105u32]].into_iter();
        let got = until_caught_up(&[Duration::ZERO; 4], || Ok(answers.next().unwrap()), |b| !b.is_empty()).unwrap();
        assert_eq!(got, vec![105]);
        let mut reads = 0;
        let got = until_caught_up(
            &[Duration::ZERO; 2],
            || {
                reads += 1;
                Ok(Vec::<u32>::new())
            },
            |b| !b.is_empty(),
        )
        .unwrap();
        assert!(got.is_empty());
        assert_eq!(reads, 3);
    }

    fn get_ledgers_error(code: i64, latest: u32) -> anyhow::Error {
        RpcError {
            method: "getLedgers".into(),
            error: serde_json::json!({
                "code": code,
                "message": format!("start ledger must be between the oldest ledger: 10 and the latest ledger: {latest} for this rpc instance."),
            }),
        }
        .into()
    }

    #[test]
    fn a_node_refusing_a_start_past_its_latest_ledger_is_re_read() {
        let mut answers = vec![Err(get_ledgers_error(-32602, 104)), Err(get_ledgers_error(-32602, 104)), Ok(vec![105u32])].into_iter();
        let got = until_caught_up(&[Duration::ZERO; 4], || not_closed_yet_as_empty(105, answers.next().unwrap()), |b| !b.is_empty()).unwrap();
        assert_eq!(got, vec![105]);
    }

    #[test]
    fn other_get_ledgers_errors_are_not_retried() {
        for err in [get_ledgers_error(-32602, 200), get_ledgers_error(-32603, 104), anyhow!("getLedgers to rpc: connection refused")] {
            let mut reads = 0;
            let mut answers = vec![Err(err)].into_iter();
            let got = until_caught_up(
                &[Duration::ZERO; 4],
                || {
                    reads += 1;
                    not_closed_yet_as_empty::<u32>(105, answers.next().unwrap())
                },
                |b| !b.is_empty(),
            );
            assert!(got.is_err());
            assert_eq!(reads, 1);
        }
    }

    #[test]
    fn an_answer_at_or_after_the_pin_is_read_once() {
        let mut reads = 0;
        let got = served_from_pin(100, &[Duration::ZERO; 4], || {
            reads += 1;
            Ok(batch(103))
        })
        .unwrap();
        assert_eq!((got.served_at_ledger, reads), (103, 1));
    }
}
