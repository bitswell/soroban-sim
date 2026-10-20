//! Applying a validated transaction the way stellar-core does: charge the fee
//! and consume the sequence number, run the host in enforcing mode over the
//! declared footprint and budget with a module cache, then charge rent and
//! events against the refundable fee, commit, and refund the rest.

use anyhow::{anyhow, Result};
use soroban_env_host::budget::Budget;
use soroban_env_host::e2e_invoke::{self, TtlLedgerEntryMeta};
use soroban_env_host::fees::{compute_rent_fee, compute_transaction_resource_fee, TransactionResources};
use soroban_env_host::xdr::{
    ContractEvent, DiagnosticEvent, Hash, LedgerEntry, LedgerEntryData, LedgerKey, Limits, ReadXdr,
    ScVal, SorobanTransactionDataExt, WriteXdr,
};
use soroban_env_host::{Host, LedgerInfo, ModuleCache, DEFAULT_XDR_RW_LIMITS};
use soroban_simulation::NetworkConfig;
use std::collections::BTreeSet;

use super::ledger::{is_temporary, ForkedLedger, StoredEntry};
use super::validator::{bump_sequence, TxLimits, ValidTx};

/// What applying one valid transaction did.
#[derive(Clone, Debug)]
pub struct Applied {
    pub result: std::result::Result<ScVal, String>,
    /// Fee kept after the refund.
    pub fee_charged: i64,
    pub refund: i64,
    /// Rent and events: the refundable fee actually consumed.
    pub rent_fee: i64,
    pub events_fee: i64,
    pub cpu_insns: u64,
    pub mem_bytes: u64,
    pub write_bytes: u32,
    pub entries_written: u32,
    pub restored: u32,
    pub events: Vec<ContractEvent>,
    pub diagnostics: Vec<DiagnosticEvent>,
}

/// The session's apply engine. It owns the module cache: like stellar-core,
/// every live contract is pre-parsed, so a transaction pays only cached
/// instantiation. Without it the host charges full Wasm parsing and declared
/// budgets that core accepts fail with `Error(Budget, ExceededLimit)`.
pub struct Applier {
    module_cache: ModuleCache,
    compile_host: Host,
    cached: BTreeSet<Hash>,
    tx_index: u32,
}

impl Applier {
    pub fn new(config: &NetworkConfig) -> Result<Self> {
        let compile_host = Host::with_storage_and_budget(
            Default::default(),
            Budget::try_from_configs(u64::MAX, u64::MAX, config.cpu_cost_params.clone(), config.memory_cost_params.clone())?,
        );
        let module_cache = ModuleCache::new(&compile_host)?;
        Ok(Self { module_cache, compile_host, cached: BTreeSet::new(), tx_index: 0 })
    }

    /// Wasm hashes in the module cache.
    pub fn cached_modules(&self) -> &BTreeSet<Hash> {
        &self.cached
    }

    pub fn module_cache(&self) -> ModuleCache {
        self.module_cache.clone()
    }

    /// Parse every live contract code entry in `keys` into the cache. Code
    /// uploaded in ledger N is only seen here by a later transaction, which in
    /// a one-transaction-per-ledger session matches core adding it when N closes.
    pub fn cache_code(&mut self, ledger: &ForkedLedger, keys: &[LedgerKey], info: &LedgerInfo) -> Result<()> {
        for k in keys {
            let LedgerKey::ContractCode(c) = k else { continue };
            if self.cached.contains(&c.hash) {
                continue;
            }
            let Some(StoredEntry { entry: LedgerEntry { data: LedgerEntryData::ContractCode(code), .. }, live_until }) = ledger.get(k)? else {
                continue;
            };
            if live_until.is_some_and(|l| l >= info.sequence_number) {
                self.module_cache.parse_and_cache_module_simple(&self.compile_host, info.protocol_version, code.code.as_slice())?;
                self.cached.insert(c.hash.clone());
            }
        }
        Ok(())
    }

