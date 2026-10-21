//! `soroban-sim replay`: the fidelity check of the session's transaction
//! layer. `fetch` takes a window of recent real ledgers from RPC, samples
//! their Soroban transactions across contracts and outcomes, and rebuilds the
//! exact state each one saw when it applied: before-images from the ledgers'
//! meta, and RPC's head values rolled back through the same meta for anything
//! the meta never touched. It writes a fixture: envelopes, results, meta and
//! pre-states, all real. `run` replays a fixture offline through
//! `Session::submit_with` and reports every difference.
//!
//! Only reads: `getLedgers`, `getLedgerEntries`, `getHealth`.

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use soroban_env_host::xdr::{
    ConfigSettingId, FeeBumpTransactionInnerTx, LedgerEntry, LedgerEntryChanges, LedgerKey, LedgerKeyConfigSetting, Limits,
    OperationBody, ReadXdr, TransactionEnvelope, TransactionMeta, TransactionResult, WriteXdr,
};
use soroban_sim_core::session::replay::{replay, ReplayOutcome, ReplayTx};
use soroban_sim_core::session::{account_key, envelope_fee_source, envelope_source, host_protocol, muxed_account_id, StoredEntry};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::Path;

use crate::meta::{is_soroban, parallel_soroban_phase, prng_seed, ttl_key, tx_set_members, v2, ChangeIndex, ParallelLayout, Phase, Pos};
use crate::rpc::RpcClient;

pub const FIXTURE_FORMAT: &str = "soroban-sim-replay/1";

/// A recorded sample of real transactions, replayable offline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayFixture {
    pub format: String,
    pub network_passphrase: String,
    /// The RPC it was read from.
    pub source: String,
    /// The ledger windows sampled, one per `fetch`.
    pub segments: Vec<Segment>,
    /// Every distinct ledger entry the pre-states use (`LedgerEntry` XDR).
    pub entries: Vec<String>,
    pub transactions: Vec<FixtureTx>,
}

/// One fetched window of ledgers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    /// The first and last ledger.
    pub ledgers: [u32; 2],
    /// Soroban transactions in those ledgers.
    pub soroban_transactions_seen: usize,
    /// How many of them the fixture keeps (a stratified sample).
    pub sampled: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixtureTx {
    pub hash: String,
    pub label: String,
    pub ledger: u32,
    pub close_time: u64,
    /// The transaction's index in its ledger's apply order.
    pub apply_index: u32,
    pub protocol_version: u32,
    pub base_fee: u32,
    pub base_reserve: u32,
    pub component_base_fee: Option<i64>,
    pub prng_seed: String,
    /// XDR, base64: `TransactionEnvelope`, `TransactionResult`,
    /// `TransactionMeta`, and the fee charge and refund `LedgerEntryChanges`.
    pub envelope: String,
    pub result: String,
    pub meta: String,
    pub fee_processing: String,
    pub post_fee_processing: String,
    /// `(index into entries, live-until ledger)` for every entry present.
    pub pre_state: Vec<(usize, Option<u32>)>,
}

impl ReplayFixture {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let text = if raw.starts_with(&[0x1f, 0x8b]) {
            let mut s = String::new();
            flate2::read::GzDecoder::new(raw.as_slice()).read_to_string(&mut s).with_context(|| format!("gunzipping {}", path.display()))?;
            s
        } else {
            String::from_utf8(raw)?
        };
        let f: Self = serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        if f.format != FIXTURE_FORMAT {
            bail!("{}: format {:?}, expected {FIXTURE_FORMAT:?}", path.display(), f.format);
        }
        Ok(f)
    }

    /// Written gzipped when the path ends in `.gz`.
    pub fn save(&self, path: &Path) -> Result<()> {
        let json = serde_json::to_vec(self)?;
        let bytes = if path.extension().is_some_and(|e| e == "gz") {
            let mut gz = flate2::write::GzEncoder::new(vec![], flate2::Compression::best());
            gz.write_all(&json)?;
            gz.finish()?
        } else {
            json
        };
        std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))
    }

    /// Add another fixture's segments and transactions (same network),
    /// sharing ledger entries and skipping transactions already here.
    pub fn merge(&mut self, other: ReplayFixture) -> Result<()> {
        if other.network_passphrase != self.network_passphrase {
            bail!("cannot merge a {:?} fixture into a {:?} one", other.network_passphrase, self.network_passphrase);
        }
        let mut pooled: HashMap<String, usize> = self.entries.iter().cloned().enumerate().map(|(i, e)| (e, i)).collect();
        let have: BTreeSet<String> = self.transactions.iter().map(|t| t.hash.clone()).collect();
        for mut t in other.transactions {
            if have.contains(&t.hash) {
                continue;
            }
            for (i, _) in t.pre_state.iter_mut() {
                let e = other.entries.get(*i).ok_or_else(|| anyhow!("{}: entry {i} out of range", t.hash))?;
                *i = *pooled.entry(e.clone()).or_insert_with(|| {
                    self.entries.push(e.clone());
                    self.entries.len() - 1
                });
            }
            self.transactions.push(t);
        }
        self.segments.extend(other.segments);
        Ok(())
    }

    /// The fixture's transactions as core replay inputs.
    pub fn replay_txs(&self) -> Result<Vec<ReplayTx>> {
        let entries: Vec<LedgerEntry> =
            self.entries.iter().map(|e| Ok(LedgerEntry::from_xdr(B64.decode(e)?, Limits::none())?)).collect::<Result<_>>()?;
        self.transactions
            .iter()
            .map(|t| {
                let x = |s: &str| B64.decode(s).map_err(anyhow::Error::from);
                let seed: [u8; 32] = hex_decode(&t.prng_seed)?.try_into().map_err(|_| anyhow!("{}: bad PRNG seed", t.hash))?;
                Ok(ReplayTx {
                    network_passphrase: self.network_passphrase.clone(),
                    ledger_seq: t.ledger,
                    close_time: t.close_time,
                    protocol_version: t.protocol_version,
                    base_fee: t.base_fee,
                    base_reserve: t.base_reserve,
                    component_base_fee: t.component_base_fee,
                    prng_seed: seed,
                    envelope: TransactionEnvelope::from_xdr(x(&t.envelope)?, Limits::none())?,
                    result: TransactionResult::from_xdr(x(&t.result)?, Limits::none())?,
                    meta: TransactionMeta::from_xdr(x(&t.meta)?, Limits::none())?,
                    fee_processing: LedgerEntryChanges::from_xdr(x(&t.fee_processing)?, Limits::none())?,
                    post_fee_processing: LedgerEntryChanges::from_xdr(x(&t.post_fee_processing)?, Limits::none())?,
                    pre_state: t
                        .pre_state
                        .iter()
                        .map(|&(i, live_until)| {
                            Ok(StoredEntry { entry: entries.get(i).ok_or_else(|| anyhow!("{}: entry {i} out of range", t.hash))?.clone(), live_until })
                        })
                        .collect::<Result<_>>()?,
                })
            })
            .collect()
    }
}

