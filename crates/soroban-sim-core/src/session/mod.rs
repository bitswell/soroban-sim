//! A network session: many signed transactions applied in order over a forked
//! ledger, with state carried between them and a clock that closes ledgers.
//!
//! ```text
//! Session
//!   prepare(): simulate (recording) -> sign auth entries -> re-simulate
//!              (enforcing, so signature checks are metered) -> signed envelope
//!   submit():  TxValidator (seq, preconditions, signatures + thresholds, fee,
//!              balance, resource limits) -> Applier (fee charged first,
//!              enforcing host + module cache, rent, refund) -> close ledger
//!   ForkedLedger: overlay + logged overrides over a lazily fetched base
//! ```
//!
//! `submit` treats every envelope as untrusted input, the way stellar-core
//! does. `prepare` is only a convenience for building envelopes the session's
//! throwaway signers sign. Fidelity: the host is exact (same env-host as the
//! network's protocol); the transaction layer ports stellar-core's checks and
//! is approximate where noted (one transaction per ledger, no surge pricing,
//! no fee-bump or classic operations).

mod applier;
mod ledger;
mod signers;
mod validator;

pub use applier::{Applied, Applier};
pub use ledger::{
    account_key, ed25519_account_id, new_account, strkey_ed25519, Change, DiffEntry, EntryState,
    FetchRecord, FetchedBatch, ForkView, ForkedLedger, LedgerSource, LedgerStats, Override,
    OverrideKind, StaticSource, StoredEntry,
};
pub use signers::{
    auth_payload, base64url, oz_digest, sign_auth_entry, webauthn_sig_data, AuthSigner,
    Ed25519Key, ExternalKey, OzDigest, OzSigner, Secp256r1Key, WebAuthnAssertion,
    ADDR_OZ_V1_DOMAIN, WEBAUTHN_RP_ID,
};
pub use validator::{
    account_signers, available_balance, declared_resources, muxed_account_id, transaction_hash,
    xlm, Fees, MatchedSigner, Rejection, TxCode, TxLimits, TxValidator, ValidTx,
};

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use soroban_env_host::e2e_invoke::RecordingInvocationAuthMode;
use soroban_env_host::xdr::{
    AccountId, ContractEvent, DiagnosticEvent, HostFunction, InvokeHostFunctionOp, Memo,
    MuxedAccount, Operation, OperationBody, Preconditions, PublicKey, ScAddress, ScVal,
    SequenceNumber, SorobanAuthorizationEntry, SorobanCredentials, SorobanTransactionData,
    Transaction, TransactionEnvelope, TransactionExt, TransactionV1Envelope,
};
use soroban_env_host::{meta, LedgerInfo};
use soroban_simulation::simulation::{
    simulate_invoke_host_function_op, InvokeHostFunctionSimulationResult, SimulationAdjustmentConfig,
};
use soroban_simulation::NetworkConfig;
use std::collections::BTreeMap;
use std::rc::Rc;

/// The last closed ledger of the base network when the session forks.
#[derive(Clone, Debug)]
pub struct ForkPoint {
    pub ledger_seq: u32,
    pub close_time: u64,
    pub protocol_version: u32,
    pub base_reserve: u32,
    pub base_fee: u32,
}

#[derive(Debug)]
pub struct SessionOptions {
    pub network_passphrase: String,
    /// Close-time step between ledgers (the network's target is 5 s).
    pub seconds_per_ledger: u64,
    /// How long prepared auth signatures stay valid, in ledgers.
    pub auth_expiration_ledgers: u32,
    /// `None` loads the network config from the ledger's `ConfigSetting` entries.
    pub network_config: Option<NetworkConfig>,
    /// `None` loads the per-transaction limits from the ledger.
    pub tx_limits: Option<TxLimits>,
    pub enable_diagnostics: bool,
}

