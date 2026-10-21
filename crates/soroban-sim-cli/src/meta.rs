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
    TransactionMeta, TransactionPhase, TtlEntry, TxSetComponent, WriteXdr,
};
use soroban_sim_core::ledger_entry_to_ledger_key;
use soroban_sim_core::session::envelope_hash;
use std::collections::HashMap;

/// When in a ledger close a change happened, in the order core makes them:
/// every fee charge; the classic transactions in turn; then, for the Soroban
/// phase run in parallel stages, every Soroban transaction's sequence bump
/// (`preParallelApply`) before any of them executes, then their executions;
/// then every refund; then upgrades.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pos {
    pub ledger: u32,
    pub phase: Phase,
    pub index: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Phase {
    FeeProcessing,
    /// A classic transaction (or a Soroban one in a sequential phase).
    Apply,
    /// A parallel-phase Soroban transaction's `tx_changes_before`.
    SorobanPreApply,
    /// A parallel-phase Soroban transaction's execution.
    SorobanApply,
    PostApplyFees,
    Upgrades,
}

impl Pos {
    /// The moment transaction `index` of `ledger` starts executing: after
    /// every Soroban sequence bump of the ledger when `parallel`.
    pub fn executing(ledger: u32, index: u32, parallel: bool) -> Self {
        Self { ledger, phase: if parallel { Phase::SorobanApply } else { Phase::Apply }, index }
    }
}

/// One change to one key.
#[derive(Clone, Debug)]
pub struct KeyChange {
    pub pos: Pos,
    /// `None`: the key was absent.
    pub before: Option<LedgerEntry>,
    pub after: Option<LedgerEntry>,
}

/// Every change a window of consecutive ledgers made, by key.
#[derive(Default)]
pub struct ChangeIndex {
    changes: HashMap<LedgerKey, Vec<KeyChange>>,
    last: Option<u32>,
}