pub struct FetchOptions {
    /// How many ledgers to sample from, ending at the latest.
    pub ledgers: u32,
    /// Wait until at least this many ledgers have closed since the
    /// state-size window last changed (it changes every 64 on mainnet and
    /// testnet), so a fetch right after a change still gets a full sample.
    pub min_ledgers: u32,
    pub max_transactions: usize,
    /// At most this many transactions per (call, outcome, auth kind) group;
    /// rare kinds (smart-account auth, SAC calls, restores, uploads) get four
    /// times as many.
    pub per_group: usize,
    pub progress: bool,
}

/// A Soroban transaction seen in the window.
struct Candidate {
    ledger: u32,
    index: u32,
    /// Whether its ledger ran the Soroban phase in parallel stages.
    parallel: bool,
    hash: [u8; 32],
    group: String,
    rare: bool,
    keys: Vec<LedgerKey>,
    close_time: u64,
    base_fee: u32,
    base_reserve: u32,
    component_base_fee: Option<i64>,
    prng_seed: [u8; 32],
    envelope: TransactionEnvelope,
    result: TransactionResult,
    meta: TransactionMeta,
    fee_processing: LedgerEntryChanges,
    post_fee_processing: LedgerEntryChanges,
}

/// Record a sample of the latest ledgers' Soroban transactions with the
/// state each one applied against.
pub fn fetch(rpc: &RpcClient, passphrase: &str, opts: &FetchOptions) -> Result<ReplayFixture> {
    let network_id: [u8; 32] = Sha256::digest(passphrase.as_bytes()).into();
    let say = |m: String| {
        if opts.progress {
            eprintln!("{m}");
        }
    };
    // The rent rate comes from the state-size window, which changes every
    // sample period at ledger close and is in no transaction's meta. RPC only
    // serves its latest value, so the sample stays inside the current period.
    let window_key = config_key(ConfigSettingId::LiveSorobanStateSizeWindow);
    let (window, latest) = loop {
        let head = rpc.ledger_entries(std::slice::from_ref(&window_key))?;
        let window = head.entries.first().cloned().ok_or_else(|| anyhow!("the network has no state-size window config entry"))?;
        let since = head.served_at_ledger.saturating_sub(window.entry.last_modified_ledger_seq);
        if since >= opts.min_ledgers.min(63) {
            break (window, head.served_at_ledger);
        }
        say(format!("{since} ledgers since the state-size window changed; waiting for {}", opts.min_ledgers));
        std::thread::sleep(std::time::Duration::from_secs(10));
    };
    let window_changed = window.entry.last_modified_ledger_seq;
    let start = (window_changed + 1).max(latest.saturating_sub(opts.ledgers.max(1) - 1));
    if start > latest {
        bail!("no ledger closed since the state-size window last changed at {window_changed}; try again in a few seconds");
    }
    say(format!("sampling ledgers {start}..={latest} (the state-size window last changed at {window_changed})"));

    // Keys of interest: every key a Soroban transaction of the window may
    // read, registered before its ledger's changes are indexed. The index is
    // complete for a key from the ledger that registered it, which is no
    // later than any transaction that needs it.
    let mut interest: BTreeSet<LedgerKey> = config_keys().into_iter().collect();
    let mut index = ChangeIndex::default();
    let mut layouts: HashMap<u32, ParallelLayout> = HashMap::new();
    let mut candidates = vec![];
    let mut seen = 0usize;
    let mut next = start;
    while next <= latest {
        let batch = rpc.ledgers(next, 5.min(latest - next + 1))?;
        if batch.is_empty() {
            bail!("getLedgers returned nothing from ledger {next}");
        }
        for l in &batch {
            let m = v2(&l.meta)?;
            let header = &m.ledger_header.header;
            let (members, contents_hash) = tx_set_members(&m.tx_set, network_id)?;
            if contents_hash != header.scp_value.tx_set_hash.0 {
                bail!("ledger {}: the transaction set does not hash to the header's", l.sequence);
            }
            let parallel = parallel_soroban_phase(&m.tx_set);
            layouts.insert(l.sequence, ParallelLayout::of(m, network_id)?);
            for (i, t) in m.tx_processing.iter().enumerate() {
                let hash = t.result.transaction_hash.0;
                let member = members.get(&hash).ok_or_else(|| anyhow!("ledger {}: transaction {} is not in the set", l.sequence, hex(&hash)))?;
                if !is_soroban(&member.envelope) {
                    continue;
                }
                seen += 1;
                let keys = tx_keys(&member.envelope)?;
                for k in &keys {
                    interest.insert(k.clone());
                    if matches!(k, LedgerKey::ContractData(_) | LedgerKey::ContractCode(_)) {
                        interest.insert(crate::meta::ttl_key(k)?);
                    }
                }
                let (group, rare) = group_of(&member.envelope, &t.result.result);
                candidates.push(Candidate {
                    ledger: l.sequence,
                    index: i as u32,
                    parallel,
                    hash,
                    group,
                    rare,
                    keys,
                    close_time: header.scp_value.close_time.0,
                    base_fee: header.base_fee,
                    base_reserve: header.base_reserve,
                    component_base_fee: member.component_base_fee,
                    prng_seed: prng_seed(contents_hash, i as u32),
                    envelope: member.envelope.clone(),
                    result: t.result.result.clone(),
                    meta: t.tx_apply_processing.clone(),
                    fee_processing: t.fee_processing.clone(),
                    post_fee_processing: t.post_tx_apply_fee_processing.clone(),
                });
            }
            index.add(&filtered(m, &interest)?)?;
        }
        next = batch.last().map_or(next, |l| l.sequence + 1);
        say(format!("  indexed through ledger {} ({} Soroban transactions)", next - 1, seen));
    }

    let chosen = sample(candidates, opts);
    say(format!("sampled {} of {seen} Soroban transactions", chosen.len()));

    // Head values for every needed key the window never changed. RPC serves
    // them at its latest ledger, so the index is extended to that ledger: a
    // change after the window then supplies the before-image instead.
    let mut need_head: BTreeSet<LedgerKey> = BTreeSet::new();
    for c in &chosen {
        let pos = Pos::executing(c.ledger, c.index, c.parallel);
        for k in c.keys.iter().chain(config_keys().iter()) {
            let contract = matches!(k, LedgerKey::ContractData(_) | LedgerKey::ContractCode(_));
            // A contract entry needs its TTL too, which the window may not decide.
            if index.value_before(k, pos).is_none() || (contract && ttl_seen(&index, &layouts, k, c)?.is_none()) {
                need_head.insert(k.clone());
            }
        }
    }
    let mut head: HashMap<LedgerKey, StoredEntry> = HashMap::new();
    let mut served = latest;
    let need: Vec<LedgerKey> = need_head.into_iter().collect();
    for chunk in need.chunks(200) {
        let batch = rpc.ledger_entries(chunk)?;
        served = served.max(batch.served_at_ledger);
        for e in batch.entries {
            head.insert(soroban_sim_core::ledger_entry_to_ledger_key(&e.entry)?, e);
        }
    }
    // The window entry as it was for the sampled ledgers.
    head.insert(window_key.clone(), window);
    let mut next = latest + 1;
    while next <= served {
        let batch = rpc.ledgers(next, 5.min(served - next + 1))?;
        if batch.is_empty() {
            break;
        }
        for l in &batch {
            index.add(&filtered(v2(&l.meta)?, &interest)?)?;
        }
        next = batch.last().map_or(next, |l| l.sequence + 1);
    }
    if next <= served {
        bail!("could not index ledgers {next}..={served} that RPC served entries at");
    }
    say(format!("read {} keys at ledger {served}; indexed through {}", head.len(), next - 1));

    let mut pool: Vec<String> = vec![];
    let mut pooled: HashMap<String, usize> = HashMap::new();
    let mut transactions = vec![];
    for c in &chosen {
        let pos = Pos::executing(c.ledger, c.index, c.parallel);
        let source = envelope_source(&c.envelope).map(|s| account_key(&s));
        let mut pre_state = vec![];
        let mut keys: BTreeSet<&LedgerKey> = c.keys.iter().collect();
        let configs = config_keys();
        keys.extend(configs.iter());
        for k in keys {
            let entry = match index.value_before(k, pos) {
                Some(v) => v,
                None if *k == window_key => head.get(k).map(|e| e.entry.clone()),
                None => {
                    let h = head.get(k);
                    if let Some(h) = h {
                        if h.entry.last_modified_ledger_seq > c.ledger {
                            bail!("{}: {} changed at ledger {} but the index has no change", hex(&c.hash), k.name(), h.entry.last_modified_ledger_seq);
                        }
                    }
                    h.map(|e| e.entry.clone())
                }
            };
            let Some(mut entry) = entry else { continue };
            // In a parallel phase every sequence bump precedes every
            // execution, this transaction's own included; the session bumps
            // the source itself, so it starts from the source as the bump
            // found it.
            if c.parallel && Some(k) == source.as_ref() {
                unbump_sequence(&mut entry, &c.meta, k)?;
            }
            let live_until = if matches!(k, LedgerKey::ContractData(_) | LedgerKey::ContractCode(_)) {
                match ttl_seen(&index, &layouts, k, c)? {
                    Some(t) => t,
                    None => head.get(k).and_then(|e| e.live_until),
                }
            } else {
                None
            };
            let xdr = B64.encode(entry.to_xdr(Limits::none())?);
            let i = *pooled.entry(xdr.clone()).or_insert_with(|| {
                pool.push(xdr);
                pool.len() - 1
            });
            pre_state.push((i, live_until));
        }
        let x = |v: &dyn Fn() -> Result<Vec<u8>, soroban_env_host::xdr::Error>| -> Result<String> { Ok(B64.encode(v()?)) };
        transactions.push(FixtureTx {
            hash: hex(&c.hash),
            label: c.group.clone(),
            ledger: c.ledger,
            close_time: c.close_time,
            apply_index: c.index,
            protocol_version: host_protocol(),
            base_fee: c.base_fee,
            base_reserve: c.base_reserve,
            component_base_fee: c.component_base_fee,
            prng_seed: hex(&c.prng_seed),
            envelope: x(&|| c.envelope.to_xdr(Limits::none()))?,
            result: x(&|| c.result.to_xdr(Limits::none()))?,
            meta: x(&|| c.meta.to_xdr(Limits::none()))?,
            fee_processing: x(&|| c.fee_processing.to_xdr(Limits::none()))?,
            post_fee_processing: x(&|| c.post_fee_processing.to_xdr(Limits::none()))?,
            pre_state,
        });
    }
    Ok(ReplayFixture {
        format: FIXTURE_FORMAT.into(),
        network_passphrase: passphrase.into(),
        source: rpc.url.clone(),
        segments: vec![Segment { ledgers: [start, latest], soroban_transactions_seen: seen, sampled: transactions.len() }],
        entries: pool,
        transactions,
    })
}