impl Clone for SessionOptions {
    fn clone(&self) -> Self {
        Self {
            network_passphrase: self.network_passphrase.clone(),
            seconds_per_ledger: self.seconds_per_ledger,
            auth_expiration_ledgers: self.auth_expiration_ledgers,
            network_config: self.network_config.as_ref().map(clone_network_config),
            tx_limits: self.tx_limits.clone(),
            enable_diagnostics: self.enable_diagnostics,
        }
    }
}

impl SessionOptions {
    pub fn new(network_passphrase: &str) -> Self {
        Self {
            network_passphrase: network_passphrase.to_string(),
            seconds_per_ledger: 5,
            auth_expiration_ledgers: 100,
            network_config: None,
            tx_limits: None,
            enable_diagnostics: true,
        }
    }
}

/// How a submitted transaction ended.
#[derive(Clone, Debug)]
pub enum TxStatus {
    /// Applied: fee charged, state committed.
    Applied { value: ScVal },
    /// Included but the operation failed: fee charged, sequence consumed,
    /// no state change.
    Failed { reason: String },
    /// Refused before inclusion: no fee, no sequence number consumed.
    Rejected { code: TxCode, detail: String },
}

impl TxStatus {
    pub fn is_applied(&self) -> bool {
        matches!(self, Self::Applied { .. })
    }

    /// One line: the return value, the failure reason, or the result code.
    pub fn summary(&self) -> String {
        match self {
            Self::Applied { value } => show_scval(value),
            Self::Failed { reason } => format!("txFAILED: {reason}"),
            Self::Rejected { code, detail } => format!("{}: {detail}", code.as_str()),
        }
    }
}

/// One submitted transaction, for the report.
#[derive(Clone, Debug)]
pub struct TxRecord {
    pub label: String,
    /// The ledger it applied in (or would have, if rejected).
    pub ledger: u32,
    pub close_time: u64,
    pub hash: [u8; 32],
    pub source: Option<AccountId>,
    pub status: TxStatus,
    /// Declared fees (zero for rejected envelopes).
    pub fees: Fees,
    pub fee_charged: i64,
    pub refund: i64,
    pub rent_fee: i64,
    pub events_fee: i64,
    pub cpu_insns: u64,
    pub declared_insns: u32,
    pub mem_bytes: u64,
    pub write_bytes: u32,
    pub declared_write_bytes: u32,
    pub entries_written: u32,
    pub restored: u32,
    pub events: Vec<ContractEvent>,
    pub diagnostics: Vec<DiagnosticEvent>,
    pub signers: Vec<MatchedSigner>,
    pub replayable: Vec<String>,
}

impl TxRecord {
    /// Contract error codes anywhere in the diagnostics (for example OZ's
    /// 3002), which the host's own escalation errors can hide.
    pub fn contract_errors(&self) -> Vec<u32> {
        contract_errors(&self.diagnostics)
    }
}

/// An envelope `prepare` built and signed.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub envelope: TransactionEnvelope,
    pub hash: [u8; 32],
    /// The value the enforcing re-simulation returned.
    pub value: ScVal,
    pub transaction_data: SorobanTransactionData,
    /// The signed authorization entries in the envelope.
    pub auth: Vec<SorobanAuthorizationEntry>,
    /// The recording pass, before signing: the same inputs RPC
    /// `simulateTransaction` sees, for differential checks.
    pub recorded: Recorded,
}

/// What recording-mode simulation produced.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub value: ScVal,
    pub transaction_data: SorobanTransactionData,
    pub auth: Vec<SorobanAuthorizationEntry>,
}

/// Finds the signer for an address that must authorize a call. `prepare`
/// asks only for the addresses the recorded authorization names.
pub trait AuthSignerSource {
    fn signer_for(&self, session: &Session, address: &ScAddress) -> Result<Option<AuthSigner>>;
}

impl AuthSignerSource for BTreeMap<ScAddress, AuthSigner> {
    fn signer_for(&self, _: &Session, address: &ScAddress) -> Result<Option<AuthSigner>> {
        Ok(self.get(address).cloned())
    }
}

