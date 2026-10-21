//! Transaction-level validity: the subset of stellar-core's `TransactionFrame`
//! checks a Soroban transaction meets before it may apply. The host never
//! sees the envelope, so everything here is ours: preconditions, sequence
//! number, envelope signatures against signer weights and thresholds (ported
//! from core's `SignatureChecker`), fee bid, resource fee and limits, and the
//! source's balance above its reserve.

use anyhow::{anyhow, Result};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use soroban_env_host::fees::{compute_transaction_resource_fee, TransactionResources};
use soroban_env_host::storage::SnapshotSource;
use soroban_env_host::xdr::{
    AccountEntry, AccountEntryExt, AccountEntryExtensionV1Ext, AccountEntryExtensionV2Ext,
    AccountId, ConfigSettingEntry, ConfigSettingId, DecoratedSignature, Hash,
    InvokeHostFunctionOp, LedgerEntryData, LedgerKey, LedgerKeyConfigSetting, Limits,
    MuxedAccount, OperationBody, Preconditions, PublicKey, ScAddress, ScMap, ScVal, Signer, SignerKey,
    SignerKeyEd25519SignedPayload, SorobanAuthorizationEntry, SorobanCredentials, SorobanDelegateSignature,
    SorobanTransactionData, SorobanTransactionDataExt, Transaction,
    TransactionEnvelope, TransactionSignaturePayload, TransactionSignaturePayloadTaggedTransaction,
    TransactionV1Envelope, Uint256, WriteXdr,
};
use soroban_env_host::LedgerInfo;
use soroban_simulation::NetworkConfig;
use std::collections::BTreeSet;
use std::rc::Rc;

use super::ledger::ForkedLedger;
use super::signers::auth_payload;

/// Why an envelope was refused before it could apply. Rejected envelopes are
/// never included in a ledger: they pay no fee and consume no sequence number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxCode {
    Malformed,
    NotSupported,
    TooEarly,
    TooLate,
    BadMinSeqAgeOrGap,
    NoAccount,
    BadSeq,
    BadAuth,
    /// The operation's signature check failed (`txFAILED` with `opBAD_AUTH`).
    OpBadAuth,
    BadAuthExtra,
    InsufficientFee,
    InsufficientBalance,
    SorobanInvalid,
}

impl TxCode {
    /// stellar-core's result code name.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Malformed => "txMALFORMED",
            Self::NotSupported => "txNOT_SUPPORTED",
            Self::TooEarly => "txTOO_EARLY",
            Self::TooLate => "txTOO_LATE",
            Self::BadMinSeqAgeOrGap => "txBAD_MIN_SEQ_AGE_OR_GAP",
            Self::NoAccount => "txNO_ACCOUNT",
            Self::BadSeq => "txBAD_SEQ",
            Self::BadAuth => "txBAD_AUTH",
            Self::OpBadAuth => "txFAILED(opBAD_AUTH)",
            Self::BadAuthExtra => "txBAD_AUTH_EXTRA",
            Self::InsufficientFee => "txINSUFFICIENT_FEE",
            Self::InsufficientBalance => "txINSUFFICIENT_BALANCE",
            Self::SorobanInvalid => "txSOROBAN_INVALID",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Rejection {
    pub code: TxCode,
    pub detail: String,
}

fn reject<T>(code: TxCode, detail: impl Into<String>) -> Result<std::result::Result<T, Rejection>> {
    Ok(Err(Rejection { code, detail: detail.into() }))
}

/// Per-transaction network maxima, read from the `ConfigSetting` entries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxLimits {
    pub tx_max_instructions: u64,
    pub tx_max_disk_read_entries: u32,
    pub tx_max_disk_read_bytes: u32,
    pub tx_max_write_ledger_entries: u32,
    pub tx_max_write_bytes: u32,
    pub tx_max_footprint_entries: u32,
    pub tx_max_size_bytes: u32,
    pub tx_max_contract_events_size_bytes: u32,
}

impl TxLimits {
    /// No limits beyond the host's own budget (fixtures and tests).
    pub fn unlimited() -> Self {
        Self {
            tx_max_instructions: u64::MAX,
            tx_max_disk_read_entries: u32::MAX,
            tx_max_disk_read_bytes: u32::MAX,
            tx_max_write_ledger_entries: u32::MAX,
            tx_max_write_bytes: u32::MAX,
            tx_max_footprint_entries: u32::MAX,
            tx_max_size_bytes: u32::MAX,
            tx_max_contract_events_size_bytes: u32::MAX,
        }
    }

