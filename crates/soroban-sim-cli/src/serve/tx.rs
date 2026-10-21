//! What the facade answers about a transaction it applied: its hash, the
//! `TransactionResult` core would report, and a `TransactionMeta` (V4, the
//! shape protocol-23+ RPC serves) rebuilt from the session's record and the
//! entries it touched, before and after.

use anyhow::Result;
use sha2::{Digest, Sha256};
use soroban_env_host::xdr::{
    ExtensionPoint, Hash, HostFunction, LedgerEntry, LedgerEntryChange, LedgerEntryChanges, LedgerEntryData,
    LedgerEntryExt, LedgerKey, LedgerKeyTtl, Limits, OperationBody, OperationMetaV2, SorobanTransactionMetaExt,
    SorobanTransactionMetaExtV1, SorobanTransactionMetaV2, Transaction, TransactionEnvelope, TransactionMeta,
    TransactionMetaV4, TransactionResult, TtlEntry, WriteXdr,
};
use soroban_sim_core::session::{v0_as_v1, StoredEntry, TxRecord, TxStatus};

use crate::report::hex;
use crate::run::contract_id;

/// The transaction an envelope carries (the inner one of a fee bump).
pub fn inner_transaction(envelope: &TransactionEnvelope) -> Transaction {
    match envelope {
        TransactionEnvelope::Tx(e) => e.tx.clone(),
        TransactionEnvelope::TxV0(e) => v0_as_v1(&e.tx),
        TransactionEnvelope::TxFeeBump(e) => match &e.tx.inner_tx {
            soroban_env_host::xdr::FeeBumpTransactionInnerTx::Tx(i) => i.tx.clone(),
        },
    }
}

/// A one-line description of what a transaction does, for logs and reports.
pub fn describe(tx: &Transaction, network_id: [u8; 32]) -> String {
    let [op] = tx.operations.as_slice() else { return format!("transaction with {} operations", tx.operations.len()) };
    let OperationBody::InvokeHostFunction(ihf) = &op.body else { return format!("{} operation", op.body.name()) };
    match &ihf.host_function {
        HostFunction::InvokeContract(a) => format!("{}.{}", a.contract_address, a.function_name.to_utf8_string_lossy()),
        HostFunction::UploadContractWasm(code) => {
            let hash: [u8; 32] = Sha256::digest(code.as_slice()).into();
            format!("upload wasm {} ({} bytes)", hex(&hash), code.len())
        }
        HostFunction::CreateContract(a) => create_description(&a.contract_id_preimage, network_id),
        HostFunction::CreateContractV2(a) => create_description(&a.contract_id_preimage, network_id),
    }
}

fn create_description(preimage: &soroban_env_host::xdr::ContractIdPreimage, network_id: [u8; 32]) -> String {
    use soroban_env_host::xdr::ContractIdPreimage;
    match preimage {
        ContractIdPreimage::Address(p) => match contract_id(network_id, p.address.clone(), p.salt.0) {
            Ok(id) => format!("deploy {id} from {}", p.address),
            Err(_) => format!("deploy from {}", p.address),
        },
        ContractIdPreimage::Asset(a) => format!("deploy the asset contract of {a:?}"),
    }
}

/// The full fee an envelope bids: a fee bump's outer fee.
pub fn fee_bid(envelope: &TransactionEnvelope) -> i64 {
    match envelope {
        TransactionEnvelope::Tx(e) => e.tx.fee as i64,
        TransactionEnvelope::TxV0(e) => e.tx.fee as i64,
        TransactionEnvelope::TxFeeBump(e) => e.tx.fee,
    }
}

/// The `TransactionResult` core reports for `record`. A rejected envelope
/// gets the result code `sendTransaction` returns as `errorResultXdr`, which
/// carries the fee bid.
pub fn result(record: &TxRecord, fee_bid: i64) -> TransactionResult {
    let mut result = record.transaction_result();
    if let TxStatus::Rejected { .. } = record.status {
        result.fee_charged = fee_bid;
    }
    result
}

/// One ledger key a transaction could have changed, before and after it.
pub struct Touched {
    pub key: LedgerKey,
    pub before: Option<StoredEntry>,
    pub after: Option<StoredEntry>,
}