impl ChangeIndex {
    /// Add the next ledger of the window.
    pub fn add(&mut self, meta: &LedgerCloseMetaV2) -> Result<()> {
        let seq = meta.ledger_header.header.ledger_seq;
        if let Some(last) = self.last {
            if seq != last + 1 {
                bail!("ledger {seq} does not follow ledger {last} in the change index");
            }
        }
        self.last = Some(seq);
        for_each_change(meta, |pos, key, before, after| {
            self.changes.entry(key).or_default().push(KeyChange { pos, before, after });
        })
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

    /// Every recorded change of `key`, in order.
    pub fn changes_of(&self, key: &LedgerKey) -> &[KeyChange] {
        self.changes.get(key).map_or(&[], |c| c.as_slice())
    }

}

/// Every change a ledger close made, in the order core made them, as
/// `(when, key, before, after)` (`None`: absent): every transaction's fee
/// charge, then each transaction's apply, then every refund, then upgrades.
/// (The meta groups them by transaction instead; a fee charge's images are
/// from before any transaction of the ledger applied.) A `Restored` entry was
/// archived: its value is the restored one, and its TTL had expired (`0`).
pub fn for_each_change(meta: &LedgerCloseMetaV2, mut f: impl FnMut(Pos, LedgerKey, Option<LedgerEntry>, Option<LedgerEntry>)) -> Result<()> {
    let seq = meta.ledger_header.header.ledger_seq;
    let mut each = |changes: &LedgerEntryChanges, pos: Pos| -> Result<()> {
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
                    let before = state.remove(&key).ok_or_else(|| anyhow!("ledger {seq}: an update without a prior state"))?;
                    (key, Some(before), Some(e.clone()))
                }
                LedgerEntryChange::Removed(k) => {
                    let before = state.remove(k).ok_or_else(|| anyhow!("ledger {seq}: a removal without a prior state"))?;
                    (k.clone(), Some(before), None)
                }
                LedgerEntryChange::Restored(e) => {
                    let key = ledger_entry_to_ledger_key(e)?;
                    let before = match &e.data {
                        LedgerEntryData::Ttl(t) => LedgerEntry { data: LedgerEntryData::Ttl(TtlEntry { live_until_ledger_seq: 0, ..t.clone() }), ..e.clone() },
                        _ => e.clone(),
                    };
                    state.insert(key.clone(), e.clone());
                    (key, Some(before), Some(e.clone()))
                }
            };
            f(pos, key, before, after);
        }
        Ok(())
    };
    let parallel = parallel_soroban_phase(&meta.tx_set);
    for (i, t) in meta.tx_processing.iter().enumerate() {
        each(&t.fee_processing, Pos { ledger: seq, phase: Phase::FeeProcessing, index: i as u32 })?;
    }
    let soroban = |t: &soroban_env_host::xdr::TransactionResultMetaV1| match &t.tx_apply_processing {
        TransactionMeta::V4(m) => m.soroban_meta.is_some(),
        TransactionMeta::V3(m) => m.soroban_meta.is_some(),
        _ => false,
    };
    for (i, t) in meta.tx_processing.iter().enumerate().filter(|(_, t)| !parallel || !soroban(t)) {
        for changes in apply_changes(&t.tx_apply_processing) {
            each(changes, Pos { ledger: seq, phase: Phase::Apply, index: i as u32 })?;
        }
    }
    if parallel {
        let parallel_txs: Vec<(usize, &soroban_env_host::xdr::TransactionResultMetaV1)> =
            meta.tx_processing.iter().enumerate().filter(|(_, t)| soroban(t)).collect();
        for (i, t) in &parallel_txs {
            if let Some(before) = apply_changes(&t.tx_apply_processing).first() {
                each(before, Pos { ledger: seq, phase: Phase::SorobanPreApply, index: *i as u32 })?;
            }
        }
        for (i, t) in &parallel_txs {
            for changes in apply_changes(&t.tx_apply_processing).into_iter().skip(1) {
                each(changes, Pos { ledger: seq, phase: Phase::SorobanApply, index: *i as u32 })?;
            }
        }
    }
    for (i, t) in meta.tx_processing.iter().enumerate() {
        each(&t.post_tx_apply_fee_processing, Pos { ledger: seq, phase: Phase::PostApplyFees, index: i as u32 })?;
    }
    for (i, u) in meta.upgrades_processing.iter().enumerate() {
        each(&u.changes, Pos { ledger: seq, phase: Phase::Upgrades, index: i as u32 })?;
    }
    Ok(())
}

/// Whether the ledger's Soroban phase runs in parallel stages (protocol 23+).
pub fn parallel_soroban_phase(set: &GeneralizedTransactionSet) -> bool {
    let GeneralizedTransactionSet::V1(set) = set;
    set.phases.iter().any(|p| matches!(p, TransactionPhase::V1(_)))
}

/// Where each parallel-phase transaction ran: its stage and cluster, and its
/// footprint. core runs the clusters of a stage in parallel, each one's
/// transactions in turn, and defers a read-only TTL bump (CAP-63) until a
/// later transaction of the cluster writes the entry or the stage ends,
/// when the stage's bumps merge by maximum.
#[derive(Default)]
pub struct ParallelLayout {
    slots: HashMap<u32, Slot>,
}

pub struct Slot {
    pub stage: u32,
    pub cluster: u32,
    pub read_only: std::collections::HashSet<LedgerKey>,
    pub read_write: std::collections::HashSet<LedgerKey>,
}

impl ParallelLayout {
    /// The layout of a ledger's parallel phase, by apply index.
    pub fn of(meta: &LedgerCloseMetaV2, network_id: [u8; 32]) -> Result<Self> {
        let GeneralizedTransactionSet::V1(set) = &meta.tx_set;
        let mut by_hash: HashMap<[u8; 32], (u32, u32, &TransactionEnvelope)> = HashMap::new();
        for phase in set.phases.iter() {
            let TransactionPhase::V1(p) = phase else { continue };
            for (s, stage) in p.execution_stages.iter().enumerate() {
                for (c, cluster) in stage.iter().enumerate() {
                    for e in cluster.iter() {
                        by_hash.insert(envelope_hash(e, network_id)?, (s as u32, c as u32, e));
                    }
                }
            }
        }
        let mut slots = HashMap::new();
        for (i, t) in meta.tx_processing.iter().enumerate() {
            let Some((stage, cluster, e)) = by_hash.get(&t.result.transaction_hash.0) else { continue };
            let (ro, rw) = footprint(e);
            slots.insert(i as u32, Slot { stage: *stage, cluster: *cluster, read_only: ro, read_write: rw });
        }
        Ok(Self { slots })
    }