    pub fn load_from_snapshot(snapshot: &impl SnapshotSource) -> Result<Self> {
        let setting = |id: ConfigSettingId| -> Result<ConfigSettingEntry> {
            let key = Rc::new(LedgerKey::ConfigSetting(LedgerKeyConfigSetting { config_setting_id: id }));
            match snapshot.get(&key).map_err(|e| anyhow!("reading {id:?}: {e:?}"))? {
                Some((entry, _)) => match &entry.data {
                    LedgerEntryData::ConfigSetting(cs) => Ok(cs.clone()),
                    _ => Err(anyhow!("{id:?} is not a config setting entry")),
                },
                None => Err(anyhow!("config setting {id:?} is not on the ledger")),
            }
        };
        let ConfigSettingEntry::ContractComputeV0(compute) = setting(ConfigSettingId::ContractComputeV0)? else {
            return Err(anyhow!("unexpected ContractComputeV0 entry"));
        };
        let ConfigSettingEntry::ContractLedgerCostV0(cost) = setting(ConfigSettingId::ContractLedgerCostV0)? else {
            return Err(anyhow!("unexpected ContractLedgerCostV0 entry"));
        };
        let ConfigSettingEntry::ContractLedgerCostExtV0(cost_ext) = setting(ConfigSettingId::ContractLedgerCostExtV0)? else {
            return Err(anyhow!("unexpected ContractLedgerCostExtV0 entry"));
        };
        let ConfigSettingEntry::ContractEventsV0(events) = setting(ConfigSettingId::ContractEventsV0)? else {
            return Err(anyhow!("unexpected ContractEventsV0 entry"));
        };
        let ConfigSettingEntry::ContractBandwidthV0(bandwidth) = setting(ConfigSettingId::ContractBandwidthV0)? else {
            return Err(anyhow!("unexpected ContractBandwidthV0 entry"));
        };
        Ok(Self {
            tx_max_instructions: compute.tx_max_instructions.max(0) as u64,
            tx_max_disk_read_entries: cost.tx_max_disk_read_entries,
            tx_max_disk_read_bytes: cost.tx_max_disk_read_bytes,
            tx_max_write_ledger_entries: cost.tx_max_write_ledger_entries,
            tx_max_write_bytes: cost.tx_max_write_bytes,
            tx_max_footprint_entries: cost_ext.tx_max_footprint_entries,
            tx_max_size_bytes: bandwidth.tx_max_size_bytes,
            tx_max_contract_events_size_bytes: events.tx_max_contract_events_size_bytes,
        })
    }
}

/// The fee a valid transaction declares and what it is charged up front.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fees {
    /// `tx.fee`: the full bid, which the source must be able to pay.
    pub bid: i64,
    /// The declared Soroban resource fee.
    pub resource_fee: i64,
    /// The part of the resource fee computed from the declared resources.
    pub non_refundable: i64,
    /// `resource_fee - non_refundable`: the cap on rent and events.
    pub refundable: i64,
    /// The inclusion fee charged: the bid's remainder, capped at the base fee.
    pub inclusion: i64,
}

impl Fees {
    /// Charged before the operation applies, success or not.
    pub fn charged_up_front(&self) -> i64 {
        self.resource_fee + self.inclusion
    }
}

/// One signer whose signature counted toward a threshold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchedSigner {
    pub account: AccountId,
    pub key: SignerKey,
    pub weight: u32,
}

/// An envelope that passed every transaction-level check.
#[derive(Clone, Debug)]
pub struct ValidTx {
    pub hash: [u8; 32],
    pub source: AccountId,
    /// The transaction's sequence number: the source's sequence after apply.
    pub seq_num: i64,
    pub op_source: AccountId,
    pub op: InvokeHostFunctionOp,
    pub data: SorobanTransactionData,
    pub fees: Fees,
    pub size_bytes: u32,
    pub signers: Vec<MatchedSigner>,
    /// Signatures that verify against a signer the BASE ledger already has,
    /// not a substituted one. Such an envelope is valid on the real network.
    pub replayable: Vec<String>,
}

pub struct TxValidator<'a> {
    pub ledger: &'a ForkedLedger,
    pub info: &'a LedgerInfo,
    pub config: &'a NetworkConfig,
    pub limits: &'a TxLimits,
    pub base_fee: u32,
}