/// What `prepare` needs besides the host function.
pub struct PrepareRequest<'a> {
    pub source: AccountId,
    pub host_function: HostFunction,
    /// Signers for every non-source-account address that must authorize.
    pub auth_signers: &'a dyn AuthSignerSource,
    /// Keys that sign the envelope.
    pub envelope_signers: &'a [Ed25519Key],
    /// Overrides [`SessionOptions::auth_expiration_ledgers`].
    pub auth_expiration_ledgers: Option<u32>,
    pub memo: Memo,
    pub preconditions: Preconditions,
}

pub struct Session {
    ledger: Rc<ForkedLedger>,
    info: LedgerInfo,
    fork: ForkPoint,
    options: SessionOptions,
    network_config: NetworkConfig,
    limits: TxLimits,
    applier: Applier,
    log: Vec<TxRecord>,
}

/// The protocol the linked soroban-env-host implements.
pub fn host_protocol() -> u32 {
    meta::INTERFACE_VERSION.protocol
}

pub fn network_id(passphrase: &str) -> [u8; 32] {
    Sha256::digest(passphrase.as_bytes()).into()
}

impl Session {
    /// Fork `base` at `fork`. The base's protocol must be the host's: a
    /// rehearsal on a different protocol rehearses a different network.
    pub fn new(base: Box<dyn LedgerSource>, fork: ForkPoint, options: SessionOptions) -> Result<Self> {
        if fork.protocol_version != host_protocol() {
            bail!(
                "the network is on protocol {}, but this host implements protocol {}; exact protocol parity is required",
                fork.protocol_version,
                host_protocol()
            );
        }
        let ledger = Rc::new(ForkedLedger::new(base, fork.ledger_seq));
        let view = ForkView(ledger.clone());
        let network_config = match options.network_config.as_ref().map(clone_network_config) {
            Some(c) => c,
            None => NetworkConfig::load_from_snapshot(&view).map_err(|e| with_fetch_error(e, &ledger)).context("loading the network config")?,
        };
        let limits = match options.tx_limits.clone() {
            Some(l) => l,
            None => TxLimits::load_from_snapshot(&view).map_err(|e| with_fetch_error(e, &ledger)).context("loading the transaction limits")?,
        };
        let mut info = LedgerInfo {
            protocol_version: fork.protocol_version,
            sequence_number: fork.ledger_seq + 1,
            timestamp: fork.close_time + options.seconds_per_ledger,
            network_id: network_id(&options.network_passphrase),
            base_reserve: fork.base_reserve,
            min_temp_entry_ttl: 0,
            min_persistent_entry_ttl: 0,
            max_entry_ttl: 0,
        };
        network_config.fill_config_fields_in_ledger_info(&mut info);
        let applier = Applier::new(&network_config)?;
        Ok(Self { ledger, info, fork, options, network_config, limits, applier, log: vec![] })
    }

    pub fn ledger(&self) -> &ForkedLedger {
        &self.ledger
    }

    /// The ledger the next transaction applies in.
    pub fn ledger_info(&self) -> &LedgerInfo {
        &self.info
    }

    pub fn fork_point(&self) -> &ForkPoint {
        &self.fork
    }

    pub fn options(&self) -> &SessionOptions {
        &self.options
    }

    pub fn network_config(&self) -> &NetworkConfig {
        &self.network_config
    }

    pub fn tx_limits(&self) -> &TxLimits {
        &self.limits
    }

    pub fn network_id(&self) -> [u8; 32] {
        self.info.network_id
    }

    pub fn log(&self) -> &[TxRecord] {
        &self.log
    }

    pub fn applier(&self) -> &Applier {
        &self.applier
    }

    // --- clock ---

    /// Close the current ledger and open the next one.
    pub fn close_ledger(&mut self) {
        self.advance(1, None);
    }