    pub fn slot(&self, index: u32) -> Option<&Slot> {
        self.slots.get(&index)
    }

    /// Whether transaction `b` sees a change transaction `a` (earlier in the
    /// same ledger) made to the TTL of `data_key`. A plain write is visible;
    /// a read-only bump (the entry only in `a`'s read-only footprint) is only
    /// once its stage ended, or, in the same cluster, once a transaction after
    /// `a`, up to `b` itself, has the entry in its read-write footprint.
    pub fn ttl_change_visible(&self, a: u32, b: u32, data_key: &LedgerKey) -> bool {
        let (Some(sa), Some(sb)) = (self.slot(a), self.slot(b)) else { return true };
        if !sa.read_only.contains(data_key) || sa.stage < sb.stage {
            return true;
        }
        if sa.cluster != sb.cluster {
            return false;
        }
        (a + 1..=b).any(|t| self.slot(t).is_some_and(|s| s.stage == sa.stage && s.cluster == sa.cluster && s.read_write.contains(data_key)))
    }

    /// Whether `a`'s change to the TTL of `data_key` is a read-only bump,
    /// which merges with the others of its stage by maximum.
    pub fn is_read_only_bump(&self, a: u32, data_key: &LedgerKey) -> bool {
        self.slot(a).is_some_and(|s| s.read_only.contains(data_key))
    }
}

fn footprint(e: &TransactionEnvelope) -> (std::collections::HashSet<LedgerKey>, std::collections::HashSet<LedgerKey>) {
    let tx = match e {
        TransactionEnvelope::Tx(e) => &e.tx,
        TransactionEnvelope::TxFeeBump(e) => {
            let FeeBumpTransactionInnerTx::Tx(inner) = &e.tx.inner_tx;
            &inner.tx
        }
        TransactionEnvelope::TxV0(_) => return Default::default(),
    };
    match &tx.ext {
        soroban_env_host::xdr::TransactionExt::V1(d) => (
            d.resources.footprint.read_only.iter().cloned().collect(),
            d.resources.footprint.read_write.iter().cloned().collect(),
        ),
        soroban_env_host::xdr::TransactionExt::V0 => Default::default(),
    }
}

/// Rolls entries back to the end of one ledger (the pin): the before-image
/// of each key's first change after it. Fed every later ledger in order.
/// An eviction records no image, so a key evicted before any change
/// recorded it has no known value at the pin.
pub struct Rollback {
    first_before: HashMap<LedgerKey, Option<LedgerEntry>>,
    /// Keys evicted before their first recorded change, and the ledger.
    evicted: HashMap<LedgerKey, u32>,
    pin: u32,
    indexed_through: u32,
}

impl Rollback {
    pub fn new(pin: u32) -> Self {
        Self { first_before: HashMap::new(), evicted: HashMap::new(), pin, indexed_through: pin }
    }

    /// The last ledger fed so far.
    pub fn indexed_through(&self) -> u32 {
        self.indexed_through
    }

    pub fn add(&mut self, meta: &LedgerCloseMetaV2) -> Result<()> {
        let seq = meta.ledger_header.header.ledger_seq;
        if seq != self.indexed_through + 1 {
            bail!("ledger {seq} does not follow ledger {}", self.indexed_through);
        }
        for_each_change(meta, |_, key, before, _| {
            if !self.evicted.contains_key(&key) {
                self.first_before.entry(key).or_insert(before);
            }
        })?;
        // The eviction scan runs after every transaction of the ledger.
        for key in meta.evicted_keys.iter() {
            if !self.first_before.contains_key(key) {
                self.evicted.entry(key.clone()).or_insert(seq);
            }
        }
        self.indexed_through = seq;
        Ok(())
    }