/// The hash every envelope signature signs.
pub fn transaction_hash(tx: &Transaction, network_id: [u8; 32]) -> Result<[u8; 32]> {
    let payload = TransactionSignaturePayload {
        network_id: Hash(network_id),
        tagged_transaction: TransactionSignaturePayloadTaggedTransaction::Tx(tx.clone()),
    };
    Ok(Sha256::digest(payload.to_xdr(Limits::none())?).into())
}

pub fn muxed_account_id(m: &MuxedAccount) -> AccountId {
    match m {
        MuxedAccount::Ed25519(k) => AccountId(PublicKey::PublicKeyTypeEd25519(k.clone())),
        MuxedAccount::MuxedEd25519(m) => AccountId(PublicKey::PublicKeyTypeEd25519(m.ed25519.clone())),
    }
}

impl TxValidator<'_> {
    /// `Ok(Err(_))` is a rejection; `Err(_)` is an infrastructure failure
    /// (the base ledger could not be read).
    pub fn validate(&self, envelope: &TransactionEnvelope) -> Result<std::result::Result<ValidTx, Rejection>> {
        let TransactionEnvelope::Tx(TransactionV1Envelope { tx, signatures }) = envelope else {
            return reject(TxCode::NotSupported, "only v1 envelopes are supported (no v0 or fee-bump yet)");
        };
        let hash = transaction_hash(tx, self.info.network_id)?;
        let [op] = tx.operations.as_slice() else {
            return reject(TxCode::Malformed, "a Soroban transaction has exactly one operation");
        };
        let OperationBody::InvokeHostFunction(ihf) = &op.body else {
            return reject(TxCode::NotSupported, "only InvokeHostFunction operations are supported");
        };
        let soroban_env_host::xdr::TransactionExt::V1(data) = &tx.ext else {
            return reject(TxCode::Malformed, "a Soroban transaction must carry SorobanTransactionData");
        };
        let size_bytes = envelope.to_xdr(Limits::none())?.len() as u32;
        let source = muxed_account_id(&tx.source_account);
        let op_source = op.source_account.as_ref().map(muxed_account_id).unwrap_or_else(|| source.clone());

        // --- preconditions that do not need the account ---
        let (time_bounds, ledger_bounds, v2) = match &tx.cond {
            Preconditions::None => (None, None, None),
            Preconditions::Time(tb) => (Some(tb), None, None),
            Preconditions::V2(p) => (p.time_bounds.as_ref(), p.ledger_bounds.as_ref(), Some(p)),
        };
        let now = self.info.timestamp;
        if let Some(tb) = time_bounds {
            if now < tb.min_time.0 {
                return reject(TxCode::TooEarly, format!("close time {now} < min time {}", tb.min_time.0));
            }
            if tb.max_time.0 != 0 && now > tb.max_time.0 {
                return reject(TxCode::TooLate, format!("close time {now} > max time {}", tb.max_time.0));
            }
        }
        let seq = self.info.sequence_number;
        if let Some(lb) = ledger_bounds {
            if seq < lb.min_ledger {
                return reject(TxCode::TooEarly, format!("ledger {seq} < min ledger {}", lb.min_ledger));
            }
            if lb.max_ledger != 0 && lb.max_ledger <= seq {
                return reject(TxCode::TooLate, format!("ledger {seq} >= max ledger {}", lb.max_ledger));
            }
        }

        // --- fee bid and declared resources ---
        if data.resource_fee < 0 {
            return reject(TxCode::SorobanInvalid, "negative resource fee");
        }
        let min_inclusion = self.base_fee as i64;
        let inclusion_bid = tx.fee as i64 - data.resource_fee;
        if inclusion_bid < min_inclusion {
            return reject(
                TxCode::InsufficientFee,
                format!("fee bid {} leaves {inclusion_bid} for inclusion after the {} resource fee; the minimum is {min_inclusion}", tx.fee, data.resource_fee),
            );
        }
        if let Some(r) = self.check_resources(data, size_bytes) {
            return Ok(Err(r));
        }
        let (non_refundable, _) = compute_transaction_resource_fee(&declared_resources(data, size_bytes), &self.config.fee_configuration);
        if data.resource_fee < non_refundable {
            return reject(
                TxCode::SorobanInvalid,
                format!("resource fee {} is below the {non_refundable} the declared resources cost", data.resource_fee),
            );
        }
        let fees = Fees {
            bid: tx.fee as i64,
            resource_fee: data.resource_fee,
            non_refundable,
            refundable: data.resource_fee - non_refundable,
            inclusion: inclusion_bid.min(min_inclusion),
        };

        // --- the source account: sequence number, signatures, balance ---
        let Some(account) = self.ledger.account(&source)? else {
            return reject(TxCode::NoAccount, format!("source account {source} does not exist"));
        };
        let acct_seq = account.seq_num.0;
        match v2.and_then(|p| p.min_seq_num.as_ref()) {
            Some(min) => {
                if acct_seq < min.0 || acct_seq >= tx.seq_num.0 {
                    return reject(TxCode::BadSeq, format!("account sequence {acct_seq} outside [{}, {})", min.0, tx.seq_num.0));
                }
            }
            None => {
                if tx.seq_num.0 != acct_seq.wrapping_add(1) {
                    return reject(TxCode::BadSeq, format!("transaction sequence {} != account sequence {acct_seq} + 1", tx.seq_num.0));
                }
            }
        }
        if let Some(p) = v2 {
            let (seq_ledger, seq_time) = seq_ledger_and_time(&account);
            if p.min_seq_age.0 > 0 && now.saturating_sub(seq_time) < p.min_seq_age.0 {
                return reject(TxCode::BadMinSeqAgeOrGap, format!("sequence age {} < {}", now.saturating_sub(seq_time), p.min_seq_age.0));
            }
            if p.min_seq_ledger_gap > 0 && seq.saturating_sub(seq_ledger) < p.min_seq_ledger_gap {
                return reject(TxCode::BadMinSeqAgeOrGap, format!("sequence ledger gap {} < {}", seq.saturating_sub(seq_ledger), p.min_seq_ledger_gap));
            }
        }

        let mut checker = SignatureChecker::new(hash, signatures.as_slice());
        let low = account.thresholds.0[1] as u32;
        if !checker.check(&source, &account_signers(&account), low) {
            return reject(TxCode::BadAuth, threshold_miss(&source, "low", low));
        }
        if let Some(p) = v2 {
            for extra in p.extra_signers.iter() {
                if !checker.check(&source, &[Signer { key: extra.clone(), weight: 1 }], 1) {
                    return reject(TxCode::BadAuth, format!("extra signer {extra} did not sign"));
                }
            }
        }
        // InvokeHostFunction needs the operation source's medium threshold.
        let op_account = if op_source == source {
            account.clone()
        } else {
            match self.ledger.account(&op_source)? {
                Some(a) => a,
                None => return reject(TxCode::NoAccount, format!("operation source {op_source} does not exist")),
            }
        };
        let med = op_account.thresholds.0[2] as u32;
        if !checker.check(&op_source, &account_signers(&op_account), med) {
            return reject(TxCode::OpBadAuth, threshold_miss(&op_source, "medium", med));
        }
        if let Some(unused) = checker.unused() {
            return reject(TxCode::BadAuthExtra, format!("signature {unused} matches no signer that was needed"));
        }

        let available = available_balance(&account, self.info.base_reserve);
        if available < fees.bid {
            return reject(
                TxCode::InsufficientBalance,
                format!("fee bid {} XLM, available {} XLM above the reserve", xlm(fees.bid), xlm(available)),
            );
        }

        let mut replayable = self.replayable(&checker.matched)?;
        for entry in ihf.auth.iter() {
            replayable.extend(self.auth_replayable(entry)?);
        }
        Ok(Ok(ValidTx {
            hash,
            source,
            seq_num: tx.seq_num.0,
            op_source,
            op: ihf.clone(),
            data: data.clone(),
            fees,
            size_bytes,
            signers: checker.matched,
            replayable,
        }))
    }

    /// stellar-core's per-transaction Soroban resource limits.
    fn check_resources(&self, data: &SorobanTransactionData, size_bytes: u32) -> Option<Rejection> {
        let r = &data.resources;
        let l = self.limits;
        let fp = &r.footprint;
        let mut seen = BTreeSet::new();
        for key in fp.read_only.iter().chain(fp.read_write.iter()) {
            if !matches!(key, LedgerKey::Account(_) | LedgerKey::Trustline(_) | LedgerKey::ContractData(_) | LedgerKey::ContractCode(_)) {
                return Some(Rejection { code: TxCode::SorobanInvalid, detail: format!("footprint key type {} is not allowed", key.name()) });
            }
            if !seen.insert(key) {
                return Some(Rejection { code: TxCode::SorobanInvalid, detail: "footprint has a duplicate key".into() });
            }
        }
        let declared = declared_resources(data, size_bytes);
        let footprint_entries = (fp.read_only.len() + fp.read_write.len()) as u32;
        let checks = [
            ("instructions", r.instructions as u64, l.tx_max_instructions),
            ("disk read bytes", r.disk_read_bytes as u64, l.tx_max_disk_read_bytes as u64),
            ("write bytes", r.write_bytes as u64, l.tx_max_write_bytes as u64),
            ("disk read entries", declared.disk_read_entries as u64, l.tx_max_disk_read_entries as u64),
            ("write entries", fp.read_write.len() as u64, l.tx_max_write_ledger_entries as u64),
            ("footprint entries", footprint_entries as u64, l.tx_max_footprint_entries as u64),
            ("transaction size", size_bytes as u64, l.tx_max_size_bytes as u64),
        ];
        checks.iter().find(|(_, used, max)| used > max).map(|(what, used, max)| Rejection {
            code: TxCode::SorobanInvalid,
            detail: format!("{what} {used} exceeds the network maximum {max}"),
        })
    }

    /// Signers that already sign for the account on the base network: an
    /// envelope they signed is valid there too.
    fn replayable(&self, matched: &[MatchedSigner]) -> Result<Vec<String>> {
        let mut out = vec![];
        for m in matched {
            let Some(base) = self.ledger.base_account(&m.account)? else { continue };
            if account_signers(&base).iter().any(|s| s.key == m.key) {
                out.push(format!("{} signed for {}, and it is a signer of that account on the base network", m.key, m.account));
            }
        }
        Ok(out)
    }

    /// Auth-entry signatures by G accounts (and their CAP-71 delegates) that
    /// verify with a key the BASE ledger already lists as a signer of that
    /// account: such an entry is valid on the real network too.
    fn auth_replayable(&self, entry: &SorobanAuthorizationEntry) -> Result<Vec<String>> {
        let (creds, delegates, bound) = match &entry.credentials {
            SorobanCredentials::SourceAccount => return Ok(vec![]),
            SorobanCredentials::Address(c) => (c, &[][..], false),
            SorobanCredentials::AddressV2(c) => (c, &[][..], true),
            SorobanCredentials::AddressWithDelegates(d) => (&d.address_credentials, d.delegates.as_slice(), true),
        };
        let payload = auth_payload(self.info.network_id, creds, entry, bound.then_some(&creds.address))?;
        let mut signed = vec![(&creds.address, &creds.signature)];
        let mut stack: Vec<&SorobanDelegateSignature> = delegates.iter().collect();
        while let Some(d) = stack.pop() {
            signed.push((&d.address, &d.signature));
            stack.extend(d.nested_delegates.iter());
        }
        let mut out = vec![];
        for (address, signature) in signed {
            let ScAddress::Account(id) = address else { continue };
            let Some(base) = self.ledger.base_account(id)? else { continue };
            let base_signers = account_signers(&base);
            for (pk, sig) in classic_auth_signatures(signature) {
                let key = SignerKey::Ed25519(Uint256(pk));
                if ed25519_ok(&pk, &payload, &sig) && base_signers.iter().any(|s| s.key == key) {
                    out.push(format!("{key} signed an auth entry for {id}, and it is a signer of that account on the base network"));
                }
            }
        }
        Ok(out)
    }
}