    pub fn apply(
        &mut self,
        ledger: &ForkedLedger,
        info: &LedgerInfo,
        config: &NetworkConfig,
        limits: &TxLimits,
        tx: &ValidTx,
        enable_diagnostics: bool,
    ) -> Result<Applied> {
        let seq = info.sequence_number;
        // Fee and sequence number are consumed from here on, success or not.
        let mut account = ledger.account(&tx.source)?.ok_or_else(|| anyhow!("source account vanished"))?;
        let fee = tx.fees.charged_up_front();
        account.balance -= fee;
        bump_sequence(&mut account, tx.seq_num, seq, info.timestamp);
        ledger.put_account(account, seq)?;

        let r = &tx.data.resources;
        let mut applied = Applied {
            result: Err(String::new()),
            fee_charged: fee,
            refund: 0,
            rent_fee: 0,
            events_fee: 0,
            cpu_insns: 0,
            mem_bytes: 0,
            write_bytes: 0,
            entries_written: 0,
            restored: 0,
            events: vec![],
            diagnostics: vec![],
        };
        let keys: Vec<LedgerKey> = r.footprint.read_only.iter().chain(r.footprint.read_write.iter()).cloned().collect();
        ledger.prefetch(&keys)?;
        self.cache_code(ledger, &keys, info)?;

        let budget = Budget::try_from_configs(
            r.instructions as u64,
            config.tx_memory_limit as u64,
            config.cpu_cost_params.clone(),
            config.memory_cost_params.clone(),
        )?;
        let restore: Vec<u32> = match &tx.data.ext {
            SorobanTransactionDataExt::V1(x) => x.archived_soroban_entries.to_vec(),
            SorobanTransactionDataExt::V0 => vec![],
        };
        // stellar-core: an archived entry marked for restore reaches the host
        // with TTL `ledgerSeq + minPersistentTTL - 1`; one NOT marked fails the
        // operation; an expired temporary entry is simply absent.
        let restored_live_until = seq + info.min_persistent_entry_ttl - 1;
        let n_ro = r.footprint.read_only.len();
        let mut entries = Vec::with_capacity(keys.len());
        for (i, k) in keys.iter().enumerate() {
            let Some(e) = ledger.get(k)? else {
                entries.push((None, None));
                continue;
            };
            let bytes = e.entry.to_xdr(DEFAULT_XDR_RW_LIMITS)?;
            let ttl = match (&e.entry.data, e.live_until) {
                (LedgerEntryData::ContractData(_) | LedgerEntryData::ContractCode(_), live) => {
                    let mut live_until = live.ok_or_else(|| anyhow!("no TTL for {}", k.name()))?;
                    if live_until < seq {
                        if is_temporary(&e.entry) {
                            entries.push((None, None));
                            continue;
                        }
                        let marked = i >= n_ro && restore.contains(&((i - n_ro) as u32));
                        if !marked {
                            return self.fail(ledger, tx, applied, seq, "ENTRY_ARCHIVED: an archived entry in the footprint is not marked for restore".into());
                        }
                        live_until = restored_live_until;
                    }
                    Some(TtlLedgerEntryMeta {
                        live_until_ledger: live_until,
                        entry_size_for_rent: e2e_invoke::entry_size_for_rent(&budget, &e.entry, bytes.len() as u32)?,
                    })
                }
                _ => None,
            };
            entries.push((Some(bytes), ttl));
        }
        applied.restored = restore.len() as u32;

        let auth: Vec<Vec<u8>> = tx.op.auth.iter().map(|a| a.to_xdr(DEFAULT_XDR_RW_LIMITS)).collect::<Result<_, _>>()?;
        let seed = super::prng_seed(b"apply", seq, self.tx_index);
        self.tx_index += 1;
        let mut diagnostics = vec![];
        let res = e2e_invoke::invoke_host_function(
            &budget,
            enable_diagnostics,
            tx.op.host_function.to_xdr(DEFAULT_XDR_RW_LIMITS)?,
            r.to_xdr(DEFAULT_XDR_RW_LIMITS)?,
            &restore,
            tx.op_source.to_xdr(DEFAULT_XDR_RW_LIMITS)?,
            auth.into_iter(),
            info.clone(),
            entries.into_iter(),
            seed.to_vec(),
            &mut diagnostics,
            None,
            Some(self.module_cache.clone()),
        );
        applied.cpu_insns = budget.get_cpu_insns_consumed()?;
        applied.mem_bytes = budget.get_mem_bytes_consumed()?;
        applied.diagnostics = diagnostics;
        let res = match res {
            Ok(res) => res,
            Err(e) => return self.fail(ledger, tx, applied, seq, format!("host error {:?}", e.error)),
        };
        let value = match &res.encoded_invoke_result {
            Ok(v) => ScVal::from_xdr(v, Limits::none())?,
            Err(e) => return self.fail(ledger, tx, applied, seq, format!("{:?}", e.error)),
        };
        applied.write_bytes = res
            .ledger_changes
            .iter()
            .filter(|c| !c.read_only)
            .filter_map(|c| c.encoded_new_value.as_ref())
            .map(|v| v.len() as u32)
            .sum();
        if applied.write_bytes > r.write_bytes {
            let why = format!("RESOURCE_LIMIT_EXCEEDED: wrote {} bytes, declared {}", applied.write_bytes, r.write_bytes);
            return self.fail(ledger, tx, applied, seq, why);
        }
        let events_size: u32 = res.encoded_contract_events.iter().map(|e| e.len() as u32).sum::<u32>()
            + res.encoded_invoke_result.as_ref().map_or(0, |v| v.len() as u32);
        if events_size > limits.tx_max_contract_events_size_bytes {
            let why = format!("RESOURCE_LIMIT_EXCEEDED: events and return value {events_size} bytes > network maximum {}", limits.tx_max_contract_events_size_bytes);
            return self.fail(ledger, tx, applied, seq, why);
        }
        applied.rent_fee = compute_rent_fee(&e2e_invoke::extract_rent_changes(&res.ledger_changes), &config.rent_fee_configuration, seq);
        let (_, events_fee) = compute_transaction_resource_fee(
            &TransactionResources { contract_events_size_bytes: events_size, ..zero_resources() },
            &config.fee_configuration,
        );
        applied.events_fee = events_fee;
        let consumed = applied.rent_fee + events_fee;
        if consumed > tx.fees.refundable {
            let why = format!("INSUFFICIENT_REFUNDABLE_FEE: rent and events cost {consumed}, the refundable fee is {}", tx.fees.refundable);
            return self.fail(ledger, tx, applied, seq, why);
        }

        // Commit every footprint change: new values, deletions, TTL bumps.
        for change in &res.ledger_changes {
            let key = LedgerKey::from_xdr(&change.encoded_key, Limits::none())?;
            let new_ttl = change.ttl_change.as_ref().map(|t| t.new_live_until_ledger);
            if change.read_only {
                if let (Some(ttl), Some(e)) = (new_ttl, ledger.get(&key)?) {
                    if Some(ttl) != e.live_until {
                        ledger.put(key, Some(StoredEntry { live_until: Some(ttl), ..e }));
                    }
                }
                continue;
            }
            match &change.encoded_new_value {
                Some(v) => {
                    let mut entry = LedgerEntry::from_xdr(v, Limits::none())?;
                    entry.last_modified_ledger_seq = seq;
                    ledger.put(key, Some(StoredEntry { entry, live_until: new_ttl }));
                    applied.entries_written += 1;
                }
                None => {
                    if ledger.get(&key)?.is_some() {
                        ledger.put(key, None);
                        applied.entries_written += 1;
                    }
                }
            }
        }
        applied.events = res
            .encoded_contract_events
            .iter()
            .map(|e| ContractEvent::from_xdr(e, Limits::none()))
            .collect::<Result<_, _>>()?;
        // The source account may itself be in the footprint, so the refund
        // goes onto its latest value.
        let refund = tx.fees.refundable - consumed;
        let mut account = ledger.account(&tx.source)?.ok_or_else(|| anyhow!("source account vanished"))?;
        account.balance += refund;
        ledger.put_account(account, seq)?;
        applied.refund = refund;
        applied.fee_charged = fee - refund;
        applied.result = Ok(value);
        Ok(applied)
    }

    /// A failed operation consumes no refundable resources: the whole
    /// refundable fee comes back, and the rest stays charged.
    fn fail(&self, ledger: &ForkedLedger, tx: &ValidTx, mut applied: Applied, seq: u32, why: String) -> Result<Applied> {
        let mut account = ledger.account(&tx.source)?.ok_or_else(|| anyhow!("source account vanished"))?;
        account.balance += tx.fees.refundable;
        ledger.put_account(account, seq)?;
        applied.refund = tx.fees.refundable;
        applied.fee_charged = tx.fees.charged_up_front() - tx.fees.refundable;
        applied.rent_fee = 0;
        applied.events_fee = 0;
        applied.result = Err(why);
        Ok(applied)
    }
}

fn zero_resources() -> TransactionResources {
    TransactionResources {
        instructions: 0,
        disk_read_entries: 0,
        write_entries: 0,
        disk_read_bytes: 0,
        write_bytes: 0,
        contract_events_size_bytes: 0,
        transaction_size_bytes: 0,
    }
}