/// The ledger's meta reduced to changes of the keys of interest.
fn filtered(m: &soroban_env_host::xdr::LedgerCloseMetaV2, interest: &BTreeSet<LedgerKey>) -> Result<soroban_env_host::xdr::LedgerCloseMetaV2> {
    use soroban_env_host::xdr::{LedgerEntryChange, TransactionMeta as M};
    let keep = |changes: &LedgerEntryChanges| -> Result<LedgerEntryChanges> {
        let kept: Vec<LedgerEntryChange> = changes
            .iter()
            .filter(|c| {
                let key = match c {
                    LedgerEntryChange::State(e) | LedgerEntryChange::Created(e) | LedgerEntryChange::Updated(e) | LedgerEntryChange::Restored(e) => {
                        soroban_sim_core::ledger_entry_to_ledger_key(e).ok()
                    }
                    LedgerEntryChange::Removed(k) => Some(k.clone()),
                };
                key.is_some_and(|k| interest.contains(&k))
            })
            .cloned()
            .collect();
        Ok(kept.try_into()?)
    };
    let mut out = m.clone();
    // Keep only the phases' shape: whether the Soroban phase is parallel.
    let soroban_env_host::xdr::GeneralizedTransactionSet::V1(set) = &m.tx_set;
    let phases: Vec<soroban_env_host::xdr::TransactionPhase> = set
        .phases
        .iter()
        .map(|p| match p {
            soroban_env_host::xdr::TransactionPhase::V0(_) => soroban_env_host::xdr::TransactionPhase::V0(Default::default()),
            soroban_env_host::xdr::TransactionPhase::V1(c) => soroban_env_host::xdr::TransactionPhase::V1(soroban_env_host::xdr::ParallelTxsComponent {
                base_fee: c.base_fee,
                execution_stages: Default::default(),
            }),
        })
        .collect();
    out.tx_set = soroban_env_host::xdr::GeneralizedTransactionSet::V1(soroban_env_host::xdr::TransactionSetV1 {
        previous_ledger_hash: set.previous_ledger_hash.clone(),
        phases: phases.try_into()?,
    });
    out.scp_info = Default::default();
    out.evicted_keys = Default::default();
    let mut txs = vec![];
    for t in m.tx_processing.iter() {
        let mut t = t.clone();
        t.fee_processing = keep(&t.fee_processing)?;
        t.post_tx_apply_fee_processing = keep(&t.post_tx_apply_fee_processing)?;
        t.tx_apply_processing = match &t.tx_apply_processing {
            M::V4(x) => {
                let mut x = x.clone();
                x.tx_changes_before = keep(&x.tx_changes_before)?;
                x.tx_changes_after = keep(&x.tx_changes_after)?;
                let mut ops = vec![];
                for o in x.operations.iter() {
                    let mut o = o.clone();
                    o.changes = keep(&o.changes)?;
                    o.events = Default::default();
                    ops.push(o);
                }
                x.operations = ops.try_into()?;
                x.events = Default::default();
                x.diagnostic_events = Default::default();
                M::V4(x)
            }
            M::V3(x) => {
                let mut x = x.clone();
                x.tx_changes_before = keep(&x.tx_changes_before)?;
                x.tx_changes_after = keep(&x.tx_changes_after)?;
                let mut ops = vec![];
                for o in x.operations.iter() {
                    let mut o = o.clone();
                    o.changes = keep(&o.changes)?;
                    ops.push(o);
                }
                x.operations = ops.try_into()?;
                M::V3(x)
            }
            other => other.clone(),
        };
        txs.push(t);
    }
    out.tx_processing = txs.try_into()?;
    let mut ups = vec![];
    for u in m.upgrades_processing.iter() {
        let mut u = u.clone();
        u.changes = keep(&u.changes)?;
        ups.push(u);
    }
    out.upgrades_processing = ups.try_into()?;
    Ok(out)
}