/// The `(public_key, signature)` pairs of a G account's auth signature,
/// `Vec<AccountEd25519Signature>`; anything else yields none.
fn classic_auth_signatures(signature: &ScVal) -> Vec<([u8; 32], Vec<u8>)> {
    let ScVal::Vec(Some(items)) = signature else { return vec![] };
    let field = |m: &ScMap, name: &str| {
        m.iter().find_map(|e| match (&e.key, &e.val) {
            (ScVal::Symbol(k), ScVal::Bytes(b)) if k.as_slice() == name.as_bytes() => Some(b.to_vec()),
            _ => None,
        })
    };
    items
        .iter()
        .filter_map(|item| {
            let ScVal::Map(Some(m)) = item else { return None };
            let pk: [u8; 32] = field(m, "public_key")?.try_into().ok()?;
            Some((pk, field(m, "signature")?))
        })
        .collect()
}

fn threshold_miss(account: &AccountId, level: &str, threshold: u32) -> String {
    if threshold == 0 {
        format!("no signature is from a signer of {account}")
    } else {
        format!("the signatures do not reach {account}'s {level} threshold {threshold}")
    }
}

/// The resources a transaction declares, as the fee functions count them.
/// Since protocol 23 only classic entries and restored archived entries are
/// disk reads.
pub fn declared_resources(data: &SorobanTransactionData, size_bytes: u32) -> TransactionResources {
    let r = &data.resources;
    let classic = |k: &&LedgerKey| !matches!(k, LedgerKey::ContractData(_) | LedgerKey::ContractCode(_));
    let restored = match &data.ext {
        SorobanTransactionDataExt::V1(x) => x.archived_soroban_entries.len() as u32,
        SorobanTransactionDataExt::V0 => 0,
    };
    TransactionResources {
        instructions: r.instructions,
        disk_read_entries: r.footprint.read_only.iter().filter(classic).count() as u32
            + r.footprint.read_write.iter().filter(classic).count() as u32
            + restored,
        write_entries: r.footprint.read_write.len() as u32,
        disk_read_bytes: r.disk_read_bytes,
        write_bytes: r.write_bytes,
        contract_events_size_bytes: 0,
        transaction_size_bytes: size_bytes,
    }
}

