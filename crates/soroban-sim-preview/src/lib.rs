//! The signing-preview reactor behind `@theahaco/soroban-sign-dialog`: the
//! smallest soroban-sim build a wallet's signing preview needs, for
//! `wasm32-wasip1`.
//!
//! It runs one Soroban transaction against ledger entries the caller provides
//! and reports, in a small binary framing (no JSON, no serde):
//!
//! - **record**: recording-mode simulation. The authorization tree the host
//!   records on its own, the return value, events and ledger diffs.
//! - **enforce**: enforcing-mode simulation of the request's own entries, with
//!   address credentials of hinted accounts filled with an OpenZeppelin-style
//!   `AuthPayload` (Perch reads it) and the named verifier contracts swapped
//!   for an accept-all stub. The account's own policy then decides, before
//!   anyone signs. The swap exists only in this reactor's in-memory ledger.
//!
//! State is lazy: a run that reads a key nobody provided stops and returns the
//! keys to fetch (`needs-state`), as soroban-sim's `simulate` does. Contract
//! code comes from ledger state like any other entry.
//!
//! One build implements one host protocol, chosen by the `p29` or `p30`
//! feature. The reactor depends on the host directly rather than on
//! `soroban-sim-core`, whose host is pinned to the workspace's protocol.

#[cfg(all(feature = "p29", feature = "p30"))]
compile_error!("enable exactly one of the `p29` and `p30` features");
#[cfg(not(any(feature = "p29", feature = "p30")))]
compile_error!("enable one of the `p29` and `p30` features");

#[cfg(feature = "p29")]
use {soroban_env_host_p29 as host, soroban_simulation_p29 as simulation};
#[cfg(feature = "p30")]
use {soroban_env_host_p30 as host, soroban_simulation_p30 as simulation};

/// The linked host's XDR types, for embedders and tests.
pub use host::xdr;

use host::e2e_invoke::RecordingInvocationAuthMode;
use host::storage::{EntryWithLiveUntil, SnapshotSource};
use host::xdr::*;
use host::{HostError, LedgerInfo};
use sha2::{Digest, Sha256};
use simulation::simulation::{simulate_invoke_host_function_op, SimulationAdjustmentConfig};
use simulation::NetworkConfig;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

/// `fixtures/contracts/preview-stub-verifier`: `verify` returns true for any
/// input. Swapped in for a hinted account's verifier, in this reactor's
/// in-memory ledger only.
pub const STUB_VERIFIER: &[u8] = include_bytes!("../stub/stub_verifier.wasm");

pub const OP_PROVIDE: u8 = 1;
pub const OP_RESET: u8 = 2;
pub const OP_RUN: u8 = 3;

pub const MODE_RECORD: u8 = 0;
pub const MODE_ENFORCE: u8 = 1;

pub const ST_COMPLETE: u8 = 0;
pub const ST_NEEDS_STATE: u8 = 1;
pub const ST_ERROR: u8 = 2;

/// The protocol the linked soroban-env-host implements.
pub fn host_protocol() -> u32 {
    host::meta::INTERFACE_VERSION.protocol
}

/// Entries the embedder provided: present (with TTL) or proven absent.
#[derive(Default)]
struct Store {
    present: BTreeMap<LedgerKey, (LedgerEntry, Option<u32>)>,
    absent: BTreeSet<LedgerKey>,
}