/// Every key a Soroban transaction may read: its footprint and the
/// accounts the transaction layer loads.
fn tx_keys(envelope: &TransactionEnvelope) -> Result<Vec<LedgerKey>> {
    let mut keys = BTreeSet::new();
    if let Some(s) = envelope_source(envelope) {
        keys.insert(account_key(&s));
    }
    if let Some(s) = envelope_fee_source(envelope) {
        keys.insert(account_key(&s));
    }
    let tx = inner_tx(envelope).ok_or_else(|| anyhow!("v0 envelope"))?;
    for op in tx.operations.iter() {
        if let Some(s) = &op.source_account {
            keys.insert(account_key(&muxed_account_id(s)));
        }
    }
    if let soroban_env_host::xdr::TransactionExt::V1(d) = &tx.ext {
        keys.extend(d.resources.footprint.read_only.iter().cloned());
        keys.extend(d.resources.footprint.read_write.iter().cloned());
    }
    Ok(keys.into_iter().collect())
}

fn inner_tx(envelope: &TransactionEnvelope) -> Option<&soroban_env_host::xdr::Transaction> {
    match envelope {
        TransactionEnvelope::Tx(e) => Some(&e.tx),
        TransactionEnvelope::TxFeeBump(e) => {
            let FeeBumpTransactionInnerTx::Tx(inner) = &e.tx.inner_tx;
            Some(&inner.tx)
        }
        TransactionEnvelope::TxV0(_) => None,
    }
}