/// The master key (if its weight is above 0) followed by the account's signers.
pub fn account_signers(a: &AccountEntry) -> Vec<Signer> {
    let mut out = vec![];
    if a.thresholds.0[0] > 0 {
        let PublicKey::PublicKeyTypeEd25519(k) = &a.account_id.0;
        out.push(Signer { key: SignerKey::Ed25519(k.clone()), weight: a.thresholds.0[0] as u32 });
    }
    out.extend(a.signers.iter().cloned());
    out
}

/// Balance above the reserve and selling liabilities.
pub fn available_balance(a: &AccountEntry, base_reserve: u32) -> i64 {
    let (selling, sponsoring, sponsored) = match &a.ext {
        AccountEntryExt::V0 => (0, 0, 0),
        AccountEntryExt::V1(v1) => match &v1.ext {
            AccountEntryExtensionV1Ext::V0 => (v1.liabilities.selling, 0, 0),
            AccountEntryExtensionV1Ext::V2(v2) => (v1.liabilities.selling, v2.num_sponsoring as i64, v2.num_sponsored as i64),
        },
    };
    let entries = 2 + a.num_sub_entries as i64 + sponsoring - sponsored;
    a.balance - entries * base_reserve as i64 - selling
}

/// The ledger and close time of the account's last sequence bump.
pub fn seq_ledger_and_time(a: &AccountEntry) -> (u32, u64) {
    if let AccountEntryExt::V1(v1) = &a.ext {
        if let AccountEntryExtensionV1Ext::V2(v2) = &v1.ext {
            if let AccountEntryExtensionV2Ext::V3(v3) = &v2.ext {
                return (v3.seq_ledger, v3.seq_time.0);
            }
        }
    }
    (0, 0)
}