    /// Close `ledgers` ledgers at once, moving the close time by `seconds`
    /// (default: `ledgers` × the per-ledger step). TTLs follow the sequence
    /// number, so expiry and archival come from this.
    pub fn advance(&mut self, ledgers: u32, seconds: Option<u64>) {
        self.info.sequence_number += ledgers;
        self.info.timestamp += seconds.unwrap_or(ledgers as u64 * self.options.seconds_per_ledger);
    }

    /// Advance until the next transaction applies in ledger `seq`.
    pub fn warp_to_ledger(&mut self, seq: u32) -> Result<()> {
        if seq < self.info.sequence_number {
            bail!("cannot warp back from ledger {} to {seq}", self.info.sequence_number);
        }
        self.advance(seq - self.info.sequence_number, None);
        Ok(())
    }

    /// Advance whole ledgers until the close time reaches `time`.
    pub fn warp_to_time(&mut self, time: u64) -> Result<()> {
        if time < self.info.timestamp {
            bail!("cannot warp back from close time {} to {time}", self.info.timestamp);
        }
        let step = self.options.seconds_per_ledger.max(1);
        let ledgers = (time - self.info.timestamp).div_ceil(step);
        self.advance(ledgers.try_into()?, None);
        Ok(())
    }

    // --- overrides (each one is logged for the report) ---

    pub fn substitute_master_key(&self, id: &AccountId, throwaway: &Ed25519Key, label: &str) -> Result<()> {
        self.ledger.substitute_master_key(id, throwaway.public_key(), label, self.info.sequence_number)
    }

    pub fn substitute_signer(&self, id: &AccountId, real: [u8; 32], throwaway: &Ed25519Key, label: &str) -> Result<()> {
        self.ledger.substitute_signer(id, real, throwaway.public_key(), label, self.info.sequence_number)
    }

    pub fn fund(&self, id: &AccountId, stroops: i64, label: &str) -> Result<()> {
        self.ledger.fund(id, stroops, label, self.info.sequence_number)
    }

    pub fn set_entry(&self, entry: StoredEntry, label: &str) -> Result<()> {
        self.ledger.set_entry(entry, label, self.info.sequence_number)
    }

    pub fn remove_entry(&self, key: &soroban_env_host::xdr::LedgerKey, label: &str) -> Result<()> {
        self.ledger.remove_entry(key, label, self.info.sequence_number)
    }

    // --- simulation ---

    /// Simulate `host_function` against the session's current state.
    pub fn simulate(&self, source: &AccountId, host_function: &HostFunction, auth: RecordingInvocationAuthMode) -> Result<InvokeHostFunctionSimulationResult> {
        let seed = prng_seed(b"simulate", self.info.sequence_number, self.log.len() as u32);
        let result = simulate_invoke_host_function_op(
            Rc::new(ForkView(self.ledger.clone())),
            &self.network_config,
            &SimulationAdjustmentConfig::default_adjustment(),
            &self.info,
            host_function.clone(),
            auth,
            source,
            seed,
            self.options.enable_diagnostics,
        )
        .map_err(|e| with_fetch_error(e, &self.ledger))?;
        if let Some(e) = self.ledger.take_fetch_error() {
            bail!("reading the base ledger failed: {e}");
        }
        Ok(result)
    }

    /// A read-only call against the current state, like `--send=no`: no auth
    /// is enforced and nothing is committed. `Ok(Err(_))` is the call failing.
    pub fn view(&self, host_function: &HostFunction) -> Result<std::result::Result<ScVal, String>> {
        let viewer = ed25519_account_id(Sha256::digest(b"soroban-sim viewer").into());
        let r = self.simulate(&viewer, host_function, RecordingInvocationAuthMode::recording(false, false))?;
        Ok(r.invoke_result.map_err(|e| format!("{:?}{}", e.error, diagnostics_tail(&r.diagnostic_events))))
    }