/// The sampling group of a transaction, and whether it is a rare kind.
fn group_of(envelope: &TransactionEnvelope, result: &TransactionResult) -> (String, bool) {
    use soroban_env_host::xdr::{HostFunction, ScAddress, SorobanCredentials, TransactionResultResult as R};
    let ok = matches!(result.result, R::TxSuccess(_) | R::TxFeeBumpInnerSuccess(_));
    let Some(tx) = inner_tx(envelope) else { return ("v0".into(), false) };
    let Some(op) = tx.operations.first() else { return ("empty".into(), false) };
    let mut rare = false;
    let label = match &op.body {
        OperationBody::InvokeHostFunction(ihf) => {
            let contract_auth = ihf.auth.iter().any(|a| match &a.credentials {
                SorobanCredentials::Address(c) | SorobanCredentials::AddressV2(c) => matches!(c.address, ScAddress::Contract(_)),
                SorobanCredentials::AddressWithDelegates(d) => matches!(d.address_credentials.address, ScAddress::Contract(_)),
                SorobanCredentials::SourceAccount => false,
            });
            let auth = if contract_auth {
                rare = true;
                " [smart-account auth]"
            } else if ihf.auth.iter().any(|a| !matches!(a.credentials, SorobanCredentials::SourceAccount)) {
                " [address auth]"
            } else {
                ""
            };
            let call = match &ihf.host_function {
                HostFunction::InvokeContract(a) => format!("{}::{}", a.contract_address, a.function_name.to_utf8_string_lossy()),
                HostFunction::UploadContractWasm(_) => {
                    rare = true;
                    "upload".into()
                }
                HostFunction::CreateContract(_) | HostFunction::CreateContractV2(_) => {
                    rare = true;
                    "create".into()
                }
            };
            format!("{call}{auth}")
        }
        other => {
            rare = true;
            other.name().to_string()
        }
    };
    if let soroban_env_host::xdr::TransactionExt::V1(d) = &tx.ext {
        if matches!(&d.ext, soroban_env_host::xdr::SorobanTransactionDataExt::V1(x) if !x.archived_soroban_entries.is_empty()) {
            rare = true;
        }
    }
    (format!("{label}{}", if ok { "" } else { " (failed)" }), rare)
}

