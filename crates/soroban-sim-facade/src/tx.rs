//! What the facade answers about a transaction it applied: its hash, the
//! `TransactionResult` core would report (with every operation's result for
//! a classic transaction), and a `TransactionMeta` (V4, the shape
//! protocol-23+ RPC serves) rebuilt from the session's record and the
//! entries it touched, before and after.

use anyhow::Result;
use sha2::{Digest, Sha256};
use soroban_env_host::xdr::{
    ContractId, ContractIdPreimage, ContractIdPreimageFromAddress, DecoratedSignature, ExtensionPoint, Hash, HashIdPreimage,
    HashIdPreimageContractId, HostFunction, InvokeHostFunctionResult, InvokeHostFunctionSuccessPreImage,
    LedgerEntry, LedgerEntryChange, LedgerEntryChanges, LedgerEntryData, LedgerEntryExt, LedgerKey,
    LedgerKeyTtl, Limits, MuxedAccount, OperationBody, OperationMetaV2, OperationResult,
    OperationResultTr, Preconditions, ScAddress, SorobanCredentials, SorobanTransactionMetaExt,
    SorobanTransactionMetaExtV1, SorobanTransactionMetaV2, Transaction, TransactionEnvelope, TransactionExt,
    TransactionMeta, TransactionMetaV4, TransactionResult, TransactionResultExt, TransactionResultResult,
    TransactionSignaturePayload, TransactionSignaturePayloadTaggedTransaction, TransactionV0, TtlEntry, Uint256,
    WriteXdr,
};
use soroban_sim_core::session::{account_key, classic_op_keys, muxed_account_id, StoredEntry, TxCode, TxRecord, TxStatus};

use crate::report::hex;

/// The contract id `deployer` gets for `salt` on the network `network_id`.
pub fn contract_id(network_id: [u8; 32], deployer: ScAddress, salt: [u8; 32]) -> Result<ScAddress> {
    let pre = HashIdPreimage::ContractId(HashIdPreimageContractId {
        network_id: Hash(network_id),
        contract_id_preimage: ContractIdPreimage::Address(ContractIdPreimageFromAddress { address: deployer, salt: Uint256(salt) }),
    });
    Ok(ScAddress::Contract(ContractId(Hash(Sha256::digest(pre.to_xdr(Limits::none())?).into()))))
}

/// Every ledger key a transaction names up front: its source and operation
/// sources, the accounts of its authorization entries, its footprint, and
/// what its classic operations touch. A session reads them before
/// validating, in one base fetch.
pub fn envelope_keys(tx: &Transaction) -> Vec<LedgerKey> {
    let source = muxed_account_id(&tx.source_account);
    let mut keys = vec![account_key(&source)];
    for op in tx.operations.iter() {
        if let Some(s) = &op.source_account {
            keys.push(account_key(&muxed_account_id(s)));
        }
        let op_source = op.source_account.as_ref().map(muxed_account_id).unwrap_or_else(|| source.clone());
        keys.extend(classic_op_keys(&op.body, &op_source));
        if let OperationBody::InvokeHostFunction(ihf) = &op.body {
            for a in ihf.auth.iter() {
                let address = match &a.credentials {
                    SorobanCredentials::SourceAccount => continue,
                    SorobanCredentials::Address(c) | SorobanCredentials::AddressV2(c) => &c.address,
                    SorobanCredentials::AddressWithDelegates(c) => &c.address_credentials.address,
                };
                if let ScAddress::Account(id) = address {
                    keys.push(account_key(id));
                }
            }
        }
    }
    if let TransactionExt::V1(data) = &tx.ext {
        keys.extend(data.resources.footprint.read_only.iter().cloned());
        keys.extend(data.resources.footprint.read_write.iter().cloned());
    }
    keys
}

/// The network's transaction id for any envelope kind.
pub fn envelope_hash(envelope: &TransactionEnvelope, network_id: [u8; 32]) -> Result<[u8; 32]> {
    let tagged = match envelope {
        TransactionEnvelope::Tx(e) => TransactionSignaturePayloadTaggedTransaction::Tx(e.tx.clone()),
        TransactionEnvelope::TxV0(e) => TransactionSignaturePayloadTaggedTransaction::Tx(v0_as_v1(&e.tx)),
        TransactionEnvelope::TxFeeBump(e) => TransactionSignaturePayloadTaggedTransaction::TxFeeBump(e.tx.clone()),
    };
    let payload = TransactionSignaturePayload { network_id: Hash(network_id), tagged_transaction: tagged };
    Ok(Sha256::digest(payload.to_xdr(Limits::none())?).into())
}