pub fn xlm(stroops: i64) -> String {
    format!("{:.7}", stroops as f64 / 1e7)
}

/// stellar-core's `SignatureChecker`: each signature can satisfy at most one
/// signer per check, weights are capped at 255, a check passes as soon as the
/// weight reaches the threshold, and every signature must have been used by
/// some check (`txBAD_AUTH_EXTRA` otherwise).
struct SignatureChecker<'a> {
    hash: [u8; 32],
    signatures: &'a [DecoratedSignature],
    used: Vec<bool>,
    matched: Vec<MatchedSigner>,
}

impl<'a> SignatureChecker<'a> {
    fn new(hash: [u8; 32], signatures: &'a [DecoratedSignature]) -> Self {
        Self { hash, signatures, used: vec![false; signatures.len()], matched: vec![] }
    }

    fn check(&mut self, account: &AccountId, signers: &[Signer], needed: u32) -> bool {
        let weight = |s: &Signer| s.weight.min(255);
        let mut total = 0u32;
        // Pre-authorized transaction hashes need no signature.
        for s in signers {
            if s.key == SignerKey::PreAuthTx(Uint256(self.hash)) {
                total += weight(s);
                self.record(account, s);
                if total >= needed {
                    return true;
                }
            }
        }
        let by_type = |pred: fn(&SignerKey) -> bool| -> Vec<Signer> { signers.iter().filter(|s| pred(&s.key)).cloned().collect() };
        let groups = [
            by_type(|k| matches!(k, SignerKey::HashX(_))),
            by_type(|k| matches!(k, SignerKey::Ed25519(_))),
            by_type(|k| matches!(k, SignerKey::Ed25519SignedPayload(_))),
        ];
        for mut group in groups {
            let signatures = self.signatures;
            for (i, sig) in signatures.iter().enumerate() {
                let Some(pos) = group.iter().position(|s| verify(&self.hash, sig, &s.key)) else { continue };
                self.used[i] = true;
                let s = group.remove(pos);
                total += weight(&s);
                self.record(account, &s);
                if total >= needed {
                    return true;
                }
            }
        }
        false
    }