/// Round-robin over the groups so every kind of transaction is in the sample.
fn sample(candidates: Vec<Candidate>, opts: &FetchOptions) -> Vec<Candidate> {
    let mut groups: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
    for c in candidates {
        groups.entry(c.group.clone()).or_default().push(c);
    }
    let mut queues: Vec<(usize, std::collections::VecDeque<Candidate>)> = groups
        .into_values()
        .map(|g| {
            let cap = if g.first().is_some_and(|c| c.rare) { opts.per_group * 4 } else { opts.per_group };
            // Spread each group's picks over the window.
            let step = (g.len() / cap.max(1)).max(1);
            (cap, g.into_iter().step_by(step).collect())
        })
        .collect();
    let mut out = vec![];
    loop {
        let mut took = false;
        for (cap, q) in queues.iter_mut() {
            if out.len() >= opts.max_transactions {
                break;
            }
            if *cap == 0 {
                continue;
            }
            if let Some(c) = q.pop_front() {
                out.push(c);
                *cap -= 1;
                took = true;
            }
        }
        if !took || out.len() >= opts.max_transactions {
            break;
        }
    }
    out.sort_by_key(|c| (c.ledger, c.index));
    out
}

/// The TTL of contract entry `data_key` as candidate `c` saw it, if the
/// window decides it. In a parallel phase a read-only TTL bump by an earlier
/// transaction of the same stage is deferred (CAP-63): the candidate only
/// sees it once a transaction of their shared cluster, after the bump and up
/// to the candidate, writes the entry; and a stage's read-only bumps merge by
/// maximum.
fn ttl_seen(index: &ChangeIndex, layouts: &HashMap<u32, ParallelLayout>, data_key: &LedgerKey, c: &Candidate) -> Result<Option<Option<u32>>> {
    let changes = index.changes_of(&ttl_key(data_key)?);
    let ttl = |e: &Option<LedgerEntry>| match e.as_ref().map(|e| &e.data) {
        Some(soroban_env_host::xdr::LedgerEntryData::Ttl(t)) => Some(t.live_until_ledger_seq),
        _ => None,
    };
    let target = Pos::executing(c.ledger, c.index, c.parallel);
    let mut seen: Option<Option<u32>> = None;
    for ch in changes {
        if seen.is_none() {
            seen = Some(ttl(&ch.before));
        }
        if ch.pos >= target {
            break;
        }
        let read_only_bump = ch.pos.phase == Phase::SorobanApply && layouts.get(&ch.pos.ledger).is_some_and(|l| l.is_read_only_bump(ch.pos.index, data_key));
        if ch.pos.ledger == c.ledger && ch.pos.phase == Phase::SorobanApply {
            if let Some(l) = layouts.get(&c.ledger) {
                if !l.ttl_change_visible(ch.pos.index, c.index, data_key) {
                    continue;
                }
            }
        }
        let after = ttl(&ch.after);
        seen = Some(if read_only_bump { seen.flatten().max(after) } else { after });
    }
    Ok(seen)
}

/// The source account with the sequence number (and the ledger and time of
/// it) from before this transaction's own bump in its `tx_changes_before`.
fn unbump_sequence(entry: &mut LedgerEntry, meta: &TransactionMeta, key: &LedgerKey) -> Result<()> {
    use soroban_env_host::xdr::{AccountEntryExt, AccountEntryExtensionV1Ext, AccountEntryExtensionV2Ext, LedgerEntryChange, LedgerEntryData};
    let TransactionMeta::V4(m) = meta else { return Ok(()) };
    let own = m.tx_changes_before.iter().find_map(|c| match c {
        LedgerEntryChange::State(e) if soroban_sim_core::ledger_entry_to_ledger_key(e).ok().as_ref() == Some(key) => Some(e.clone()),
        _ => None,
    });
    let (Some(LedgerEntry { data: LedgerEntryData::Account(own), .. }), LedgerEntryData::Account(a)) = (own, &mut entry.data) else { return Ok(()) };
    a.seq_num = own.seq_num;
    let v3 = |a: &AccountEntryExt| match a {
        AccountEntryExt::V1(v1) => match &v1.ext {
            AccountEntryExtensionV1Ext::V2(v2) => match &v2.ext {
                AccountEntryExtensionV2Ext::V3(v3) => Some(v3.clone()),
                AccountEntryExtensionV2Ext::V0 => None,
            },
            AccountEntryExtensionV1Ext::V0 => None,
        },
        AccountEntryExt::V0 => None,
    };
    if let (Some(own_v3), AccountEntryExt::V1(v1)) = (v3(&own.ext), &mut a.ext) {
        if let AccountEntryExtensionV1Ext::V2(v2) = &mut v1.ext {
            v2.ext = AccountEntryExtensionV2Ext::V3(own_v3);
        }
    }
    Ok(())
}

fn config_key(id: ConfigSettingId) -> LedgerKey {
    LedgerKey::ConfigSetting(LedgerKeyConfigSetting { config_setting_id: id })
}

/// Every network config setting a transaction's apply can depend on.
fn config_keys() -> Vec<LedgerKey> {
    ConfigSettingId::VARIANTS.iter().filter(|id| **id != ConfigSettingId::EvictionIterator).map(|id| config_key(*id)).collect()
}