thread_local! {
    static STORE: RefCell<Store> = RefCell::new(Store::default());
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

// --- snapshot --------------------------------------------------------------

/// Present, absent, or unknown. An unknown read records the key and fails
/// with `(Storage, ExceededLimit)`: non-recoverable, so a nested `try_call`
/// cannot swallow it, and never produced by the host in recording mode.
struct Snapshot {
    present: BTreeMap<LedgerKey, EntryWithLiveUntil>,
    absent: BTreeSet<LedgerKey>,
    needed: RefCell<BTreeSet<LedgerKey>>,
}

impl SnapshotSource for Snapshot {
    fn get(&self, key: &Rc<LedgerKey>) -> Result<Option<EntryWithLiveUntil>, HostError> {
        if let Some(e) = self.present.get(key.as_ref()) {
            return Ok(Some(e.clone()));
        }
        if self.absent.contains(key.as_ref()) {
            return Ok(None);
        }
        let unknown = || HostError::from((ScErrorType::Storage, ScErrorCode::ExceededLimit));
        self.needed
            .try_borrow_mut()
            .map_err(|_| unknown())?
            .insert((**key).clone());
        Err(unknown())
    }
}

impl Snapshot {
    fn take_needed(&self) -> Vec<LedgerKey> {
        std::mem::take(&mut *self.needed.borrow_mut())
            .into_iter()
            .collect()
    }
}

// --- framing ---------------------------------------------------------------

struct In<'a>(&'a [u8]);

impl<'a> In<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.0.len() < n {
            return Err("request truncated".into());
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Ok(a)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn id(&mut self) -> Result<[u8; 32], String> {
        Ok(self.take(32)?.try_into().unwrap())
    }
    fn blob(&mut self) -> Result<&'a [u8], String> {
        let n = self.u32()? as usize;
        self.take(n)
    }
    fn xdr<T: ReadXdr>(&mut self, what: &str) -> Result<T, String> {
        T::from_xdr(self.blob()?, Limits::none()).map_err(|e| format!("{what}: {e}"))
    }
}

#[derive(Default)]
struct Out(Vec<u8>);

impl Out {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn blob(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.0.extend_from_slice(b);
    }
    fn xdr<T: WriteXdr>(&mut self, v: &T) {
        self.blob(&v.to_xdr(Limits::none()).unwrap_or_default());
    }
    fn list<T>(&mut self, items: &[T], mut f: impl FnMut(&mut Self, &T)) {
        self.u32(items.len() as u32);
        for x in items {
            f(self, x);
        }
    }
}

// --- operations ------------------------------------------------------------

/// One call: an op byte, then its payload. Returns the response bytes.
pub fn call(input: &[u8]) -> Vec<u8> {
    let mut out = Out::default();
    if let Err(e) = dispatch(&mut In(input), &mut out) {
        out = Out::default();
        out.u8(ST_ERROR);
        out.blob(e.as_bytes());
    }
    out.0
}

fn dispatch(r: &mut In<'_>, out: &mut Out) -> Result<(), String> {
    match r.u8()? {
        OP_PROVIDE => {
            let n = r.u32()?;
            let mut present = Vec::with_capacity(n as usize);
            for _ in 0..n {
                let entry: LedgerEntry = r.xdr("ledger entry")?;
                let live = r.u32()?;
                present.push((entry, live.checked_sub(1)));
            }
            let n = r.u32()?;
            let mut absent = Vec::with_capacity(n as usize);
            for _ in 0..n {
                absent.push(r.xdr::<LedgerKey>("ledger key")?);
            }
            STORE.with(|s| {
                let mut s = s.borrow_mut();
                for (entry, live) in present {
                    let key = entry.to_key();
                    s.absent.remove(&key);
                    s.present.insert(key, (entry, live));
                }
                for key in absent {
                    s.present.remove(&key);
                    s.absent.insert(key);
                }
            });
            out.u8(ST_COMPLETE);
            Ok(())
        }
        OP_RESET => {
            STORE.with(|s| *s.borrow_mut() = Store::default());
            out.u8(ST_COMPLETE);
            Ok(())
        }
        OP_RUN => run(r, out),
        op => Err(format!("unknown op {op}")),
    }
}

/// Parsed signer hint: an account whose address credentials the preview
/// fills, the rule ids each of its entries' `AuthPayload` selects (one list
/// per entry, in envelope order; the last list repeats), and its signer keys.
struct Hint {
    account: [u8; 32],
    rule_ids: Vec<Vec<u32>>,
    keys: Vec<([u8; 32], Vec<u8>)>,
    used: Cell<usize>,
}