/// A v0 transaction as core hashes and checks it: the same transaction with
/// an ed25519 source and time bounds as preconditions.
pub fn v0_as_v1(tx: &TransactionV0) -> Transaction {
    Transaction {
        source_account: MuxedAccount::Ed25519(tx.source_account_ed25519.clone()),
        fee: tx.fee,
        seq_num: tx.seq_num.clone(),
        cond: match &tx.time_bounds {
            Some(tb) => Preconditions::Time(tb.clone()),
            None => Preconditions::None,
        },
        memo: tx.memo.clone(),
        operations: tx.operations.clone(),
        ext: TransactionExt::V0,
    }
}

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

/// The signatures over [`inner_transaction`] (the inner ones of a fee bump).
pub fn inner_signatures(envelope: &TransactionEnvelope) -> &[DecoratedSignature] {
    match envelope {
        TransactionEnvelope::Tx(e) => &e.signatures,
        TransactionEnvelope::TxV0(e) => &e.signatures,
        TransactionEnvelope::TxFeeBump(e) => match &e.tx.inner_tx {
            soroban_env_host::xdr::FeeBumpTransactionInnerTx::Tx(i) => &i.signatures,
        },
    }
}

/// A one-line description of what a transaction does, for logs and reports.
pub fn describe(tx: &Transaction, network_id: [u8; 32]) -> String {
    let [op] = tx.operations.as_slice() else {
        let ops: Vec<String> = tx.operations.iter().map(describe_classic).collect();
        return format!("{} operations: {}", tx.operations.len(), ops.join("; "));
    };
    let OperationBody::InvokeHostFunction(ihf) = &op.body else { return describe_classic(op) };
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

/// A classic operation in a few words.
fn describe_classic(op: &soroban_env_host::xdr::Operation) -> String {
    use soroban_env_host::xdr::Asset;
    let asset = |a: &Asset| match a {
        Asset::Native => "XLM".to_string(),
        Asset::CreditAlphanum4(x) => format!("{}:{}", String::from_utf8_lossy(&x.asset_code.0).trim_end_matches('\0'), x.issuer),
        Asset::CreditAlphanum12(x) => format!("{}:{}", String::from_utf8_lossy(&x.asset_code.0).trim_end_matches('\0'), x.issuer),
    };
    let what = match &op.body {
        OperationBody::CreateAccount(o) => format!("create account {} with {} XLM", o.destination, soroban_sim_core::session::xlm(o.starting_balance)),
        OperationBody::Payment(o) => format!("pay {} {} to {}", soroban_sim_core::session::xlm(o.amount), asset(&o.asset), soroban_sim_core::session::muxed_account_id(&o.destination)),
        OperationBody::SetOptions(o) => {
            let mut parts = vec![];
            if let Some(s) = &o.signer {
                parts.push(format!("signer {} weight {}", s.key, s.weight));
            }
            for (name, v) in [("master weight", o.master_weight), ("low", o.low_threshold), ("medium", o.med_threshold), ("high", o.high_threshold)] {
                if let Some(v) = v {
                    parts.push(format!("{name} {v}"));
                }
            }
            if let Some(d) = &o.home_domain {
                parts.push(format!("home domain {:?}", d.to_string()));
            }
            format!("set options ({})", parts.join(", "))
        }
        OperationBody::ChangeTrust(o) => format!("change trust (limit {})", soroban_sim_core::session::xlm(o.limit)),
        other => format!("{} operation", other.name()),
    };
    match &op.source_account {
        Some(s) => format!("{what} [from {}]", soroban_sim_core::session::muxed_account_id(s)),
        None => what,
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

/// The `TransactionResult` core reports for `record`. A rejected envelope
/// gets the result code `sendTransaction` returns as `errorResultXdr`; a
/// classic transaction carries every operation's result.
pub fn result(record: &TxRecord, fee_bid: i64) -> Result<TransactionResult> {
    let ihf = |r: InvokeHostFunctionResult| OperationResult::OpInner(OperationResultTr::InvokeHostFunction(r));
    let classic = !record.op_results.is_empty();
    let ops = || -> Result<_> { Ok(record.op_results.clone().try_into()?) };
    let (fee_charged, result) = match &record.status {
        TxStatus::Applied { .. } if classic => (record.fee_charged, TransactionResultResult::TxSuccess(ops()?)),
        TxStatus::Applied { value } => {
            let preimage = InvokeHostFunctionSuccessPreImage { return_value: value.clone(), events: record.events.clone().try_into()? };
            let hash: [u8; 32] = Sha256::digest(preimage.to_xdr(Limits::none())?).into();
            (record.fee_charged, TransactionResultResult::TxSuccess(vec![ihf(InvokeHostFunctionResult::Success(Hash(hash)))].try_into()?))
        }
        TxStatus::Failed { reason } => match record.failed_code {
            // Included, then refused by the checks core repeats at apply.
            Some(code) => (record.fee_charged, rejection(code, &record.op_results)?),
            None if classic => (record.fee_charged, TransactionResultResult::TxFailed(ops()?)),
            None => (record.fee_charged, TransactionResultResult::TxFailed(vec![ihf(failure(reason))].try_into()?)),
        },
        TxStatus::Rejected { code, .. } => (fee_bid, rejection(*code, &record.op_results)?),
    };
    Ok(TransactionResult { fee_charged, result, ext: TransactionResultExt::V0 })
}

/// The operation result of a failed apply, from the applier's reason prefix.
fn failure(reason: &str) -> InvokeHostFunctionResult {
    if reason.starts_with("RESOURCE_LIMIT_EXCEEDED") {
        InvokeHostFunctionResult::ResourceLimitExceeded
    } else if reason.starts_with("ENTRY_ARCHIVED") {
        InvokeHostFunctionResult::EntryArchived
    } else if reason.starts_with("INSUFFICIENT_REFUNDABLE_FEE") {
        InvokeHostFunctionResult::InsufficientRefundableFee
    } else {
        InvokeHostFunctionResult::Trapped
    }
}

fn rejection(code: TxCode, op_results: &[OperationResult]) -> Result<TransactionResultResult> {
    use TransactionResultResult as R;
    Ok(match code {
        TxCode::Malformed => R::TxMalformed,
        TxCode::MissingOperation => R::TxMissingOperation,
        TxCode::NotSupported => R::TxNotSupported,
        TxCode::TooEarly => R::TxTooEarly,
        TxCode::TooLate => R::TxTooLate,
        TxCode::BadMinSeqAgeOrGap => R::TxBadMinSeqAgeOrGap,
        TxCode::NoAccount => R::TxNoAccount,
        TxCode::BadSeq => R::TxBadSeq,
        TxCode::BadAuth => R::TxBadAuth,
        TxCode::OpBadAuth | TxCode::OpFailed if !op_results.is_empty() => R::TxFailed(op_results.to_vec().try_into()?),
        TxCode::OpBadAuth => R::TxFailed(vec![OperationResult::OpBadAuth].try_into()?),
        TxCode::OpFailed => R::TxFailed(Default::default()),
        TxCode::BadAuthExtra => R::TxBadAuthExtra,
        TxCode::InsufficientFee => R::TxInsufficientFee,
        TxCode::InsufficientBalance => R::TxInsufficientBalance,
        TxCode::SorobanInvalid => R::TxSorobanInvalid,
        TxCode::FrozenKeyAccessed => R::TxFrozenKeyAccessed,
    })
}

/// One ledger key a transaction could have changed, before and after it.
pub struct Touched {
    pub key: LedgerKey,
    pub before: Option<StoredEntry>,
    pub after: Option<StoredEntry>,
}

/// A `TransactionMeta` V4 for an applied (or failed) transaction. The source
/// account's fee, sequence number and refund are `tx_changes_before`. A
/// Soroban operation's changes are its footprint's, data and TTL entries
/// alike; a classic transaction's operations each get the changes the
/// session recorded for them (the source account's aside). This is a
/// reconstruction from before and after values, not core's exact change
/// list, and in a ledger of several transactions "before" is the ledger's
/// start.
pub fn meta(record: &TxRecord, source: &Touched, footprint: &[Touched], apply_ledger: u32) -> Result<TransactionMeta> {
    let applied = record.status.is_applied();
    let mut op_changes = vec![];
    if applied {
        for t in footprint.iter().filter(|t| t.key != source.key) {
            op_changes.extend(changes(t, apply_ledger)?);
        }
    }
    let operations: Vec<OperationMetaV2> = if !applied {
        vec![]
    } else if !record.op_results.is_empty() {
        let mut ops = vec![];
        for changed in &record.op_changes {
            let mut list = vec![];
            for c in changed.iter().filter(|c| c.key != source.key) {
                list.extend(changes(&Touched { key: c.key.clone(), before: c.before.clone(), after: c.after.clone() }, apply_ledger)?);
            }
            ops.push(OperationMetaV2 { ext: ExtensionPoint::V0, changes: LedgerEntryChanges(list.try_into()?), events: Default::default() });
        }
        ops
    } else {
        vec![OperationMetaV2 { ext: ExtensionPoint::V0, changes: LedgerEntryChanges(op_changes.try_into()?), events: record.events.clone().try_into()? }]
    };
    let soroban = record.op_results.is_empty();
    let return_value = match &record.status {
        TxStatus::Applied { value } => Some(value.clone()),
        _ => None,
    };
    let refundable_charged = if applied { record.rent_fee + record.events_fee } else { 0 };
    Ok(TransactionMeta::V4(TransactionMetaV4 {
        ext: ExtensionPoint::V0,
        tx_changes_before: LedgerEntryChanges(changes(source, apply_ledger)?.try_into()?),
        operations: operations.try_into()?,
        tx_changes_after: LedgerEntryChanges(Default::default()),
        soroban_meta: soroban.then_some(SorobanTransactionMetaV2 {
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