/// Replay every transaction of the fixtures.
pub fn run(fixtures: &[ReplayFixture], progress: bool) -> Result<Vec<ReplayOutcome>> {
    let mut out = vec![];
    for f in fixtures {
        for (t, tx) in f.transactions.iter().zip(f.replay_txs()?) {
            let mut o = replay(&tx).with_context(|| format!("replaying {}", t.hash))?;
            o.label = t.label.clone();
            if progress && !o.matched() {
                eprintln!("  ✗ {} {} — {}", &o.hash[..12], o.label, o.mismatches.iter().map(|m| m.kind.as_str()).collect::<Vec<_>>().join(", "));
            }
            out.push(o);
        }
    }
    Ok(out)
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn hex_decode(s: &str) -> Result<Vec<u8>> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| anyhow!("bad hex: {e}"))).collect()
}

pub const REPORT_FORMAT: &str = "soroban-sim-replay-report/1";

/// A difference between the session and the network whose cause is known
/// and out of scope to fix: it is reported as explained, not as a failure.
pub struct KnownDivergence {
    pub id: &'static str,
    pub cause: &'static str,
    pub applies: fn(&ReplayOutcome, &soroban_sim_core::session::replay::Mismatch) -> bool,
}

/// The documented divergences (see docs/replay.md).
pub const KNOWN_DIVERGENCES: &[KnownDivergence] = &[KnownDivergence {
    id: "later-sequence-bump",
    cause: "In a parallel Soroban phase stellar-core bumps every transaction's sequence number before any executes, so a transaction whose footprint holds its own source account writes back a sequence number a later same-source transaction of the ledger set. The session applies one transaction per ledger: everything else matches, the source's sequence number is this transaction's own.",
    applies: |_, m| m.kind == "later sequence bump",
}];

