//! The session report, as JSON (machine-readable, stable field names) and
//! Markdown (for a PR, an issue, or a release checklist).

use serde::Serialize;
use soroban_env_host::xdr::{ContractDataDurability, LedgerKey, ScVal};
use soroban_sim_core::session::{show_scval, xlm};
use std::collections::BTreeMap;
use std::fmt::Write as _;

pub const REPORT_FORMAT: &str = "soroban-sim-session-report/1";

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub format: &'static str,
    pub plan: PlanInfo,
    pub network: NetworkInfo,
    pub fork: ForkInfo,
    pub host: HostInfo,
    /// What the rehearsal does and does not model.
    pub fidelity: Vec<String>,
    pub end: LedgerPoint,
    pub passed: bool,
    pub failures: Vec<String>,
    pub steps: Vec<StepReport>,
    pub overrides: Vec<OverrideReport>,
    pub fees: FeeSummary,
    pub accounts: Vec<AccountChange>,
    pub diff: DiffSummary,
    pub drift: DriftReport,
    pub fetch: FetchStats,
    pub safety: Safety,
    pub differential: Vec<DifferentialReport>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanInfo {
    pub path: String,
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkInfo {
    pub name: String,
    pub passphrase: String,
    pub base: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForkInfo {
    pub ledger: u32,
    pub close_time: u64,
    pub protocol_version: u32,
    pub base_fee: u32,
    pub base_reserve: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostInfo {
    pub protocol_version: u32,
    pub soroban_env_host: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct LedgerPoint {
    /// The ledger the next transaction would apply in.
    pub ledger: u32,
    pub close_time: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StepReport {
    pub index: usize,
    pub name: String,
    pub kind: String,
    pub ledger: u32,
    pub close_time: u64,
    /// `applied`, `failed`, `rejected`, `refused` (in preparation), `held`,
    /// `skipped`, `ok` (views, clock, overrides), `error`, `not run`.
    pub outcome: String,
    pub detail: String,
    /// What the plan expected, if it said.
    pub expected: Option<String>,
    pub passed: bool,
    pub value: Option<String>,
    pub value_scval: Option<ScVal>,
    pub saved: Option<String>,
    pub tx: Option<TxReport>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TxReport {
    pub hash: String,
    pub source: String,
    pub fee_bid: i64,
    pub resource_fee: i64,
    pub non_refundable_fee: i64,
    pub refundable_fee: i64,
    pub inclusion_fee: i64,
    pub fee_charged: i64,
    pub refunded: i64,
    pub rent_fee: i64,
    pub events_fee: i64,
    pub cpu_insns: u64,
    pub declared_cpu_insns: u32,
    pub mem_bytes: u64,
    pub write_bytes: u32,
    pub declared_write_bytes: u32,
    pub entries_written: u32,
    pub restored: u32,
    pub events: usize,
    pub contract_errors: Vec<u32>,
    pub signers: Vec<String>,
    pub replayable: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OverrideReport {
    pub kind: String,
    pub entry: String,
    pub label: String,
    pub detail: String,
    pub at_ledger: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeeSummary {
    pub transactions: usize,
    pub applied: usize,
    pub failed: usize,
    pub rejected: usize,
    pub total_charged: i64,
    pub total_refunded: i64,
    pub by_payer: Vec<PayerFees>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayerFees {
    pub account: String,
    pub transactions: usize,
    pub charged: i64,
    pub refunded: i64,
    /// The highest fee bid this account had to cover: the balance it needs
    /// on hand (above its reserve) for its most expensive transaction.
    pub max_fee_bid: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountChange {
    pub account: String,
    pub balance_before: Option<i64>,
    pub balance_after: Option<i64>,
    pub seq_before: Option<i64>,
    pub seq_after: Option<i64>,
    pub overridden: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffSummary {
    pub total: usize,
    pub by_type: BTreeMap<String, usize>,
    pub entries: Vec<DiffReport>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffReport {
    pub key_type: String,
    pub key: String,
    pub change: String,
    pub overridden: bool,
    pub live_until_before: Option<u32>,
    pub live_until_after: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DriftReport {
    pub fork_ledger: u32,
    /// The ledgers the base served fetches at (RPC serves its latest only).
    pub served_at_min: Option<u32>,
    pub served_at_max: Option<u32>,
    /// Fetched entries modified after the fork ledger.
    pub modified_after_fork: Vec<DriftEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DriftEntry {
    pub key: String,
    pub last_modified: u32,
    pub served_at: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct FetchStats {
    pub rpc_calls: u32,
    pub throttled_retries: u32,
    pub base_fetch_calls: u32,
    pub keys_fetched: u32,
    pub keys_present: u32,
    pub local_answers: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Safety {
    /// Envelope signatures by signers the base ledger already has.
    pub replayable: Vec<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DifferentialReport {
    pub step: String,
    /// `match`, `differs`, `skipped` or `error`.
    pub status: String,
    pub detail: String,
    pub fields: Vec<FieldComparison>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldComparison {
    pub field: String,
    pub ours: String,
    pub rpc: String,
    pub equal: bool,
}

/// A short, human description of a ledger key.
pub fn describe_key(key: &LedgerKey) -> String {
    match key {
        LedgerKey::Account(a) => a.account_id.to_string(),
        LedgerKey::Trustline(t) => format!("{} / {:?}", t.account_id, t.asset),
        LedgerKey::ContractData(d) => {
            let durability = match d.durability {
                ContractDataDurability::Persistent => "persistent",
                ContractDataDurability::Temporary => "temporary",
            };
            let k = match &d.key {
                ScVal::LedgerKeyContractInstance => "instance".to_string(),
                other => truncate(&show_scval(other), 80),
            };
            format!("{} {durability} {k}", d.contract)
        }
        LedgerKey::ContractCode(c) => format!("code {}", hex(&c.hash.0)),
        LedgerKey::ConfigSetting(c) => format!("config {:?}", c.config_setting_id),
        other => other.name().to_string(),
    }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s.to_string()
    }
}

fn short(s: &str) -> String {
    if s.len() > 12 && (s.starts_with('G') || s.starts_with('C')) && s.chars().all(|c| c.is_ascii_alphanumeric()) {
        format!("{}…{}", &s[..6], &s[s.len() - 4..])
    } else {
        s.to_string()
    }
}

/// Escape a table cell.
fn cell(s: &str) -> String {
    truncate(&s.replace('|', "\\|").replace('\n', " "), 160)
}

impl Report {
    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string_pretty(self)
    }

    pub fn to_markdown(&self) -> String {
        let mut m = String::new();
        let title = self.plan.name.clone().unwrap_or_else(|| self.plan.path.clone());
        let _ = writeln!(m, "# Session report: {title}\n");
        if let Some(d) = &self.plan.description {
            let _ = writeln!(m, "{}\n", d.trim());
        }
        let verdict = if self.passed { "passed".to_string() } else { format!("FAILED ({})", self.failures.len()) };
        let f = &self.fees;
        let _ = writeln!(m, "| | |\n|---|---|");
        let _ = writeln!(m, "| Result | **{verdict}** |");
        let _ = writeln!(m, "| Network | {} (`{}`) |", self.network.name, self.network.passphrase);
        let _ = writeln!(m, "| Base | {} |", cell(&self.network.base));
        let _ = writeln!(
            m,
            "| Fork | ledger {}, protocol {}, close time {}, base fee {} stroops, base reserve {} XLM |",
            self.fork.ledger,
            self.fork.protocol_version,
            self.fork.close_time,
            self.fork.base_fee,
            xlm(self.fork.base_reserve as i64)
        );
        let _ = writeln!(m, "| Host | soroban-env-host {} (protocol {}) |", self.host.soroban_env_host, self.host.protocol_version);
        let _ = writeln!(
            m,
            "| Transactions | {} submitted: {} applied, {} failed (fee paid), {} rejected |",
            f.transactions, f.applied, f.failed, f.rejected
        );
        let _ = writeln!(m, "| Fees | {} XLM charged, {} XLM refunded |", xlm(f.total_charged), xlm(f.total_refunded));
        let _ = writeln!(m, "| Clock | ledger {} → {}, close time {} → {} |", self.fork.ledger + 1, self.end.ledger, self.fork.close_time, self.end.close_time);
        let _ = writeln!(m, "| Overrides | {} |", self.overrides.len());
        let _ = writeln!(m, "| Final diff | {} entries |", self.diff.total);
        let _ = writeln!(m);
        let _ = writeln!(m, "Fidelity:\n");
        for line in &self.fidelity {
            let _ = writeln!(m, "- {line}");
        }
        let _ = writeln!(m);

        if !self.failures.is_empty() {
            let _ = writeln!(m, "## Failures\n");
            for fl in &self.failures {
                let _ = writeln!(m, "- {}", cell(fl));
            }
            let _ = writeln!(m);
        }

        let _ = writeln!(m, "## Overrides ({})\n", self.overrides.len());
        let _ = writeln!(m, "Every place this rehearsal departs from the base network.\n");
        if self.overrides.is_empty() {
            let _ = writeln!(m, "None.\n");
        } else {
            let _ = writeln!(m, "| # | Kind | Entry | Label | Change |\n|---|---|---|---|---|");
            for (i, o) in self.overrides.iter().enumerate() {
                let _ = writeln!(m, "| {} | {} | `{}` | {} | {} |", i + 1, o.kind, cell(&o.entry), cell(&o.label), cell(&o.detail));
            }
            let _ = writeln!(m);
        }

        let _ = writeln!(m, "## Steps\n");
        let _ = writeln!(m, "| # | Step | Ledger | Outcome | Fee charged (refund), XLM | CPU used / declared | Writes | Check |\n|---|---|---|---|---|---|---|---|");
        for s in &self.steps {
            let (fee, cpu, writes) = match &s.tx {
                Some(t) if s.outcome != "rejected" => (
                    format!("{} ({})", xlm(t.fee_charged), xlm(t.refunded)),
                    format!("{} / {}", t.cpu_insns, t.declared_cpu_insns),
                    t.entries_written.to_string(),
                ),
                _ => ("".into(), "".into(), "".into()),
            };
            let outcome = if s.detail.is_empty() { s.outcome.clone() } else { format!("{}: {}", s.outcome, s.detail) };
            let check = match (&s.expected, s.passed) {
                (Some(e), true) => format!("✓ {e}"),
                (Some(e), false) => format!("✗ expected {e}"),
                (None, true) => "✓".into(),
                (None, false) => "✗".into(),
            };
            let _ = writeln!(m, "| {} | {} | {} | {} | {fee} | {cpu} | {writes} | {} |", s.index, cell(&s.name), s.ledger, cell(&outcome), cell(&check));
        }
        let _ = writeln!(m);

        let _ = writeln!(m, "## Fees by payer\n");
        let _ = writeln!(m, "| Account | Transactions | Charged, XLM | Refunded, XLM | Largest fee bid, XLM |\n|---|---|---|---|---|");
        for p in &f.by_payer {
            let _ = writeln!(m, "| `{}` | {} | {} | {} | {} |", p.account, p.transactions, xlm(p.charged), xlm(p.refunded), xlm(p.max_fee_bid));
        }
        let _ = writeln!(m);

        let _ = writeln!(m, "## Accounts\n");
        let _ = writeln!(m, "| Account | Balance before, XLM | Balance after, XLM | Sequence before → after | Overridden |\n|---|---|---|---|---|");
        for a in &self.accounts {
            let b = |v: Option<i64>| v.map(xlm).unwrap_or_else(|| "—".into());
            let q = |v: Option<i64>| v.map(|n| n.to_string()).unwrap_or_else(|| "—".into());
            let _ = writeln!(m, "| `{}` | {} | {} | {} → {} | {} |", a.account, b(a.balance_before), b(a.balance_after), q(a.seq_before), q(a.seq_after), if a.overridden { "yes" } else { "" });
        }
        let _ = writeln!(m);

        let by_type: Vec<String> = self.diff.by_type.iter().map(|(k, v)| format!("{v} {k}")).collect();
        let _ = writeln!(m, "## Final diff vs the fork point ({} entries: {})\n", self.diff.total, by_type.join(", "));
        let _ = writeln!(m, "| Type | Entry | Change | Live until (before → after) | Override |\n|---|---|---|---|---|");
        for d in &self.diff.entries {
            let ttl = match (d.live_until_before, d.live_until_after) {
                (None, None) => String::new(),
                (b, a) => format!("{} → {}", b.map_or("—".into(), |v| v.to_string()), a.map_or("—".into(), |v| v.to_string())),
            };
            let _ = writeln!(m, "| {} | `{}` | {} | {ttl} | {} |", d.key_type, cell(&d.key), d.change, if d.overridden { "yes" } else { "" });
        }
        let _ = writeln!(m);

        let dr = &self.drift;
        let _ = writeln!(m, "## Fork drift\n");
        let served = match (dr.served_at_min, dr.served_at_max) {
            (Some(a), Some(b)) => format!("ledgers {a} to {b}"),
            _ => "no fetches".into(),
        };
        let _ = writeln!(
            m,
            "Fork ledger {}. The base served fetches at {served}. {} fetched entr{} had been modified after the fork ledger.\n",
            dr.fork_ledger,
            dr.modified_after_fork.len(),
            if dr.modified_after_fork.len() == 1 { "y" } else { "ies" }
        );
        if !dr.modified_after_fork.is_empty() {
            let _ = writeln!(m, "| Entry | Last modified | Served at |\n|---|---|---|");
            for e in &dr.modified_after_fork {
                let _ = writeln!(m, "| `{}` | {} | {} |", cell(&e.key), e.last_modified, e.served_at);
            }
            let _ = writeln!(m);
        }
        let fs = &self.fetch;
        let _ = writeln!(
            m,
            "{} keys fetched ({} present) in {} base calls; {} RPC calls in all ({} throttled retries); {} reads answered locally as session-created.\n",
            fs.keys_fetched, fs.keys_present, fs.base_fetch_calls, fs.rpc_calls, fs.throttled_retries, fs.local_answers
        );

        if !self.differential.is_empty() {
            let _ = writeln!(m, "## Differential vs RPC simulateTransaction\n");
            let _ = writeln!(m, "| Step | Status | Detail |\n|---|---|---|");
            for d in &self.differential {
                let _ = writeln!(m, "| {} | {} | {} |", cell(&d.step), d.status, cell(&d.detail));
            }
            let _ = writeln!(m);
        }

        let _ = writeln!(m, "## Safety\n");
        let _ = writeln!(m, "{}\n", self.safety.note);
        if self.safety.replayable.is_empty() {
            let _ = writeln!(m, "No envelope was signed by a signer the base network already has.");
        } else {
            let _ = writeln!(m, "**These envelopes are valid on the real network:**\n");
            for r in &self.safety.replayable {
                let _ = writeln!(m, "- {}", cell(r));
            }
        }
        m
    }
}

/// Shorten addresses inside free text, for terminal progress lines.
pub fn shorten_addresses(s: &str) -> String {
    s.split(' ').map(short).collect::<Vec<_>>().join(" ")
}