    /// Build and sign an envelope for `request.host_function` against the
    /// current state: simulate in recording mode, sign every address
    /// credential with the signer registered for its address, re-simulate in
    /// enforcing mode with the signed entries (so signature checks are
    /// metered into the declared resources), then sign the envelope with the
    /// next sequence number and an inclusion fee of the base fee.
    pub fn prepare(&self, request: &PrepareRequest<'_>) -> Result<Prepared> {
        // Non-root auth disabled, plain `Address` credentials: what RPC records.
        let recorded = self.simulate(&request.source, &request.host_function, RecordingInvocationAuthMode::recording(true, false))?;
        let recorded_value = match &recorded.invoke_result {
            Ok(v) => v.clone(),
            Err(e) => bail!("simulation failed: {:?}{}", e.error, diagnostics_tail(&recorded.diagnostic_events)),
        };
        let recorded_data = recorded.transaction_data.clone().ok_or_else(|| anyhow!("simulation returned no transaction data"))?;
        let expiration = self.info.sequence_number + request.auth_expiration_ledgers.unwrap_or(self.options.auth_expiration_ledgers);
        let mut auth = recorded.auth.clone();
        for entry in &mut auth {
            let address = match &entry.credentials {
                SorobanCredentials::Address(c) | SorobanCredentials::AddressV2(c) => c.address.clone(),
                _ => continue,
            };
            let signer = request
                .auth_signers
                .signer_for(self, &address)?
                .ok_or_else(|| anyhow!("{address} must authorize this call, but no signer is registered for it"))?;
            sign_auth_entry(entry, &signer, self.info.network_id, expiration).with_context(|| format!("signing for {address}"))?;
        }
        let enforced = self.simulate(&request.source, &request.host_function, RecordingInvocationAuthMode::Enforcing(auth.clone()))?;
        let value = enforced
            .invoke_result
            .clone()
            .map_err(|e| anyhow!("enforcing simulation failed: {:?}{}", e.error, diagnostics_tail(&enforced.diagnostic_events)))?;
        let data = enforced.transaction_data.clone().ok_or_else(|| anyhow!("simulation returned no transaction data"))?;
        let account = self.ledger.account(&request.source)?.ok_or_else(|| anyhow!("source account {} is not on the ledger", request.source))?;
        let fee = data.resource_fee + self.fork.base_fee as i64;
        let PublicKey::PublicKeyTypeEd25519(source_key) = &request.source.0;
        let tx = Transaction {
            source_account: MuxedAccount::Ed25519(source_key.clone()),
            fee: fee.try_into().map_err(|_| anyhow!("fee {fee} does not fit a u32 bid"))?,
            seq_num: SequenceNumber(account.seq_num.0 + 1),
            cond: request.preconditions.clone(),
            memo: request.memo.clone(),
            operations: vec![Operation {
                source_account: None,
                body: OperationBody::InvokeHostFunction(InvokeHostFunctionOp {
                    host_function: request.host_function.clone(),
                    auth: auth.clone().try_into()?,
                }),
            }]
            .try_into()?,
            ext: TransactionExt::V1(data.clone()),
        };
        let hash = transaction_hash(&tx, self.info.network_id)?;
        let signatures: Vec<_> = request.envelope_signers.iter().map(|k| k.sign_decorated(&hash)).collect();
        Ok(Prepared {
            envelope: TransactionEnvelope::Tx(TransactionV1Envelope { tx, signatures: signatures.try_into()? }),
            hash,
            value,
            transaction_data: data,
            recorded: Recorded { value: recorded_value, transaction_data: recorded_data, auth: recorded.auth },
            auth,
        })
    }