    /// `key` as it was at the pin, if anything since changed it. An error if
    /// it was evicted since with no earlier change recording its value.
    pub fn value_at_pin(&self, key: &LedgerKey) -> Result<Option<Option<LedgerEntry>>> {
        if let Some(ledger) = self.evicted.get(key) {
            let name = match key {
                LedgerKey::Ttl(t) => format!("TTL entry {}", crate::report::hex(&t.key_hash.0)),
                other => crate::report::describe_key(other),
            };
            bail!("{name} was evicted at ledger {ledger}, after the pin {}, and no ledger meta records its value at the pin", self.pin);
        }
        Ok(self.first_before.get(key).cloned())
    }

    /// The live-until ledger of a contract entry at the pin, if anything
    /// since changed its TTL (`Some(None)`: it had no TTL entry).
    pub fn live_until_at_pin(&self, key: &LedgerKey) -> Result<Option<Option<u32>>> {
        Ok(self.value_at_pin(&ttl_key(key)?)?.map(|e| match e.map(|e| e.data) {
            Some(LedgerEntryData::Ttl(t)) => Some(t.live_until_ledger_seq),
            _ => None,
        }))
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

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_env_host::xdr::{
        AccountEntry, AccountId, ContractDataDurability, ContractDataEntry, ExtensionPoint, Hash, HostFunction,
        InvokeContractArgs, InvokeHostFunctionOp, LedgerEntryExt, LedgerFootprint, LedgerHeader, LedgerHeaderHistoryEntry,
        LedgerKeyContractData, Memo, MuxedAccount, Operation, OperationBody, OperationMetaV2, ParallelTxsComponent,
        Preconditions, PublicKey, ScAddress, ScSymbol, ScVal, SequenceNumber, SorobanResources, SorobanTransactionData,
        SorobanTransactionDataExt, SorobanTransactionMetaExt, SorobanTransactionMetaV2, Thresholds, Transaction,
        TransactionExt, TransactionMetaV4, TransactionResult, TransactionResultExt, TransactionResultMetaV1,
        TransactionResultPair, TransactionResultResult, TransactionSetV1, TransactionV1Envelope, Uint256,
    };
    use soroban_sim_core::session::account_key;

    const L: u32 = 100;
    const NETWORK: [u8; 32] = [9; 32];

    fn account(id: u8, seq: i64, sub_entries: u32) -> LedgerEntry {
        LedgerEntry {
            last_modified_ledger_seq: L,
            data: LedgerEntryData::Account(AccountEntry {
                account_id: AccountId(PublicKey::PublicKeyTypeEd25519(Uint256([id; 32]))),
                balance: 1_000,
                seq_num: SequenceNumber(seq),
                num_sub_entries: sub_entries,
                inflation_dest: None,
                flags: 0,
                home_domain: Default::default(),
                thresholds: Thresholds([1, 0, 0, 0]),
                signers: Default::default(),
                ext: soroban_env_host::xdr::AccountEntryExt::V0,
            }),
            ext: LedgerEntryExt::V0,
        }
    }

    fn data_key(n: u8) -> LedgerKey {
        LedgerKey::ContractData(LedgerKeyContractData {
            contract: ScAddress::Contract(soroban_env_host::xdr::ContractId(Hash([n; 32]))),
            key: ScVal::U32(n as u32),
            durability: ContractDataDurability::Persistent,
        })
    }

    fn data(n: u8) -> LedgerEntry {
        let LedgerKey::ContractData(k) = data_key(n) else { unreachable!() };
        LedgerEntry {
            last_modified_ledger_seq: L,
            data: LedgerEntryData::ContractData(ContractDataEntry { ext: ExtensionPoint::V0, contract: k.contract, key: k.key, durability: k.durability, val: ScVal::Void }),
            ext: LedgerEntryExt::V0,
        }
    }

    fn ttl(n: u8, live_until: u32) -> LedgerEntry {
        let LedgerKey::Ttl(k) = ttl_key(&data_key(n)).unwrap() else { unreachable!() };
        LedgerEntry { last_modified_ledger_seq: L, data: LedgerEntryData::Ttl(TtlEntry { key_hash: k.key_hash, live_until_ledger_seq: live_until }), ext: LedgerEntryExt::V0 }
    }

    fn changes(pairs: &[(LedgerEntry, LedgerEntry)]) -> LedgerEntryChanges {
        let v: Vec<LedgerEntryChange> = pairs.iter().flat_map(|(b, a)| [LedgerEntryChange::State(b.clone()), LedgerEntryChange::Updated(a.clone())]).collect();
        LedgerEntryChanges(v.try_into().unwrap())
    }

    /// A Soroban envelope from `source` with the given footprint (its
    /// sequence number makes it unique).
    fn envelope(source: u8, seq: i64, read_only: &[LedgerKey], read_write: &[LedgerKey]) -> TransactionEnvelope {
        TransactionEnvelope::Tx(TransactionV1Envelope {
            tx: Transaction {
                source_account: MuxedAccount::Ed25519(Uint256([source; 32])),
                fee: 1_000,
                seq_num: SequenceNumber(seq),
                cond: Preconditions::None,
                memo: Memo::None,
                operations: vec![Operation {
                    source_account: None,
                    body: OperationBody::InvokeHostFunction(InvokeHostFunctionOp {
                        host_function: HostFunction::InvokeContract(InvokeContractArgs {
                            contract_address: ScAddress::Contract(soroban_env_host::xdr::ContractId(Hash([1; 32]))),
                            function_name: ScSymbol("f".try_into().unwrap()),
                            args: Default::default(),
                        }),
                        auth: Default::default(),
                    }),
                }]
                .try_into()
                .unwrap(),
                ext: TransactionExt::V1(SorobanTransactionData {
                    ext: SorobanTransactionDataExt::V0,
                    resources: SorobanResources {
                        footprint: LedgerFootprint { read_only: read_only.to_vec().try_into().unwrap(), read_write: read_write.to_vec().try_into().unwrap() },
                        instructions: 0,
                        disk_read_bytes: 0,
                        write_bytes: 0,
                    },
                    resource_fee: 0,
                }),
            },
            signatures: Default::default(),
        })
    }

    struct Tx {
        envelope: Option<TransactionEnvelope>,
        fee: LedgerEntryChanges,
        before: LedgerEntryChanges,
        op: LedgerEntryChanges,
    }

    /// A ledger: a classic phase, then a parallel Soroban phase whose stages
    /// are lists of clusters of indices into `txs`.
    fn ledger(txs: &[Tx], stages: &[Vec<Vec<usize>>]) -> LedgerCloseMetaV2 {
        let mut processing = vec![];
        for t in txs {
            let hash = t.envelope.as_ref().map_or([0; 32], |e| envelope_hash(e, NETWORK).unwrap());
            processing.push(TransactionResultMetaV1 {
                ext: ExtensionPoint::V0,
                result: TransactionResultPair {
                    transaction_hash: Hash(hash),
                    result: TransactionResult { fee_charged: 0, result: TransactionResultResult::TxSuccess(Default::default()), ext: TransactionResultExt::V0 },
                },
                fee_processing: t.fee.clone(),
                tx_apply_processing: TransactionMeta::V4(TransactionMetaV4 {
                    ext: ExtensionPoint::V0,
                    tx_changes_before: t.before.clone(),
                    operations: vec![OperationMetaV2 { ext: ExtensionPoint::V0, changes: t.op.clone(), events: Default::default() }].try_into().unwrap(),
                    tx_changes_after: Default::default(),
                    soroban_meta: t.envelope.as_ref().map(|_| SorobanTransactionMetaV2 { ext: SorobanTransactionMetaExt::V0, return_value: None }),
                    events: Default::default(),
                    diagnostic_events: Default::default(),
                }),
                post_tx_apply_fee_processing: Default::default(),
            });
        }
        let stages: Vec<_> = stages
            .iter()
            .map(|clusters| {
                let c: Vec<_> = clusters
                    .iter()
                    .map(|cluster| soroban_env_host::xdr::DependentTxCluster(cluster.iter().map(|i| txs[*i].envelope.clone().unwrap()).collect::<Vec<_>>().try_into().unwrap()))
                    .collect();
                soroban_env_host::xdr::ParallelTxExecutionStage(c.try_into().unwrap())
            })
            .collect();
        LedgerCloseMetaV2 {
            ext: Default::default(),
            ledger_header: LedgerHeaderHistoryEntry { hash: Hash([0; 32]), header: LedgerHeader { ledger_seq: L, ..Default::default() }, ext: Default::default() },
            tx_set: GeneralizedTransactionSet::V1(TransactionSetV1 {
                previous_ledger_hash: Hash([0; 32]),
                phases: vec![
                    TransactionPhase::V0(Default::default()),
                    TransactionPhase::V1(ParallelTxsComponent { base_fee: None, execution_stages: stages.try_into().unwrap() }),
                ]
                .try_into()
                .unwrap(),
            }),
            tx_processing: processing.try_into().unwrap(),
            upgrades_processing: Default::default(),
            scp_info: Default::default(),
            total_byte_size_of_live_soroban_state: 0,
            evicted_keys: Default::default(),
        }
    }

    fn sub_entries(e: &Option<LedgerEntry>) -> u32 {
        match e.as_ref().map(|e| &e.data) {
            Some(LedgerEntryData::Account(a)) => a.num_sub_entries,
            _ => panic!("not an account: {e:?}"),
        }
    }

    fn seq(e: &Option<LedgerEntry>) -> i64 {
        match e.as_ref().map(|e| &e.data) {
            Some(LedgerEntryData::Account(a)) => a.seq_num.0,
            _ => panic!("not an account: {e:?}"),
        }
    }

    #[test]
    fn fee_images_precede_every_apply() {
        // Account 7 pays the Soroban transaction's fee and a classic
        // transaction before it changes the account. The fee change's images
        // are from the start of the ledger, so they must not win.
        let classic = Tx { envelope: None, fee: changes(&[]), before: changes(&[]), op: changes(&[(account(7, 5, 1), account(7, 5, 2))]) };
        let soroban = Tx { envelope: Some(envelope(8, 2, &[], &[])), fee: changes(&[(account(7, 5, 1), account(7, 5, 1))]), before: changes(&[]), op: changes(&[]) };
        let meta = ledger(&[classic, soroban], &[vec![vec![1]]]);
        let mut index = ChangeIndex::default();
        index.add(&meta).unwrap();
        let key = account_key(&AccountId(PublicKey::PublicKeyTypeEd25519(Uint256([7; 32]))));
        assert_eq!(sub_entries(&index.value_before(&key, Pos::executing(L, 1, true)).unwrap()), 2);
        let mut rollback = Rollback::new(L - 1);
        rollback.add(&meta).unwrap();
        assert_eq!(sub_entries(&rollback.value_at_pin(&key).unwrap().unwrap()), 1, "the first change in time is the fee charge");
    }

    #[test]
    fn evictions_without_an_earlier_change_have_no_value_at_the_pin() {
        // Entry 4 changes in the ledger, then entries 3 and 4 (with their
        // TTLs) are evicted by the scan at its close.
        let k4 = data_key(4);
        let t = Tx { envelope: Some(envelope(1, 1, &[], &[k4.clone()])), fee: changes(&[]), before: changes(&[]), op: changes(&[(data(4), data(4)), (ttl(4, 90), ttl(4, 95))]) };
        let mut meta = ledger(&[t], &[vec![vec![0]]]);
        let evicted = [data_key(3), ttl_key(&data_key(3)).unwrap(), k4.clone(), ttl_key(&k4).unwrap()];
        meta.evicted_keys = evicted.to_vec().try_into().unwrap();
        let mut rollback = Rollback::new(L - 1);
        rollback.add(&meta).unwrap();
        let err = rollback.value_at_pin(&data_key(3)).unwrap_err().to_string();
        assert!(err.contains("evicted at ledger 100") && err.contains("pin 99"), "{err}");
        assert!(rollback.live_until_at_pin(&data_key(3)).is_err());
        // A change before the eviction recorded entry 4's value at the pin.
        assert!(rollback.value_at_pin(&k4).unwrap().unwrap().is_some());
        assert_eq!(rollback.live_until_at_pin(&k4).unwrap(), Some(Some(90)));
        // Re-creating an evicted entry later does not make it absent at the pin.
        let recreate = Tx { envelope: Some(envelope(1, 2, &[], &[data_key(3)])), fee: changes(&[]), before: changes(&[]), op: LedgerEntryChanges(vec![LedgerEntryChange::Created(data(3))].try_into().unwrap()) };
        let mut next = ledger(&[recreate], &[vec![vec![0]]]);
        next.ledger_header.header.ledger_seq = L + 1;
        rollback.add(&next).unwrap();
        assert!(rollback.value_at_pin(&data_key(3)).is_err());
    }

    #[test]
    fn parallel_sequence_bumps_precede_every_execution() {
        // Two transactions from account 5 (sequences 6 and 7); the first one's
        // footprint writes its own source.
        let key = account_key(&AccountId(PublicKey::PublicKeyTypeEd25519(Uint256([5; 32]))));
        let t1 = Tx { envelope: Some(envelope(5, 6, &[], &[key.clone()])), fee: changes(&[]), before: changes(&[(account(5, 5, 0), account(5, 6, 0))]), op: changes(&[(account(5, 7, 0), account(5, 7, 1))]) };
        let t2 = Tx { envelope: Some(envelope(5, 7, &[], &[])), fee: changes(&[]), before: changes(&[(account(5, 6, 0), account(5, 7, 0))]), op: changes(&[]) };
        let meta = ledger(&[t1, t2], &[vec![vec![0, 1]]]);
        let mut index = ChangeIndex::default();
        index.add(&meta).unwrap();
        // The first transaction executes after both bumps...
        assert_eq!(seq(&index.value_before(&key, Pos::executing(L, 0, true)).unwrap()), 7);
        // ...and the second one sees the first one's write.
        assert_eq!(sub_entries(&index.value_before(&key, Pos::executing(L, 1, true)).unwrap()), 1);
    }

    #[test]
    fn read_only_ttl_bumps_are_deferred_within_a_stage() {
        // Entry 3 is read-only in transactions 0, 1 and 3 and read-write in 2.
        // 0 and 1 share a cluster with 2; 3 is in another cluster; 4 runs in
        // the next stage.
        let k = data_key(3);
        let bump = |from, to| changes(&[(ttl(3, from), ttl(3, to))]);
        let t = |i: i64, ro: bool, op| Tx {
            envelope: Some(if ro { envelope(1, i, &[k.clone()], &[]) } else { envelope(1, i, &[], &[k.clone()]) }),
            fee: changes(&[]),
            before: changes(&[]),
            op,
        };
        let txs = [t(1, true, bump(50, 60)), t(2, true, bump(50, 70)), t(3, false, changes(&[(data(3), data(3))])), t(4, true, bump(50, 55)), t(5, true, changes(&[]))];
        let meta = ledger(&txs, &[vec![vec![0, 1, 2], vec![3]], vec![vec![4]]]);
        let layout = ParallelLayout::of(&meta, NETWORK).unwrap();
        // The second read-only bump does not see the first.
        assert!(!layout.ttl_change_visible(0, 1, &k));
        // The writer does: bumps are flushed before a write.
        assert!(layout.ttl_change_visible(0, 2, &k) && layout.ttl_change_visible(1, 2, &k));
        // Another cluster of the same stage never does.
        assert!(!layout.ttl_change_visible(1, 3, &k));
        // The next stage sees them all, merged by maximum.
        assert!(layout.ttl_change_visible(3, 4, &k));
        assert!(layout.is_read_only_bump(3, &k) && !layout.is_read_only_bump(2, &k));
    }
}