    fn record(&mut self, account: &AccountId, s: &Signer) {
        let m = MatchedSigner { account: account.clone(), key: s.key.clone(), weight: s.weight.min(255) };
        if !self.matched.contains(&m) {
            self.matched.push(m);
        }
    }

    /// The hint of the first signature no check used.
    fn unused(&self) -> Option<String> {
        self.used.iter().position(|u| !u).map(|i| hex(&self.signatures[i].hint.0))
    }
}

fn verify(hash: &[u8; 32], sig: &DecoratedSignature, key: &SignerKey) -> bool {
    match key {
        SignerKey::Ed25519(Uint256(pk)) => pk[28..] == sig.hint.0 && ed25519_ok(pk, hash, sig.signature.as_slice()),
        SignerKey::HashX(Uint256(x)) => {
            x[28..] == sig.hint.0 && Sha256::digest(sig.signature.as_slice())[..] == x[..]
        }
        SignerKey::Ed25519SignedPayload(SignerKeyEd25519SignedPayload { ed25519: Uint256(pk), payload }) => {
            let mut tail = [0u8; 4];
            let p = payload.as_slice();
            let n = p.len().min(4);
            tail[..n].copy_from_slice(&p[p.len() - n..]);
            let hint: Vec<u8> = pk[28..].iter().zip(tail).map(|(a, b)| a ^ b).collect();
            hint == sig.hint.0 && ed25519_ok(pk, p, sig.signature.as_slice())
        }
        SignerKey::PreAuthTx(_) => false,
    }
}

fn ed25519_ok(pk: &[u8; 32], msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(vk), Ok(sig)) = (VerifyingKey::from_bytes(pk), Signature::from_slice(sig)) else { return false };
    vk.verify(msg, &sig).is_ok()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The entry with a bumped sequence number, as core's `processSeqNum` leaves
/// it since protocol 19: the account's sequence ledger and time are recorded
/// in its v3 extension.
pub fn bump_sequence(a: &mut AccountEntry, to: i64, ledger_seq: u32, close_time: u64) {
    use soroban_env_host::xdr::{
        AccountEntryExtensionV1, AccountEntryExtensionV2, AccountEntryExtensionV3, ExtensionPoint, Liabilities,
        SponsorshipDescriptor, TimePoint,
    };
    a.seq_num.0 = to;
    let v3 = AccountEntryExtensionV3 { ext: ExtensionPoint::V0, seq_ledger: ledger_seq, seq_time: TimePoint(close_time) };
    let mut v1 = match std::mem::replace(&mut a.ext, AccountEntryExt::V0) {
        AccountEntryExt::V1(v1) => v1,
        AccountEntryExt::V0 => AccountEntryExtensionV1 { liabilities: Liabilities { buying: 0, selling: 0 }, ext: AccountEntryExtensionV1Ext::V0 },
    };
    let mut v2 = match std::mem::replace(&mut v1.ext, AccountEntryExtensionV1Ext::V0) {
        AccountEntryExtensionV1Ext::V2(v2) => v2,
        AccountEntryExtensionV1Ext::V0 => AccountEntryExtensionV2 {
            num_sponsored: 0,
            num_sponsoring: 0,
            signer_sponsoring_i_ds: vec![SponsorshipDescriptor(None); a.signers.len()].try_into().unwrap_or_default(),
            ext: AccountEntryExtensionV2Ext::V0,
        },
    };
    v2.ext = AccountEntryExtensionV2Ext::V3(v3);
    v1.ext = AccountEntryExtensionV1Ext::V2(v2);
    a.ext = AccountEntryExt::V1(v1);
}