    /// Validate and apply one envelope. A valid envelope closes the ledger it
    /// applied in, success or failure; a rejected one never reaches a ledger.
    pub fn submit(&mut self, label: &str, envelope: &TransactionEnvelope) -> Result<TxRecord> {
        let validator = TxValidator {
            ledger: &self.ledger,
            info: &self.info,
            config: &self.network_config,
            limits: &self.limits,
            base_fee: self.fork.base_fee,
        };
        let mut record = TxRecord {
            label: label.to_string(),
            ledger: self.info.sequence_number,
            close_time: self.info.timestamp,
            hash: [0; 32],
            source: None,
            status: TxStatus::Rejected { code: TxCode::Malformed, detail: String::new() },
            fees: Fees::default(),
            fee_charged: 0,
            refund: 0,
            rent_fee: 0,
            events_fee: 0,
            cpu_insns: 0,
            declared_insns: 0,
            mem_bytes: 0,
            write_bytes: 0,
            declared_write_bytes: 0,
            entries_written: 0,
            restored: 0,
            events: vec![],
            diagnostics: vec![],
            signers: vec![],
            replayable: vec![],
        };
        if let TransactionEnvelope::Tx(e) = envelope {
            record.hash = transaction_hash(&e.tx, self.info.network_id)?;
            record.source = Some(muxed_account_id(&e.tx.source_account));
        }
        let valid = match validator.validate(envelope).map_err(|e| with_fetch_error(e, &self.ledger))? {
            Ok(v) => v,
            Err(r) => {
                record.status = TxStatus::Rejected { code: r.code, detail: r.detail };
                self.log.push(record.clone());
                return Ok(record);
            }
        };
        let applied = self
            .applier
            .apply(&self.ledger, &self.info, &self.network_config, &self.limits, &valid, self.options.enable_diagnostics)
            .map_err(|e| with_fetch_error(e, &self.ledger))?;
        record.fees = valid.fees;
        record.fee_charged = applied.fee_charged;
        record.refund = applied.refund;
        record.rent_fee = applied.rent_fee;
        record.events_fee = applied.events_fee;
        record.cpu_insns = applied.cpu_insns;
        record.declared_insns = valid.data.resources.instructions;
        record.mem_bytes = applied.mem_bytes;
        record.write_bytes = applied.write_bytes;
        record.declared_write_bytes = valid.data.resources.write_bytes;
        record.entries_written = applied.entries_written;
        record.restored = applied.restored;
        record.events = applied.events;
        record.diagnostics = applied.diagnostics;
        record.signers = valid.signers;
        record.replayable = valid.replayable;
        record.status = match applied.result {
            Ok(value) => TxStatus::Applied { value },
            Err(reason) => TxStatus::Failed { reason: format!("{reason}{}", diagnostics_tail(&record.diagnostics)) },
        };
        self.log.push(record.clone());
        self.close_ledger();
        Ok(record)
    }
}

/// `NetworkConfig` is not `Clone` upstream.
pub fn clone_network_config(c: &NetworkConfig) -> NetworkConfig {
    use soroban_env_host::fees::{FeeConfiguration, RentFeeConfiguration};
    let f = &c.fee_configuration;
    let r = &c.rent_fee_configuration;
    NetworkConfig {
        fee_configuration: FeeConfiguration {
            fee_per_instruction_increment: f.fee_per_instruction_increment,
            fee_per_disk_read_entry: f.fee_per_disk_read_entry,
            fee_per_write_entry: f.fee_per_write_entry,
            fee_per_disk_read_1kb: f.fee_per_disk_read_1kb,
            fee_per_write_1kb: f.fee_per_write_1kb,
            fee_per_historical_1kb: f.fee_per_historical_1kb,
            fee_per_contract_event_1kb: f.fee_per_contract_event_1kb,
            fee_per_transaction_size_1kb: f.fee_per_transaction_size_1kb,
        },
        rent_fee_configuration: RentFeeConfiguration {
            fee_per_rent_1kb: r.fee_per_rent_1kb,
            fee_per_write_1kb: r.fee_per_write_1kb,
            fee_per_write_entry: r.fee_per_write_entry,
            persistent_rent_rate_denominator: r.persistent_rent_rate_denominator,
            temporary_rent_rate_denominator: r.temporary_rent_rate_denominator,
        },
        tx_max_instructions: c.tx_max_instructions,
        tx_memory_limit: c.tx_memory_limit,
        cpu_cost_params: c.cpu_cost_params.clone(),
        memory_cost_params: c.memory_cost_params.clone(),
        min_temp_entry_ttl: c.min_temp_entry_ttl,
        min_persistent_entry_ttl: c.min_persistent_entry_ttl,
        max_entry_ttl: c.max_entry_ttl,
    }
}