fn run(r: &mut In<'_>, out: &mut Out) -> Result<(), String> {
    let protocol = r.u32()?;
    let sequence = r.u32()?;
    let timestamp = r.u64()?;
    let network_id = r.id()?;
    let base_reserve = r.u32()?;
    let envelope: TransactionEnvelope = r.xdr("transaction envelope")?;
    let mode = r.u8()?;
    if protocol != host_protocol() {
        return Err(format!(
            "the ledger is on protocol {protocol}; this engine implements protocol {}",
            host_protocol()
        ));
    }
    let (host_function, source) = extract_invoke_host_function(&envelope)?;

    let mut overrides: Vec<(LedgerEntry, Option<u32>)> = vec![];
    let auth_mode = if mode == MODE_ENFORCE {
        let n = r.u32()?;
        let mut stubs = vec![];
        for _ in 0..n {
            stubs.push(r.id()?);
        }
        let n = r.u32()?;
        let mut hints = vec![];
        for _ in 0..n {
            let account = r.id()?;
            let mut ids = vec![];
            for _ in 0..r.u32()? {
                ids.push(
                    (0..r.u32()?)
                        .map(|_| r.u32())
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            let mut keys = vec![];
            for _ in 0..r.u32()? {
                keys.push((r.id()?, r.blob()?.to_vec()));
            }
            hints.push(Hint {
                account,
                rule_ids: ids,
                keys,
                used: Cell::default(),
            });
        }
        let live = Some(sequence.saturating_add(1_000_000));
        if !stubs.is_empty() {
            overrides.push((code_entry(STUB_VERIFIER), live));
            let hash = Hash(Sha256::digest(STUB_VERIFIER).into());
            for id in &stubs {
                overrides.push((instance_entry(*id, hash.clone()), live));
            }
        }
        let mut entries = supplied_auth(&envelope);
        for e in &mut entries {
            fill_auth_payload(e, &hints, sequence)?;
        }
        RecordingInvocationAuthMode::Enforcing(entries)
    } else {
        // Non-root auth disabled, plain Address credentials: what RPC records.
        RecordingInvocationAuthMode::recording(true, false)
    };

    let snapshot = STORE.with(|s| {
        let s = s.borrow();
        let mut present: BTreeMap<LedgerKey, EntryWithLiveUntil> = s
            .present
            .iter()
            .map(|(k, (e, live))| (k.clone(), (Rc::new(e.clone()), *live)))
            .collect();
        for (e, live) in overrides {
            present.insert(e.to_key(), (Rc::new(e), live));
        }
        Rc::new(Snapshot {
            present,
            absent: s.absent.clone(),
            needed: RefCell::default(),
        })
    });
    let needs = |out: &mut Out, keys: Vec<LedgerKey>| {
        out.u8(ST_NEEDS_STATE);
        out.list(&keys, |o, k| o.xdr(k));
    };

    let config = match NetworkConfig::load_from_snapshot(snapshot.as_ref()) {
        Ok(c) => c,
        Err(e) => {
            let keys = snapshot.take_needed();
            if !keys.is_empty() {
                needs(out, keys);
                return Ok(());
            }
            return Err(format!("network config: {e:#}"));
        }
    };
    let mut info = LedgerInfo {
        protocol_version: protocol,
        sequence_number: sequence,
        timestamp,
        network_id,
        base_reserve,
        min_temp_entry_ttl: 0,
        min_persistent_entry_ttl: 0,
        max_entry_ttl: 0,
    };
    config.fill_config_fields_in_ledger_info(&mut info);
    let seed: [u8; 32] = Sha256::digest(envelope.to_xdr(Limits::none()).unwrap_or_default()).into();
    let result = simulate_invoke_host_function_op(
        snapshot.clone(),
        &config,
        &SimulationAdjustmentConfig::default_adjustment(),
        &info,
        host_function,
        auth_mode,
        &source,
        seed,
        true,
    );
    let keys = snapshot.take_needed();
    if !keys.is_empty() {
        needs(out, keys);
        return Ok(());
    }
    let result = result.map_err(|e| format!("simulation: {e:#}"))?;

    out.u8(ST_COMPLETE);
    match &result.invoke_result {
        Ok(v) => {
            out.u8(1);
            out.xdr(v);
        }
        Err(e) => {
            out.u8(0);
            out.blob(format!("{:?}", e.error).as_bytes());
        }
    }
    out.list(
        &contract_errors(&result.diagnostic_events),
        |o, (contract, code)| {
            o.blob(contract.as_ref().map_or(&[][..], |c| &c.0 .0[..]));
            o.u32(*code);
        },
    );
    out.list(&result.auth, |o, a| o.xdr(a));
    out.list(&result.contract_events, |o, ev| o.xdr(ev));
    out.list(&result.modified_entries, |o, d| {
        match &d.state_before {
            Some(e) => o.xdr(e),
            None => o.blob(&[]),
        }
        match &d.state_after {
            Some(e) => o.xdr(e),
            None => o.blob(&[]),
        }
    });
    out.u32(result.simulated_instructions);
    out.u32(result.simulated_memory);
    match &result.transaction_data {
        Some(d) => out.xdr(d),
        None => out.blob(&[]),
    }
    let tail = if result.invoke_result.is_err() {
        diagnostics_tail(&result.diagnostic_events)
    } else {
        String::new()
    };
    out.blob(tail.as_bytes());
    Ok(())
}

/// The first `InvokeHostFunction` operation's host function and its source
/// account (the operation's own source, else the transaction's).
fn extract_invoke_host_function(
    envelope: &TransactionEnvelope,
) -> Result<(HostFunction, AccountId), String> {
    let tx = match envelope {
        TransactionEnvelope::Tx(v1) => &v1.tx,
        TransactionEnvelope::TxV0(_) => {
            return Err("v0 envelopes cannot carry a Soroban invocation".into())
        }
        TransactionEnvelope::TxFeeBump(_) => {
            return Err("preview the inner transaction of a fee bump".into())
        }
    };
    let (op_source, host_function) = tx
        .operations
        .iter()
        .find_map(|op| match &op.body {
            OperationBody::InvokeHostFunction(i) => {
                Some((op.source_account.as_ref(), i.host_function.clone()))
            }
            _ => None,
        })
        .ok_or("the transaction has no InvokeHostFunction operation")?;
    match op_source.unwrap_or(&tx.source_account) {
        MuxedAccount::Ed25519(key) => Ok((
            host_function,
            AccountId(PublicKey::PublicKeyTypeEd25519(key.clone())),
        )),
        MuxedAccount::MuxedEd25519(_) => {
            Err("muxed (M...) source accounts are not supported".into())
        }
    }
}

fn supplied_auth(envelope: &TransactionEnvelope) -> Vec<SorobanAuthorizationEntry> {
    let TransactionEnvelope::Tx(v1) = envelope else {
        return vec![];
    };
    v1.tx
        .operations
        .iter()
        .find_map(|op| match &op.body {
            OperationBody::InvokeHostFunction(i) => Some(i.auth.to_vec()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Give a hinted account's address credentials the `AuthPayload` its
/// `__check_auth` reads: `{ context_rule_ids, signers: { External(verifier,
/// key) => sig } }`, with all-zero signatures the stub verifier accepts.
fn fill_auth_payload(
    entry: &mut SorobanAuthorizationEntry,
    hints: &[Hint],
    sequence: u32,
) -> Result<(), String> {
    let creds = match &mut entry.credentials {
        SorobanCredentials::Address(c) | SorobanCredentials::AddressV2(c) => c,
        _ => return Ok(()),
    };
    let ScAddress::Contract(ContractId(Hash(id))) = &creds.address else {
        return Ok(());
    };
    let Some(hint) = hints.iter().find(|h| &h.account == id) else {
        return Ok(());
    };
    let err = |e: Error| e.to_string();
    let sym = |s: &str| -> Result<ScVal, String> {
        Ok(ScVal::Symbol(ScSymbol(s.try_into().map_err(err)?)))
    };
    let mut signers = vec![];
    for (verifier, key) in &hint.keys {
        let name = ScVal::Vec(Some(ScVec(
            vec![
                sym("External")?,
                ScVal::Address(ScAddress::Contract(ContractId(Hash(*verifier)))),
                ScVal::Bytes(ScBytes(key.clone().try_into().map_err(err)?)),
            ]
            .try_into()
            .map_err(err)?,
        )));
        signers.push(ScMapEntry {
            key: name,
            val: ScVal::Bytes(ScBytes(vec![0u8; 64].try_into().map_err(err)?)),
        });
    }
    let n = hint.used.get();
    hint.used.set(n + 1);
    let list = hint
        .rule_ids
        .get(n)
        .or(hint.rule_ids.last())
        .cloned()
        .unwrap_or_default();
    let ids = ScVal::Vec(Some(ScVec(
        list.iter()
            .map(|i| ScVal::U32(*i))
            .collect::<Vec<_>>()
            .try_into()
            .map_err(err)?,
    )));
    creds.signature = ScVal::Map(Some(ScMap(
        vec![
            ScMapEntry {
                key: sym("context_rule_ids")?,
                val: ids,
            },
            ScMapEntry {
                key: sym("signers")?,
                val: ScVal::Map(Some(ScMap(signers.try_into().map_err(err)?))),
            },
        ]
        .try_into()
        .map_err(err)?,
    )));
    if creds.signature_expiration_ledger < sequence {
        creds.signature_expiration_ledger = sequence + 100;
    }
    Ok(())
}

/// Contract error codes in a list of diagnostic events, each with the
/// contract whose frame raised it (none for the host's own frames).
fn contract_errors(events: &[DiagnosticEvent]) -> Vec<(Option<ContractId>, u32)> {
    let mut codes = vec![];
    for e in events {
        let mut visit = |v: &ScVal| {
            if let ScVal::Error(ScError::Contract(c)) = v {
                codes.push((e.event.contract_id.clone(), *c));
            }
        };
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

/// The last two diagnostics, for a failed run.
fn diagnostics_tail(events: &[DiagnosticEvent]) -> String {
    let last: Vec<String> = events
        .iter()
        .rev()
        .take(2)
        .map(|e| {
            let s = format!("{:?}", e.event.body);
            match s.char_indices().nth(240) {
                Some((i, _)) => format!("{}…", &s[..i]),
                None => s,
            }
        })
        .collect();
    if last.is_empty() {
        String::new()
    } else {
        format!(" [diagnostics: {}]", last.join(" | "))
    }
}

fn code_entry(wasm: &[u8]) -> LedgerEntry {
    LedgerEntry {
        last_modified_ledger_seq: 0,
        data: LedgerEntryData::ContractCode(ContractCodeEntry {
            ext: ContractCodeEntryExt::V0,
            hash: Hash(Sha256::digest(wasm).into()),
            code: wasm.to_vec().try_into().unwrap_or_default(),
        }),
        ext: LedgerEntryExt::V0,
    }
}

fn instance_entry(id: [u8; 32], wasm: Hash) -> LedgerEntry {
    LedgerEntry {
        last_modified_ledger_seq: 0,
        data: LedgerEntryData::ContractData(ContractDataEntry {
            ext: ExtensionPoint::V0,
            contract: ScAddress::Contract(ContractId(Hash(id))),
            key: ScVal::LedgerKeyContractInstance,
            durability: ContractDataDurability::Persistent,
            val: ScVal::ContractInstance(ScContractInstance {
                executable: ContractExecutable::Wasm(wasm),
                storage: None,
            }),
        }),
        ext: LedgerEntryExt::V0,
    }
}

// --- wasm exports ----------------------------------------------------------

#[no_mangle]
pub extern "C" fn np_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from [`np_alloc`]; the buffer is consumed.
#[no_mangle]
pub unsafe extern "C" fn np_call(ptr: *mut u8, len: usize) -> u64 {
    let input = Vec::from_raw_parts(ptr, len, len);
    let reply = call(&input);
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        *o = reply;
        ((o.len() as u64) << 32) | (o.as_ptr() as u64 & 0xffff_ffff)
    })
}

#[no_mangle]
pub extern "C" fn np_host_protocol() -> u32 {
    host_protocol()
}