#[derive(Debug, Clone, Serialize)]
pub struct FidelityReport {
    pub format: &'static str,
    pub fixtures: Vec<FixtureInfo>,
    pub host: String,
    pub transactions: usize,
    /// Every recorded field equal.
    pub matched: usize,
    pub mismatched: usize,
    /// Mismatched only in documented, explained ways.
    pub explained: usize,
    pub unexplained: usize,
    pub passed: bool,
    /// Transactions per tag (`fee-bump`, `sac`, `smart-account-auth`, …).
    pub coverage: BTreeMap<String, usize>,
    /// Transactions with at least one mismatch of each kind.
    pub mismatch_kinds: BTreeMap<String, usize>,
    pub explained_kinds: BTreeMap<String, ExplainedCount>,
    pub by_call: Vec<CallRow>,
    /// The transactions with the most unexplained mismatches.
    pub worst: Vec<TxRow>,
    pub mismatches: Vec<TxRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FixtureInfo {
    pub path: String,
    pub source: String,
    pub network_passphrase: String,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExplainedCount {
    pub cause: &'static str,
    pub transactions: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallRow {
    pub call: String,
    pub transactions: usize,
    pub matched: usize,
    pub unexplained: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TxRow {
    pub hash: String,
    pub ledger: u32,
    pub call: String,
    pub tags: Vec<String>,
    pub expected: String,
    pub observed: String,
    pub mismatches: Vec<MismatchRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MismatchRow {
    pub kind: String,
    pub subject: Option<String>,
    pub expected: String,
    pub observed: String,
    /// The known divergence that explains it, if any.
    pub explained_by: Option<&'static str>,
}

impl FidelityReport {
    pub fn build(fixtures: Vec<FixtureInfo>, outcomes: &[ReplayOutcome]) -> Self {
        let mut coverage = BTreeMap::new();
        let mut mismatch_kinds = BTreeMap::new();
        let mut explained_kinds: BTreeMap<String, ExplainedCount> = BTreeMap::new();
        let mut calls: BTreeMap<String, CallRow> = BTreeMap::new();
        let mut rows = vec![];
        let (mut matched, mut explained, mut unexplained) = (0, 0, 0);
        for o in outcomes {
            for t in &o.tags {
                *coverage.entry(t.clone()).or_insert(0) += 1;
            }
            let call = calls.entry(o.label.clone()).or_insert_with(|| CallRow { call: o.label.clone(), transactions: 0, matched: 0, unexplained: 0 });
            call.transactions += 1;
            if o.matched() {
                matched += 1;
                call.matched += 1;
                continue;
            }
            let mut kinds = BTreeSet::new();
            let mut row = TxRow {
                hash: o.hash.clone(),
                ledger: o.ledger_seq,
                call: o.label.clone(),
                tags: o.tags.clone(),
                expected: o.expected.clone(),
                observed: o.observed.clone(),
                mismatches: vec![],
            };
            for m in &o.mismatches {
                let known = KNOWN_DIVERGENCES.iter().find(|k| (k.applies)(o, m));
                if let Some(k) = known {
                    explained_kinds.entry(k.id.to_string()).or_insert(ExplainedCount { cause: k.cause, transactions: 0 });
                }
                kinds.insert(m.kind.clone());
                row.mismatches.push(MismatchRow {
                    kind: m.kind.clone(),
                    subject: m.subject.clone(),
                    expected: m.expected.clone(),
                    observed: m.observed.clone(),
                    explained_by: known.map(|k| k.id),
                });
            }
            for k in kinds {
                *mismatch_kinds.entry(k).or_insert(0) += 1;
            }
            let ids: BTreeSet<&str> = row.mismatches.iter().filter_map(|m| m.explained_by).collect();
            for id in ids {
                if let Some(e) = explained_kinds.get_mut(id) {
                    e.transactions += 1;
                }
            }
            if row.mismatches.iter().all(|m| m.explained_by.is_some()) {
                explained += 1;
            } else {
                unexplained += 1;
                call.unexplained += 1;
            }
            rows.push(row);
        }
        let mut worst: Vec<TxRow> = rows.iter().filter(|r| r.mismatches.iter().any(|m| m.explained_by.is_none())).cloned().collect();
        worst.sort_by_key(|r| std::cmp::Reverse(r.mismatches.iter().filter(|m| m.explained_by.is_none()).count()));
        worst.truncate(10);
        let mut by_call: Vec<CallRow> = calls.into_values().collect();
        by_call.sort_by(|a, b| b.transactions.cmp(&a.transactions).then(a.call.cmp(&b.call)));
        Self {
            format: REPORT_FORMAT,
            fixtures,
            host: format!("soroban-env-host {} (protocol {})", crate::ENV_HOST_VERSION, host_protocol()),
            transactions: outcomes.len(),
            matched,
            mismatched: outcomes.len() - matched,
            explained,
            unexplained,
            passed: unexplained == 0,
            coverage,
            mismatch_kinds,
            explained_kinds,
            by_call,
            worst,
            mismatches: rows,
        }
    }

    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string_pretty(self)
    }

    pub fn to_markdown(&self) -> String {
        use std::fmt::Write as _;
        let mut s = String::new();
        let _ = writeln!(s, "# Replay fidelity report\n");
        let _ = writeln!(
            s,
            "**{}**: {} real transactions replayed through the session; {} matched the network exactly, {} differed ({} explained, {} unexplained).\n",
            if self.passed { "Passed" } else { "FAILED" },
            self.transactions,
            self.matched,
            self.mismatched,
            self.explained,
            self.unexplained
        );
        let _ = writeln!(s, "Host: {}. Compared per transaction: result (code, fee charged, success hash), return value, events, the host's diagnostic events, every after-image and TTL, the fee charged up front, the refund, the non-refundable, refundable and rent fees, and core's `core_metrics` (CPU, memory, read and write bytes, events).\n", self.host);
        let _ = writeln!(s, "## Sample\n\n| Fixture | Network | Ledgers | Soroban txs seen | Sampled |\n|---|---|---|---:|---:|");
        for f in &self.fixtures {
            for g in &f.segments {
                let _ = writeln!(s, "| `{}` | {} | {}–{} | {} | {} |", f.path, f.network_passphrase, g.ledgers[0], g.ledgers[1], g.soroban_transactions_seen, g.sampled);
            }
        }
        let _ = writeln!(s, "\n## Coverage\n\n| Tag | Transactions |\n|---|---:|");
        for (t, n) in &self.coverage {
            let _ = writeln!(s, "| {t} | {n} |");
        }
        if !self.mismatch_kinds.is_empty() {
            let _ = writeln!(s, "\n## Mismatch categories\n\n| Kind | Transactions |\n|---|---:|");
            for (k, n) in &self.mismatch_kinds {
                let _ = writeln!(s, "| {k} | {n} |");
            }
        }
        if !self.explained_kinds.is_empty() {
            let _ = writeln!(s, "\n## Explained divergences\n\n| Id | Transactions | Cause |\n|---|---:|---|");
            for (id, e) in &self.explained_kinds {
                let _ = writeln!(s, "| {id} | {} | {} |", e.transactions, e.cause);
            }
        }
        let _ = writeln!(s, "\n## By call\n\n| Call | Transactions | Matched | Unexplained |\n|---|---:|---:|---:|");
        for c in &self.by_call {
            let _ = writeln!(s, "| `{}` | {} | {} | {} |", c.call, c.transactions, c.matched, c.unexplained);
        }
        if !self.worst.is_empty() {
            let _ = writeln!(s, "\n## Worst offenders\n");
            for r in &self.worst {
                let _ = writeln!(s, "- `{}` (ledger {}) `{}` [{}]\n  - network: {}\n  - session: {}", r.hash, r.ledger, r.call, r.tags.join(", "), r.expected, r.observed);
                for m in r.mismatches.iter().filter(|m| m.explained_by.is_none()).take(6) {
                    let _ = writeln!(
                        s,
                        "  - **{}**{}: expected `{}`, observed `{}`",
                        m.kind,
                        m.subject.as_ref().map(|x| format!(" ({x})")).unwrap_or_default(),
                        soroban_sim_core::session::clip(&m.expected, 200),
                        soroban_sim_core::session::clip(&m.observed, 200)
                    );
                }
            }
        }
        s
    }
}
