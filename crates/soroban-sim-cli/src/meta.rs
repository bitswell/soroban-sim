//! Ledger close meta as a change history. Every closed ledger records, for
//! each entry it changed, the entry before and after (`State` then `Updated`
//! or `Removed`, or `Created`, or `Restored`). Indexed by key, a window of
//! ledgers answers "what was this entry at that point?" exactly, for any
//! point inside the window, which RPC's head-only `getLedgerEntries` cannot.
//! A `checkpoint` fork pins every read to one ledger with it; a replay
//! rebuilds what a real transaction saw when it applied.

use anyhow::{anyhow, bail, Result};
use sha2::{Digest, Sha256};
use soroban_env_host::xdr::{
    FeeBumpTransactionInnerTx, GeneralizedTransactionSet, LedgerCloseMeta, LedgerCloseMetaV2, LedgerEntry,
    LedgerEntryChange, LedgerEntryChanges, LedgerEntryData, LedgerKey, LedgerKeyTtl, Limits, TransactionEnvelope,
    TransactionPhase, TtlEntry, TxSetComponent, WriteXdr,
};
use soroban_sim_core::ledger_entry_to_ledger_key;
use soroban_sim_core::session::envelope_hash;
use std::collections::HashMap;

/// When in a ledger close a change happened, in the order core makes them:
/// every fee charge, then each transaction in apply order, then every
/// refund, then upgrades.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pos {
    pub ledger: u32,
    pub phase: Phase,
    pub index: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Phase {
    FeeProcessing,
    Apply,
    PostApplyFees,
    Upgrades,
}

impl Pos {
    /// The moment transaction `index` of `ledger` starts applying.
    pub fn apply(ledger: u32, index: u32) -> Self {
        Self { ledger, phase: Phase::Apply, index }
    }

    /// After every change of `ledger`.
    pub fn end_of(ledger: u32) -> Self {
        Self { ledger, phase: Phase::Upgrades, index: u32::MAX }
    }
}

/// One change to one key.
#[derive(Clone, Debug)]
struct KeyChange {
    pos: Pos,
    /// `None`: the key was absent.
    before: Option<LedgerEntry>,
    after: Option<LedgerEntry>,
}

/// Every change a window of consecutive ledgers made, by key.
#[derive(Default)]
pub struct ChangeIndex {
    changes: HashMap<LedgerKey, Vec<KeyChange>>,
    first: Option<u32>,
    last: Option<u32>,
}

impl ChangeIndex {
    /// The first and last ledger indexed.
    pub fn range(&self) -> Option<(u32, u32)> {
        Some((self.first?, self.last?))
    }

    pub fn contains_ledger(&self, seq: u32) -> bool {
        self.range().is_some_and(|(a, b)| a <= seq && seq <= b)
    }

    /// Add the next ledger of the window.
    pub fn add(&mut self, meta: &LedgerCloseMetaV2) -> Result<()> {
        let seq = meta.ledger_header.header.ledger_seq;
        if let Some(last) = self.last {
            if seq != last + 1 {
                bail!("ledger {seq} does not follow ledger {last} in the change index");
            }
        }
        self.first.get_or_insert(seq);
        self.last = Some(seq);
        for (i, t) in meta.tx_processing.iter().enumerate() {
            let i = i as u32;
            self.add_changes(&t.fee_processing, Pos { ledger: seq, phase: Phase::FeeProcessing, index: i })?;
            for changes in apply_changes(&t.tx_apply_processing) {
                self.add_changes(changes, Pos::apply(seq, i))?;
            }
            self.add_changes(&t.post_tx_apply_fee_processing, Pos { ledger: seq, phase: Phase::PostApplyFees, index: i })?;
        }
        for (i, u) in meta.upgrades_processing.iter().enumerate() {
            self.add_changes(&u.changes, Pos { ledger: seq, phase: Phase::Upgrades, index: i as u32 })?;
        }
        Ok(())
    }

    fn add_changes(&mut self, changes: &LedgerEntryChanges, pos: Pos) -> Result<()> {
        let mut state: HashMap<LedgerKey, LedgerEntry> = HashMap::new();
        for c in changes.iter() {
            let (key, before, after) = match c {
                LedgerEntryChange::State(e) => {
                    state.insert(ledger_entry_to_ledger_key(e)?, e.clone());
                    continue;
                }
                LedgerEntryChange::Created(e) => {
                    let key = ledger_entry_to_ledger_key(e)?;
                    let before = state.remove(&key);
                    (key, before, Some(e.clone()))
                }
                LedgerEntryChange::Updated(e) => {
                    let key = ledger_entry_to_ledger_key(e)?;
                    let before = state.remove(&key).ok_or_else(|| anyhow!("ledger {}: an update without a prior state", pos.ledger))?;
                    (key, Some(before), Some(e.clone()))
                }
                LedgerEntryChange::Removed(k) => {
                    let before = state.remove(k).ok_or_else(|| anyhow!("ledger {}: a removal without a prior state", pos.ledger))?;
                    (k.clone(), Some(before), None)
                }
                LedgerEntryChange::Restored(e) => {
                    // The entry was archived: its value is the restored one,
                    // and its TTL had expired.
                    let key = ledger_entry_to_ledger_key(e)?;
                    let before = match &e.data {
                        LedgerEntryData::Ttl(t) => LedgerEntry { data: LedgerEntryData::Ttl(TtlEntry { live_until_ledger_seq: 0, ..t.clone() }), ..e.clone() },
                        _ => e.clone(),
                    };
                    state.insert(key.clone(), e.clone());
                    (key, Some(before), Some(e.clone()))
                }
            };
            self.changes.entry(key).or_default().push(KeyChange { pos, before, after });
        }
        Ok(())
    }