/// Prefer the base fetch failure over the generic storage error the host
/// turned it into.
fn with_fetch_error(e: anyhow::Error, ledger: &ForkedLedger) -> anyhow::Error {
    match ledger.take_fetch_error() {
        Some(fetch) => anyhow!("reading the base ledger failed: {fetch}").context(e.to_string()),
        None => e,
    }
}

/// A deterministic per-transaction PRNG seed. (stellar-core derives its seed
/// differently, so contracts that use the PRNG see other values on chain.)
pub(crate) fn prng_seed(domain: &[u8], ledger: u32, index: u32) -> [u8; 32] {
    Sha256::digest([b"soroban-sim session:".as_slice(), domain, &ledger.to_be_bytes(), &index.to_be_bytes()].concat()).into()
}

/// Contract error codes in a list of diagnostic events.
pub fn contract_errors(events: &[DiagnosticEvent]) -> Vec<u32> {
    use soroban_env_host::xdr::{ContractEventBody, ScError};
    let mut codes = vec![];
    let mut visit = |v: &ScVal| {
        if let ScVal::Error(ScError::Contract(c)) = v {
            codes.push(*c);
        }
    };
    for e in events {
        let ContractEventBody::V0(body) = &e.event.body;
        body.topics.iter().for_each(&mut visit);
        visit(&body.data);
        if let ScVal::Vec(Some(items)) = &body.data {
            items.iter().for_each(&mut visit);
        }
    }
    codes.sort_unstable();
    codes.dedup();
    codes
}

/// A short tail of the diagnostics for error messages.
pub fn diagnostics_tail(events: &[DiagnosticEvent]) -> String {
    let codes = contract_errors(events);
    let codes = if codes.is_empty() {
        String::new()
    } else {
        format!(" [contract errors: {}]", codes.iter().map(u32::to_string).collect::<Vec<_>>().join(", "))
    };
    let last: Vec<String> = events
        .iter()
        .rev()
        .take(2)
        .map(|e| {
            clip(&format!("{:?}", e.event.body), 240)
        })
        .collect();
    if last.is_empty() {
        codes
    } else {
        format!(" [diagnostics: {}]{codes}", last.join(" | "))
    }
}

/// A short human rendering of a value.
pub fn show_scval(v: &ScVal) -> String {
    match v {
        ScVal::Address(a) => a.to_string(),
        ScVal::Void => "()".into(),
        ScVal::Bool(b) => b.to_string(),
        ScVal::U32(n) => n.to_string(),
        ScVal::I32(n) => n.to_string(),
        ScVal::U64(n) => n.to_string(),
        ScVal::I64(n) => n.to_string(),
        ScVal::I128(p) => (((p.hi as i128) << 64) | p.lo as i128).to_string(),
        ScVal::U128(p) => (((p.hi as u128) << 64) | p.lo as u128).to_string(),
        ScVal::Bytes(b) => b.iter().map(|x| format!("{x:02x}")).collect(),
        ScVal::String(s) => format!("{:?}", s.to_utf8_string_lossy()),
        ScVal::Symbol(s) => s.to_utf8_string_lossy(),
        other => clip(&format!("{other:?}"), 200),
    }
}

/// `s` cut to at most `max_chars` characters, with an ellipsis if cut.
pub fn clip(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_string(),
    }
}