/// A `TransactionMeta` V4 for an applied (or failed) transaction. The source
/// account's fee, sequence number and refund are `tx_changes_before`; the
/// operation's footprint changes, data and TTL entries alike, are the
/// operation's changes. This is a reconstruction from before and after
/// values, not core's exact change list.
pub fn meta(record: &TxRecord, source: &Touched, footprint: &[Touched], apply_ledger: u32) -> Result<TransactionMeta> {
    let applied = record.status.is_applied();
    let mut op_changes = vec![];
    if applied {
        for t in footprint.iter().filter(|t| t.key != source.key) {
            op_changes.extend(changes(t, apply_ledger)?);
        }
    }
    let return_value = match &record.status {
        TxStatus::Applied { value } => Some(value.clone()),
        _ => None,
    };
    let refundable_charged = if applied { record.rent_fee + record.events_fee } else { 0 };
    Ok(TransactionMeta::V4(TransactionMetaV4 {
        ext: ExtensionPoint::V0,
        tx_changes_before: LedgerEntryChanges(changes(source, apply_ledger)?.try_into()?),
        operations: if applied {
            vec![OperationMetaV2 {
                ext: ExtensionPoint::V0,
                changes: LedgerEntryChanges(op_changes.try_into()?),
                events: record.events.clone().try_into()?,
            }]
            .try_into()?
        } else {
            Default::default()
        },
        tx_changes_after: LedgerEntryChanges(Default::default()),
        soroban_meta: Some(SorobanTransactionMetaV2 {
            ext: SorobanTransactionMetaExt::V1(SorobanTransactionMetaExtV1 {
                ext: ExtensionPoint::V0,
                total_non_refundable_resource_fee_charged: record.fees.non_refundable,
                total_refundable_resource_fee_charged: refundable_charged,
                rent_fee_charged: if applied { record.rent_fee } else { 0 },
            }),
            return_value,
        }),
        events: Default::default(),
        diagnostic_events: record.diagnostics.clone().try_into()?,
    }))
}

/// The entry changes for one key: state then updated, created, state then
/// removed, or restored; each TTL move as the TTL entry's own change.
fn changes(t: &Touched, apply_ledger: u32) -> Result<Vec<LedgerEntryChange>> {
    let ttl_key = || -> Result<LedgerKey> { Ok(LedgerKey::Ttl(LedgerKeyTtl { key_hash: Hash(Sha256::digest(t.key.to_xdr(Limits::none())?).into()) })) };
    let ttl_entry = |e: &StoredEntry, live_until: u32| -> Result<LedgerEntry> {
        Ok(LedgerEntry {
            last_modified_ledger_seq: e.entry.last_modified_ledger_seq,
            data: LedgerEntryData::Ttl(TtlEntry { key_hash: Hash(Sha256::digest(t.key.to_xdr(Limits::none())?).into()), live_until_ledger_seq: live_until }),
            ext: LedgerEntryExt::V0,
        })
    };
    let mut out = vec![];
    match (&t.before, &t.after) {
        (None, None) => {}
        (None, Some(a)) => {
            out.push(LedgerEntryChange::Created(a.entry.clone()));
            if let Some(l) = a.live_until {
                out.push(LedgerEntryChange::Created(ttl_entry(a, l)?));
            }
        }
        (Some(b), None) => {
            out.push(LedgerEntryChange::State(b.entry.clone()));
            out.push(LedgerEntryChange::Removed(t.key.clone()));
            if let Some(l) = b.live_until {
                out.push(LedgerEntryChange::State(ttl_entry(b, l)?));
                out.push(LedgerEntryChange::Removed(ttl_key()?));
            }
        }
        (Some(b), Some(a)) if b == a => {}
        (Some(b), Some(a)) => {
            let archived = b.live_until.is_some_and(|l| l < apply_ledger);
            if archived {
                out.push(LedgerEntryChange::Restored(a.entry.clone()));
                if let Some(l) = a.live_until {
                    out.push(LedgerEntryChange::Restored(ttl_entry(a, l)?));
                }
                return Ok(out);
            }
            if b.entry.data != a.entry.data {
                out.push(LedgerEntryChange::State(b.entry.clone()));
                out.push(LedgerEntryChange::Updated(a.entry.clone()));
            }
            if let (Some(lb), Some(la)) = (b.live_until, a.live_until) {
                if lb != la {
                    out.push(LedgerEntryChange::State(ttl_entry(b, lb)?));
                    out.push(LedgerEntryChange::Updated(ttl_entry(a, la)?));
                }
            }
        }
    }
    Ok(out)
}