    /// The value of `key` just before `pos`, if the window decides it: the
    /// after-image of the last change before `pos`, else the before-image of
    /// the first change at or after it. `None`: the window never changed the
    /// key, so its value is whatever it was before the window (and after).
    pub fn value_before(&self, key: &LedgerKey, pos: Pos) -> Option<Option<LedgerEntry>> {
        let changes = self.changes.get(key)?;
        match changes.iter().rposition(|c| c.pos < pos) {
            Some(i) => Some(changes[i].after.clone()),
            None => Some(changes[0].before.clone()),
        }
    }

    /// The live-until ledger of a contract entry just before `pos`, if the
    /// window decides it (`Some(None)`: the TTL entry was absent).
    pub fn live_until_before(&self, key: &LedgerKey, pos: Pos) -> Result<Option<Option<u32>>> {
        Ok(self.value_before(&ttl_key(key)?, pos).map(|e| {
            e.and_then(|e| match e.data {
                LedgerEntryData::Ttl(t) => Some(t.live_until_ledger_seq),
                _ => None,
            })
        }))
    }

    /// Whether the window changed `key` at or after `pos`.
    pub fn changed_since(&self, key: &LedgerKey, pos: Pos) -> bool {
        self.changes.get(key).is_some_and(|c| c.iter().any(|c| c.pos >= pos))
    }
}

/// The TTL entry's key for a contract data or code key.
pub fn ttl_key(key: &LedgerKey) -> Result<LedgerKey> {
    Ok(LedgerKey::Ttl(LedgerKeyTtl { key_hash: soroban_env_host::xdr::Hash(Sha256::digest(key.to_xdr(Limits::none())?).into()) }))
}

/// A transaction's apply-time changes: before, each operation's, after.
pub fn apply_changes(meta: &soroban_env_host::xdr::TransactionMeta) -> Vec<&LedgerEntryChanges> {
    use soroban_env_host::xdr::TransactionMeta as M;
    match meta {
        M::V0(ops) => ops.iter().map(|o| &o.changes).collect(),
        M::V1(m) => std::iter::once(&m.tx_changes).chain(m.operations.iter().map(|o| &o.changes)).collect(),
        M::V2(m) => std::iter::once(&m.tx_changes_before).chain(m.operations.iter().map(|o| &o.changes)).chain(std::iter::once(&m.tx_changes_after)).collect(),
        M::V3(m) => std::iter::once(&m.tx_changes_before).chain(m.operations.iter().map(|o| &o.changes)).chain(std::iter::once(&m.tx_changes_after)).collect(),
        M::V4(m) => std::iter::once(&m.tx_changes_before).chain(m.operations.iter().map(|o| &o.changes)).chain(std::iter::once(&m.tx_changes_after)).collect(),
    }
}

/// The protocol 23+ close meta of a ledger.
pub fn v2(meta: &LedgerCloseMeta) -> Result<&LedgerCloseMetaV2> {
    match meta {
        LedgerCloseMeta::V2(m) => Ok(m),
        _ => Err(anyhow!("only LedgerCloseMeta v2 (protocol 23+) is supported")),
    }
}

/// One envelope of a ledger's transaction set, with the base fee of the
/// component that holds it (`None`: no discount, the full bid is charged).
pub struct SetMember {
    pub envelope: TransactionEnvelope,
    pub component_base_fee: Option<i64>,
}

/// Every envelope in a transaction set by hash, and the set's contents hash
/// (core's base PRNG seed for the ledger's Soroban transactions).
pub fn tx_set_members(set: &GeneralizedTransactionSet, network_id: [u8; 32]) -> Result<(HashMap<[u8; 32], SetMember>, [u8; 32])> {
    let contents_hash: [u8; 32] = Sha256::digest(set.to_xdr(Limits::none())?).into();
    let GeneralizedTransactionSet::V1(set) = set;
    let mut out = HashMap::new();
    let mut add = |envelope: &TransactionEnvelope, fee: Option<i64>| -> Result<()> {
        out.insert(envelope_hash(envelope, network_id)?, SetMember { envelope: envelope.clone(), component_base_fee: fee });
        Ok(())
    };
    for phase in set.phases.iter() {
        match phase {
            TransactionPhase::V0(components) => {
                for c in components.iter() {
                    let TxSetComponent::TxsetCompTxsMaybeDiscountedFee(c) = c;
                    for e in c.txs.iter() {
                        add(e, c.base_fee)?;
                    }
                }
            }
            TransactionPhase::V1(p) => {
                for stage in p.execution_stages.iter() {
                    for cluster in stage.iter() {
                        for e in cluster.iter() {
                            add(e, p.base_fee)?;
                        }
                    }
                }
            }
        }
    }
    Ok((out, contents_hash))
}

/// core's per-transaction PRNG seed: `sha256(txSetContentsHash || index)`,
/// with the transaction's index in apply order as a big-endian u64.
pub fn prng_seed(contents_hash: [u8; 32], apply_index: u32) -> [u8; 32] {
    Sha256::digest([contents_hash.as_slice(), &(apply_index as u64).to_be_bytes()].concat()).into()
}

/// Whether an envelope's (inner) transaction is a Soroban transaction.
pub fn is_soroban(envelope: &TransactionEnvelope) -> bool {
    let tx = match envelope {
        TransactionEnvelope::Tx(e) => &e.tx,
        TransactionEnvelope::TxFeeBump(e) => {
            let FeeBumpTransactionInnerTx::Tx(inner) = &e.tx.inner_tx;
            &inner.tx
        }
        TransactionEnvelope::TxV0(_) => return false,
    };
    matches!(tx.ext, soroban_env_host::xdr::TransactionExt::V1(_))
}
