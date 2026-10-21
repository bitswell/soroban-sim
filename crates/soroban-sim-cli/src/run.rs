//! Runs a plan over a session and builds the report.

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use soroban_env_host::xdr::{
    AccountId, Asset, ContractExecutable, ContractId, ContractIdPreimage, ContractIdPreimageFromAddress,
    CreateContractArgs, CreateContractArgsV2, Hash, HashIdPreimage, HashIdPreimageContractId, HostFunction,
    InvokeContractArgs, LedgerEntry, LedgerEntryData, LedgerKey, LedgerKeyContractCode, Limits, Memo,
    Preconditions, ReadXdr, ScAddress, ScString, ScSymbol, ScVal, TransactionEnvelope, Uint256, WriteXdr,
};
use soroban_sim_core::session::{
    account_key, host_protocol, rejection_code, show_scval, AuthSigner, AuthSignerSource, Ed25519Key, EntryState,
    ExternalKey, ForkPoint, LedgerSource, OzDigest, OzSigner, PrepareRequest, Secp256r1Key, Session,
    SessionOptions, StoredEntry, TxRecord, TxStatus, ADDR_OZ_V1_DOMAIN,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use crate::plan::{
    interpolate, CallSpec, ClassicSpec, Computed, Expect, Fails, KeySpec, NetworkSpec, OverrideSpec, OzSignerSpec,
    Plan, RuleSpec, SignerSpec, Step, ValueExpr,
};
use crate::report::*;
use crate::rpc::{RpcClient, RpcSource};
use crate::snapshot::SnapshotFile;
use crate::{differential, ENV_HOST_VERSION};

pub const MAINNET_RPC: &str = "https://mainnet.sorobanrpc.com";
pub const TESTNET_RPC: &str = "https://soroban-testnet.stellar.org";
pub const MAINNET_PASSPHRASE: &str = "Public Global Stellar Network ; September 2015";
pub const TESTNET_PASSPHRASE: &str = "Test SDF Network ; September 2015";

/// Where the fork comes from.
pub enum Base {
    Rpc { name: String, url: String, passphrase: Option<String> },
    Snapshot(PathBuf),
}

pub struct RunConfig {
    pub plan_path: PathBuf,
    /// `None`: the plan's `network`.
    pub base: Option<Base>,
    pub wasm_dirs: Vec<PathBuf>,
    pub differential: bool,
    pub keep_going: bool,
    pub vars: BTreeMap<String, String>,
    /// Print one line per step to stderr.
    pub progress: bool,
}

pub fn network_preset(name: &str) -> Option<(&'static str, &'static str)> {
    match name {
        "mainnet" | "pubnet" | "public" => Some((MAINNET_RPC, MAINNET_PASSPHRASE)),
        "testnet" => Some((TESTNET_RPC, TESTNET_PASSPHRASE)),
        _ => None,
    }
}

/// `mainnet`, `testnet`, or an RPC URL.
pub fn base_from_name(name: &str, passphrase: Option<String>) -> Result<Base> {
    if let Some((url, p)) = network_preset(name) {
        return Ok(Base::Rpc { name: name.into(), url: url.into(), passphrase: Some(passphrase.unwrap_or_else(|| p.into())) });
    }
    if name.starts_with("http://") || name.starts_with("https://") {
        return Ok(Base::Rpc { name: name.into(), url: name.into(), passphrase });
    }
    bail!("unknown network {name:?}: use mainnet, testnet or an RPC URL")
}

fn base_from_spec(spec: &NetworkSpec) -> Result<Base> {
    match spec {
        NetworkSpec::Named(n) => base_from_name(n, None),
        NetworkSpec::Custom { rpc, passphrase } => Ok(Base::Rpc { name: rpc.clone(), url: rpc.clone(), passphrase: Some(passphrase.clone()) }),
    }
}

#[derive(Clone)]
enum KeyMaterial {
    Ed25519(Ed25519Key),
    Secp256r1(Secp256r1Key),
    WebAuthn(Secp256r1Key, Vec<u8>),
}

/// The outcome of one step before it becomes a report row.
struct Outcome {
    outcome: &'static str,
    detail: String,
    /// The text an `expect.fails` substring is matched against.
    text: String,
    value: Option<ScVal>,
    tx: Option<TxRecord>,
    /// Whether the step did what it was asked (applied, viewed, …).
    succeeded: bool,
}

impl Outcome {
    fn ok(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self { outcome: "ok", text: detail.clone(), detail, value: None, tx: None, succeeded: true }
    }
}

pub struct Runner {
    plan: Plan,
    plan_path: PathBuf,
    plan_dir: PathBuf,
    network_name: String,
    passphrase: String,
    base_description: String,
    rpc: Option<Rc<RpcClient>>,
    fresh: Box<dyn Fn() -> Result<Session>>,
    session: Session,
    keys: BTreeMap<String, KeyMaterial>,
    values: BTreeMap<String, String>,
    evaluating: BTreeSet<String>,
    wasm_dirs: Vec<PathBuf>,
    bytes_source: Option<RpcClient>,
    differential: bool,
    keep_going: bool,
    progress: bool,
    steps: Vec<StepReport>,
    differentials: Vec<DifferentialReport>,
    failures: Vec<String>,
}

impl Runner {
    pub fn new(config: RunConfig) -> Result<Self> {
        let plan = Plan::load(&config.plan_path)?;
        let plan_dir = config.plan_path.parent().map(Path::to_path_buf).unwrap_or_default();
        let base = match config.base {
            Some(b) => b,
            None => base_from_spec(plan.network.as_ref().ok_or_else(|| anyhow!("the plan names no network; pass --fork or --snapshot"))?)?,
        };
        let mut options = SessionOptions::new("");
        if let Some(s) = plan.options.seconds_per_ledger {
            options.seconds_per_ledger = s;
        }
        if let Some(a) = plan.options.auth_expiration_ledgers {
            options.auth_expiration_ledgers = a;
        }
        let Forked { network_name, passphrase, rpc, description: base_description, fresh } = fork_base(base, &options)?;
        let session = fresh().context("forking the network")?;

        let mut keys = BTreeMap::new();
        for (name, spec) in &plan.keys {
            keys.insert(name.clone(), key_material(name, spec)?);
        }
        let mut wasm_dirs = config.wasm_dirs;
        if let Some(d) = &plan.options.wasm_dir {
            wasm_dirs.push(plan_dir.join(d));
        }
        let bytes_source = match &plan.options.bytes_source {
            Some(spec) => match base_from_spec(spec)? {
                Base::Rpc { url, .. } => Some(RpcClient::new(&url)),
                Base::Snapshot(_) => None,
            },
            None => None,
        };
        let differential = config.differential && rpc.is_some();
        let mut runner = Self {
            plan,
            plan_path: config.plan_path,
            plan_dir,
            network_name,
            passphrase,
            base_description,
            rpc,
            fresh,
            session,
            keys,
            values: config.vars,
            evaluating: BTreeSet::new(),
            wasm_dirs,
            bytes_source,
            differential,
            keep_going: config.keep_going,
            progress: config.progress,
            steps: vec![],
            differentials: vec![],
            failures: vec![],
        };
        if config.differential && !differential {
            runner.failures.push("--differential needs an RPC fork, not a snapshot".into());
        }
        Ok(runner)
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    /// Run setup and every step, then build the report.
    pub fn run(mut self, save_snapshot: Option<&Path>) -> Result<Report> {
        let setup = std::mem::take(&mut self.plan.setup);
        for (i, o) in setup.iter().enumerate() {
            self.apply_override(o, &format!("setup #{}", i + 1)).with_context(|| format!("setup override #{}", i + 1))?;
        }
        if self.progress {
            let info = self.session.ledger_info();
            eprintln!("forked {} at ledger {} (protocol {}); session starts at ledger {}, close time {}", self.network_name, self.session.fork_point().ledger_seq, info.protocol_version, info.sequence_number, info.timestamp);
            for o in self.session.ledger().overrides() {
                eprintln!("  override: {}: {}", o.label, o.detail);
            }
        }
        let steps = std::mem::take(&mut self.plan.steps);
        let mut stopped = false;
        for (i, step) in steps.iter().enumerate() {
            let label = step.label(i);
            if stopped {
                self.steps.push(not_run(i + 1, &label, step));
                continue;
            }
            let (ledger, time) = (self.session.ledger_info().sequence_number, self.session.ledger_info().timestamp);
            let result = self.step(step, &label);
            let (report, ok) = match result {
                Ok(outcome) => self.judge(i + 1, &label, step, ledger, time, outcome)?,
                Err(e) => {
                    let detail = format!("{e:#}");
                    let report = StepReport {
                        index: i + 1,
                        name: label.clone(),
                        kind: step.kind().into(),
                        ledger,
                        close_time: time,
                        outcome: "error".into(),
                        detail: detail.clone(),
                        expected: expected_text(step.expect.as_ref()),
                        passed: false,
                        value: None,
                        value_scval: None,
                        saved: None,
                        tx: None,
                    };
                    (report, false)
                }
            };
            if self.progress {
                eprintln!("{}", progress_line(&report));
            }
            if !ok {
                self.failures.push(format!("step {} ({label}): {} {}", i + 1, report.outcome, report.detail));
                stopped = !self.keep_going;
            }
            self.steps.push(report);
        }
        if let Some(path) = save_snapshot {
            let snap = SnapshotFile::new(&self.passphrase, self.session.fork_point(), &self.session.ledger().base_entries())?;
            snap.save(path)?;
        }
        Ok(self.report())
    }

    fn step(&mut self, step: &Step, label: &str) -> Result<Outcome> {
        if let Some(call) = &step.view {
            return self.view_step(call, step.fresh_fork);
        }
        if let Some(a) = &step.advance {
            let (from_seq, from_time) = (self.session.ledger_info().sequence_number, self.session.ledger_info().timestamp);
            if let Some(n) = a.ledgers {
                self.session.advance(n, a.seconds);
            } else if let Some(e) = &a.to_ledger {
                let to: u32 = self.eval(e)?.parse().context("to_ledger")?;
                self.session.warp_to_ledger(to)?;
            } else if let Some(e) = &a.to_time {
                let to: u64 = self.eval(e)?.parse().context("to_time")?;
                self.session.warp_to_time(to)?;
            } else if let Some(s) = a.seconds {
                self.session.warp_to_time(from_time + s)?;
            } else {
                bail!("advance needs ledgers, seconds, to_ledger or to_time");
            }
            let info = self.session.ledger_info();
            return Ok(Outcome::ok(format!(
                "ledger {from_seq} → {} (+{}), close time +{} s",
                info.sequence_number,
                info.sequence_number - from_seq,
                info.timestamp - from_time
            )));
        }
        if let Some(set) = &step.set {
            let mut done = vec![];
            for (name, expr) in set {
                let v = self.eval(expr)?;
                done.push(format!("{name} = {v}"));
                self.values.insert(name.clone(), v);
            }
            return Ok(Outcome::ok(done.join(", ")));
        }
        if let Some(checks) = &step.assert {
            let mut done = vec![];
            let mut wrong = vec![];
            for c in checks {
                let got = self.eval(&c.value)?;
                let want = self.interp(&c.equals)?;
                if got == want {
                    done.push(want);
                } else {
                    wrong.push(format!("{got} != {want}"));
                }
            }
            return Ok(if wrong.is_empty() {
                Outcome::ok(format!("{} equal", done.len()))
            } else {
                let detail = wrong.join("; ");
                Outcome { outcome: "failed", text: detail.clone(), detail, value: None, tx: None, succeeded: false }
            });
        }
        if let Some(o) = &step.override_ {
            let before = self.session.ledger().overrides().len();
            self.apply_override(o, label)?;
            let details: Vec<String> = self.session.ledger().overrides()[before..].iter().map(|o| o.detail.clone()).collect();
            return Ok(Outcome::ok(details.join("; ")));
        }
        if let Some(xdr) = &step.envelope {
            let xdr = self.interp(xdr)?;
            let env = TransactionEnvelope::from_xdr_base64(xdr.trim(), Limits::none()).context("decoding the envelope")?;
            return self.submit(label, &env, step);
        }
        self.transaction_step(step, label)
    }

    fn transaction_step(&mut self, step: &Step, label: &str) -> Result<Outcome> {
        let host_function = if let Some(call) = &step.invoke {
            self.host_call(call)?
        } else if let Some(u) = &step.upload {
            let (bytes, hash) = self.wasm(u)?;
            let key = LedgerKey::ContractCode(LedgerKeyContractCode { hash: Hash(hash) });
            if u.skip_if_present.unwrap_or(true) {
                if let Some(e) = self.session.ledger().get(&key)? {
                    let state = EntryState::of(Some(&e), self.session.ledger_info().sequence_number);
                    let detail = format!("code {} is already on the ledger ({}{})", hex(&hash), state.as_str(), if state == EntryState::Archived { "; the first transaction that uses it restores it" } else { "" });
                    return Ok(Outcome { outcome: "skipped", text: detail.clone(), detail, value: None, tx: None, succeeded: true });
                }
            }
            HostFunction::UploadContractWasm(bytes.try_into()?)
        } else if let Some(d) = &step.deploy {
            let deployer = self.address(&d.deployer)?;
            let salt = hex32(&self.eval(&d.salt)?).context("deploy salt")?;
            let wasm_hash = hex32(&self.interp(&d.wasm_hash)?).context("deploy wasm_hash")?;
            HostFunction::CreateContractV2(CreateContractArgsV2 {
                contract_id_preimage: ContractIdPreimage::Address(ContractIdPreimageFromAddress { address: deployer, salt: Uint256(salt) }),
                executable: ContractExecutable::Wasm(Hash(wasm_hash)),
                constructor_args: self.args(&d.args)?.try_into()?,
            })
        } else if let Some(asset) = &step.deploy_sac {
            if asset != "native" {
                bail!("deploy_sac supports `native` only");
            }
            HostFunction::CreateContract(CreateContractArgs { contract_id_preimage: ContractIdPreimage::Asset(Asset::Native), executable: ContractExecutable::StellarAsset })
        } else {
            bail!("unsupported step");
        };

        let source_text = step.source.clone().or_else(|| self.plan.options.source.clone()).ok_or_else(|| anyhow!("no `source` for this step and no options.source"))?;
        let source_text = self.interp(&source_text)?;
        let source: AccountId = source_text.parse().map_err(|_| anyhow!("source {source_text} is not a G address"))?;
        let envelope_signers = self.envelope_signers(step, &source)?;
        let signers = self.signer_specs(step)?;
        let prepared = self.session.prepare(&PrepareRequest {
            source,
            host_function,
            auth_signers: &signers,
            envelope_signers: &envelope_signers,
            auth_expiration_ledgers: step.auth_expiration_ledgers,
            memo: Memo::None,
            preconditions: Preconditions::None,
        });
        let prepared = match prepared {
            Ok(p) => p,
            Err(e) => {
                let detail = format!("{e:#}");
                return Ok(Outcome { outcome: "refused", text: detail.clone(), detail, value: None, tx: None, succeeded: false });
            }
        };
        if self.differential {
            let rpc = self.rpc.clone().expect("differential needs RPC");
            self.differentials.push(differential::compare(&rpc, &self.session, label, &prepared));
        }
        if let Some(name) = &step.save_envelope {
            self.values.insert(name.clone(), prepared.envelope.to_xdr_base64(Limits::none())?);
        }
        if step.hold {
            let detail = format!("prepared and signed, not submitted (saved as {})", step.save_envelope.as_deref().unwrap_or(""));
            return Ok(Outcome { outcome: "held", text: detail.clone(), detail, value: Some(prepared.value), tx: None, succeeded: true });
        }
        self.submit(label, &prepared.envelope, step)
    }

    fn submit(&mut self, label: &str, env: &TransactionEnvelope, step: &Step) -> Result<Outcome> {
        let record = self.session.submit(label, env)?;
        if let Some(name) = &step.save_envelope {
            self.values.entry(name.clone()).or_insert(env.to_xdr_base64(Limits::none())?);
        }
        let text = record.status.summary();
        Ok(match &record.status {
            TxStatus::Applied { value } => Outcome { outcome: "applied", detail: show_scval(value), text, value: Some(value.clone()), succeeded: true, tx: Some(record) },
            TxStatus::Failed { code, reason } => {
                Outcome { outcome: "failed", detail: format!("{}: {reason}", code.as_str()), text, value: None, succeeded: false, tx: Some(record) }
            }
            TxStatus::Rejected { code, detail, fee_bump_inner } => Outcome {
                outcome: "rejected",
                detail: format!("{}: {detail}", rejection_code(*code, *fee_bump_inner)),
                text,
                value: None,
                succeeded: false,
                tx: Some(record),
            },
        })
    }

    fn view_step(&mut self, call: &CallSpec, fresh: bool) -> Result<Outcome> {
        let host_function = self.host_call(call)?;
        let result = if fresh { (self.fresh)()?.view(&host_function)? } else { self.session.view(&host_function)? };
        Ok(match result {
            Ok(v) => Outcome { outcome: "ok", detail: show_scval(&v), text: show_scval(&v), value: Some(v), tx: None, succeeded: true },
            Err(e) => Outcome { outcome: "failed", detail: e.clone(), text: e, value: None, tx: None, succeeded: false },
        })
    }

    /// Compare the outcome with the plan's expectation.
    fn judge(&mut self, index: usize, label: &str, step: &Step, ledger: u32, time: u64, o: Outcome) -> Result<(StepReport, bool)> {
        let expect = step.expect.clone().unwrap_or_default();
        let mut passed = o.succeeded;
        let mut detail = o.detail.clone();
        if let Some(f) = &expect.fails {
            let want_fail = !matches!(f, Fails::Any(false));
            if want_fail {
                passed = !o.succeeded;
                if let (Fails::Containing(needle), false) = (f, o.succeeded) {
                    let needle = self.interp(needle)?;
                    if !o.text.contains(&needle) {
                        passed = false;
                        detail = format!("{detail} (expected it to mention {needle:?})");
                    }
                }
            }
        }
        if o.succeeded {
            if let Some(v) = &o.value {
                if let Some(want) = &expect.value {
                    let want = self.scval(want)?;
                    if *v != want {
                        passed = false;
                        detail = format!("{detail} (expected {})", show_scval(&want));
                    }
                }
                if let Some(want) = &expect.equals {
                    let want = self.interp(want)?;
                    let got = render(v);
                    if got != want {
                        passed = false;
                        detail = format!("{detail} (expected {want})");
                    }
                }
            }
        }
        let mut saved = None;
        if let (Some(name), Some(v)) = (&step.save, &o.value) {
            if o.succeeded {
                let text = render(v);
                self.values.insert(name.clone(), text.clone());
                saved = Some(format!("{name} = {text}"));
            }
        }
        let tx = o.tx.as_ref().map(tx_report);
        let report = StepReport {
            index,
            name: label.to_string(),
            kind: step.kind().into(),
            ledger,
            close_time: time,
            outcome: o.outcome.into(),
            detail,
            expected: expected_text(step.expect.as_ref()),
            passed,
            value: o.value.as_ref().map(show_scval),
            value_scval: o.value,
            saved,
            tx,
        };
        Ok((report, passed))
    }

    // --- values ---

    fn lookup(&mut self, name: &str) -> Result<String> {
        if let Some(v) = self.values.get(name) {
            return Ok(v.clone());
        }
        let info = self.session.ledger_info();
        match name {
            "ledger" => return Ok(info.sequence_number.to_string()),
            "time" => return Ok(info.timestamp.to_string()),
            "network.passphrase" => return Ok(self.passphrase.clone()),
            _ => {}
        }
        if let Some(rest) = name.strip_prefix("key.") {
            let (key, field) = rest.split_once('.').unwrap_or((rest, "g"));
            let k = self.keys.get(key).ok_or_else(|| anyhow!("unknown key {key}"))?;
            return match (k, field) {
                (KeyMaterial::Ed25519(k), "g") => Ok(k.strkey()),
                (KeyMaterial::Ed25519(k), "pk") => Ok(hex(&k.public_key())),
                (KeyMaterial::Secp256r1(k), "pk") => Ok(hex(&k.public_key())),
                (KeyMaterial::WebAuthn(k, id), "pk") => Ok(hex(&[k.public_key().as_slice(), id].concat())),
                (_, f) => bail!("key {key} has no field {f} (ed25519 keys have g and pk; others pk)"),
            };
        }
        let expr = self.plan.vars.get(name).cloned().ok_or_else(|| anyhow!("unknown variable {name}"))?;
        if !self.evaluating.insert(name.to_string()) {
            bail!("variable {name} refers to itself");
        }
        let v = self.eval(&expr);
        self.evaluating.remove(name);
        let v = v.with_context(|| format!("evaluating {name}"))?;
        self.values.insert(name.to_string(), v.clone());
        Ok(v)
    }

    fn interp(&mut self, text: &str) -> Result<String> {
        interpolate(text, &mut |name| self.lookup(name))
    }

    fn eval(&mut self, e: &ValueExpr) -> Result<String> {
        Ok(match e {
            ValueExpr::Text(t) => self.interp(t)?,
            ValueExpr::Number(n) => n.to_string(),
            ValueExpr::Computed(Computed::Sha256(inner)) => hex(&Sha256::digest(self.eval(inner)?.as_bytes())),
            ValueExpr::Computed(Computed::LedgerPlus(n)) => (self.session.ledger_info().sequence_number + n).to_string(),
            ValueExpr::Computed(Computed::ContractId { deployer, salt }) => {
                let deployer = self.eval(deployer)?;
                let deployer: ScAddress = deployer.parse().map_err(|_| anyhow!("deployer {deployer} is not an address"))?;
                let salt = hex32(&self.eval(salt)?).context("salt")?;
                contract_id(self.session.network_id(), deployer, salt)?.to_string()
            }
            ValueExpr::Computed(Computed::View(call)) => {
                let hf = self.host_call(call)?;
                match self.session.view(&hf)? {
                    Ok(v) => render(&v),
                    Err(e) => bail!("view {}.{}: {e}", call.contract, call.function),
                }
            }
        })
    }

    fn address(&mut self, text: &str) -> Result<ScAddress> {
        let t = self.interp(text)?;
        t.parse().map_err(|_| anyhow!("{t:?} is not a G or C address"))
    }

    fn host_call(&mut self, call: &CallSpec) -> Result<HostFunction> {
        Ok(HostFunction::InvokeContract(InvokeContractArgs {
            contract_address: self.address(&call.contract)?,
            function_name: ScSymbol(self.interp(&call.function)?.try_into().map_err(|_| anyhow!("bad function name {}", call.function))?),
            args: self.args(&call.args)?.try_into()?,
        }))
    }

    fn args(&mut self, args: &[Value]) -> Result<Vec<ScVal>> {
        args.iter().map(|a| self.scval(a)).collect()
    }

    /// ScVal JSON, after interpolation and the plan's byte shorthands.
    fn scval(&mut self, v: &Value) -> Result<ScVal> {
        let v = self.expand(v)?;
        serde_json::from_value(v.clone()).with_context(|| format!("{v} is not ScVal JSON"))
    }

    fn expand(&mut self, v: &Value) -> Result<Value> {
        Ok(match v {
            Value::String(s) => Value::String(self.interp(s)?),
            Value::Array(items) => Value::Array(items.iter().map(|i| self.expand(i)).collect::<Result<_>>()?),
            Value::Object(m) if m.len() == 1 => {
                let (k, inner) = m.iter().next().unwrap();
                let inner = self.expand(inner)?;
                match (k.as_str(), &inner) {
                    ("bytes_utf8", Value::String(s)) => serde_json::json!({ "bytes": hex(s.as_bytes()) }),
                    ("bytes_sha256", Value::String(s)) => serde_json::json!({ "bytes": hex(&Sha256::digest(s.as_bytes())) }),
                    // Interpolated numbers arrive as strings.
                    ("u32" | "i32" | "u64" | "i64" | "timepoint" | "duration", Value::String(s)) => {
                        let n: i128 = s.trim().parse().with_context(|| format!("{k}: {s:?} is not a number"))?;
                        serde_json::json!({ k: n })
                    }
                    _ => serde_json::json!({ k: inner }),
                }
            }
            Value::Object(m) => Value::Object(m.iter().map(|(k, v)| Ok((k.clone(), self.expand(v)?))).collect::<Result<_>>()?),
            other => other.clone(),
        })
    }

    // --- keys and signers ---

    fn ed25519(&self, name: &str) -> Result<Ed25519Key> {
        match self.keys.get(name) {
            Some(KeyMaterial::Ed25519(k)) => Ok(k.clone()),
            Some(_) => bail!("key {name} is not an ed25519 key"),
            None => bail!("unknown key {name}"),
        }
    }

    fn envelope_signers(&mut self, step: &Step, source: &AccountId) -> Result<Vec<Ed25519Key>> {
        if let Some(names) = &step.sign_with {
            return names.iter().map(|n| self.ed25519(n)).collect();
        }
        let source_addr = ScAddress::Account(source.clone());
        for (addr, spec) in step.auth.iter().chain(self.plan.signers.clone().iter()) {
            if let SignerSpec::Classic(c) = spec {
                if self.address(addr)? == source_addr {
                    let names = match c {
                        ClassicSpec::Keys(k) => k,
                        ClassicSpec::Full { keys, .. } => keys,
                    };
                    return names.iter().map(|n| self.ed25519(n)).collect();
                }
            }
        }
        for k in self.keys.values() {
            if let KeyMaterial::Ed25519(k) = k {
                if k.account_id() == *source {
                    return Ok(vec![k.clone()]);
                }
            }
        }
        bail!("no key signs for source {source}: add `sign_with`, a classic signer for it, or use a key's own account")
    }

    /// Every signer spec for this step, with addresses and keys resolved.
    /// Named OZ rules resolve only when `prepare` asks for that address.
    fn signer_specs(&mut self, step: &Step) -> Result<ResolvedSigners> {
        let mut out = BTreeMap::new();
        for (addr, spec) in self.plan.signers.clone().iter().chain(step.auth.iter()) {
            let address = self.address(addr)?;
            let resolved = match spec {
                SignerSpec::Classic(c) => {
                    let (names, address_bound) = match c {
                        ClassicSpec::Keys(k) => (k, false),
                        ClassicSpec::Full { keys, address_bound } => (keys, *address_bound),
                    };
                    let keys = names.iter().map(|n| self.ed25519(n)).collect::<Result<_>>()?;
                    Pending::Ready(AuthSigner::Classic { keys, address_bound })
                }
                SignerSpec::Oz(oz) => {
                    let digest = match oz.digest.as_str() {
                        "oz_rule_ids" => OzDigest::RuleIds,
                        "addr_oz_v1" => OzDigest::AddressBound { domain: oz.domain.clone().map(String::into_bytes).unwrap_or_else(|| ADDR_OZ_V1_DOMAIN.to_vec()) },
                        d => bail!("unknown OZ digest {d} (oz_rule_ids or addr_oz_v1)"),
                    };
                    let mut signers = vec![];
                    for s in &oz.signers {
                        signers.push(match s {
                            OzSignerSpec::External { verifier, key } => {
                                let key = match self.keys.get(key) {
                                    Some(KeyMaterial::Ed25519(k)) => ExternalKey::Ed25519(k.clone()),
                                    Some(KeyMaterial::Secp256r1(k)) => ExternalKey::Secp256r1(k.clone()),
                                    Some(KeyMaterial::WebAuthn(k, id)) => ExternalKey::WebAuthn { key: k.clone(), credential_id: id.clone() },
                                    None => bail!("unknown key {key}"),
                                };
                                OzSigner::External { verifier: self.address(verifier)?, key }
                            }
                            OzSignerSpec::Delegated { account, keys } => {
                                let account = self.interp(account)?;
                                OzSigner::Delegated {
                                    account: account.parse().map_err(|_| anyhow!("delegate {account} is not a G address"))?,
                                    keys: keys.iter().map(|n| self.ed25519(n)).collect::<Result<_>>()?,
                                }
                            }
                        });
                    }
                    match &oz.rule {
                        RuleSpec::Id(i) => Pending::Ready(AuthSigner::OzSmartAccount { rule_ids: vec![*i], digest, signers }),
                        RuleSpec::Ids(ids) => Pending::Ready(AuthSigner::OzSmartAccount { rule_ids: ids.clone(), digest, signers }),
                        RuleSpec::Named { name } => Pending::NamedRule { name: name.clone(), digest, signers },
                    }
                }
            };
            out.insert(address, resolved);
        }
        Ok(ResolvedSigners(out))
    }

    fn apply_override(&mut self, o: &OverrideSpec, default_label: &str) -> Result<()> {
        let label = o.label.clone().unwrap_or_else(|| default_label.to_string());
        let mut n = 0;
        if let Some(s) = &o.substitute_master_key {
            let account = self.account_id(&s.account)?;
            let key = self.ed25519(&s.key)?;
            self.session.substitute_master_key(&account, &key, &label)?;
            n += 1;
        }
        if let Some(s) = &o.substitute_signer {
            let account = self.account_id(&s.account)?;
            let real = self.account_id(&s.signer)?;
            let soroban_env_host::xdr::PublicKey::PublicKeyTypeEd25519(Uint256(real)) = real.0;
            let key = self.ed25519(&s.key)?;
            self.session.substitute_signer(&account, real, &key, &label)?;
            n += 1;
        }
        if let Some(f) = &o.fund {
            let account = self.account_id(&f.account)?;
            let number = |s: String| -> Result<i64> { s.trim().parse().with_context(|| format!("fund: {s:?} is not a whole number")) };
            let stroops = match (&f.xlm, &f.stroops) {
                (Some(x), None) => number(self.eval(x)?)?.checked_mul(10_000_000).ok_or_else(|| anyhow!("fund: overflow"))?,
                (None, Some(s)) => number(self.eval(s)?)?,
                _ => bail!("fund needs exactly one of xlm or stroops"),
            };
            self.session.fund(&account, stroops, &label)?;
            n += 1;
        }
        if let Some(e) = &o.set_entry {
            let xdr = self.interp(&e.xdr)?;
            let entry = LedgerEntry::from_xdr_base64(xdr.trim(), Limits::none()).context("set_entry xdr")?;
            if matches!(entry.data, LedgerEntryData::ContractData(_) | LedgerEntryData::ContractCode(_)) && e.live_until.is_none() {
                bail!("set_entry: contract data and code need live_until");
            }
            self.session.set_entry(StoredEntry { entry, live_until: e.live_until }, &label)?;
            n += 1;
        }
        if let Some(k) = &o.remove_entry {
            let xdr = self.interp(k)?;
            let key = LedgerKey::from_xdr_base64(xdr.trim(), Limits::none()).context("remove_entry key")?;
            self.session.remove_entry(&key, &label)?;
            n += 1;
        }
        if n != 1 {
            bail!("an override must do exactly one thing, this one does {n}");
        }
        Ok(())
    }

    fn account_id(&mut self, text: &str) -> Result<AccountId> {
        let t = self.interp(text)?;
        t.parse().map_err(|_| anyhow!("{t:?} is not a G address"))
    }

    /// Wasm bytes and hash for an upload step.
    fn wasm(&mut self, u: &crate::plan::UploadSpec) -> Result<(Vec<u8>, [u8; 32])> {
        let want = match &u.hash {
            Some(h) => Some(hex32(&self.interp(h)?).context("upload hash")?),
            None => None,
        };
        let check = |bytes: Vec<u8>, from: &str| -> Result<(Vec<u8>, [u8; 32])> {
            let got: [u8; 32] = Sha256::digest(&bytes).into();
            if let Some(w) = want {
                if got != w {
                    bail!("{from} has hash {}, the plan wants {}", hex(&got), hex(&w));
                }
            }
            Ok((bytes, got))
        };
        if let Some(f) = &u.file {
            let file = self.interp(f)?;
            let path = self.plan_dir.join(file);
            let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
            return check(bytes, &path.display().to_string());
        }
        let want = want.ok_or_else(|| anyhow!("upload needs file or hash"))?;
        let needle = hex(&want);
        for dir in &self.wasm_dirs {
            let Ok(rd) = std::fs::read_dir(dir) else { continue };
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().contains(&needle) {
                    let bytes = std::fs::read(e.path())?;
                    if Sha256::digest(&bytes)[..] == want[..] {
                        return Ok((bytes, want));
                    }
                }
            }
        }
        if let Some(rpc) = &self.bytes_source {
            let key = LedgerKey::ContractCode(LedgerKeyContractCode { hash: Hash(want) });
            if let Some(StoredEntry { entry: LedgerEntry { data: LedgerEntryData::ContractCode(c), .. }, .. }) = rpc.ledger_entries(&[key])?.entries.into_iter().next() {
                return check(c.code.to_vec(), &format!("{} code {needle}", rpc.url));
            }
        }
        bail!("no Wasm with hash {needle}: not in {:?}{}", self.wasm_dirs, if self.bytes_source.is_some() { " nor on the bytes source" } else { "" })
    }

    // --- report ---

    fn report(&self) -> Report {
        let s = &self.session;
        let fork = s.fork_point();
        let log = s.log();
        let mut by_payer: BTreeMap<String, PayerFees> = BTreeMap::new();
        for t in log {
            let Some(src) = &t.source else { continue };
            if matches!(t.status, TxStatus::Rejected { .. }) {
                continue;
            }
            let p = by_payer.entry(src.to_string()).or_insert_with(|| PayerFees { account: src.to_string(), transactions: 0, charged: 0, refunded: 0, max_fee_bid: 0 });
            p.transactions += 1;
            p.charged += t.fee_charged;
            p.refunded += t.refund;
            p.max_fee_bid = p.max_fee_bid.max(t.fees.bid);
        }
        let diff = s.ledger().diff();
        let mut by_type = BTreeMap::new();
        let mut entries = vec![];
        let mut accounts = vec![];
        for d in &diff {
            *by_type.entry(d.key.name().to_string()).or_insert(0) += 1;
            entries.push(DiffReport {
                key_type: d.key.name().into(),
                key: describe_key(&d.key),
                change: d.change().as_str().into(),
                overridden: d.overridden,
                live_until_before: d.before.as_ref().and_then(|e| e.live_until),
                live_until_after: d.after.as_ref().and_then(|e| e.live_until),
            });
            if let LedgerKey::Account(a) = &d.key {
                let acct = |e: &Option<StoredEntry>| match e {
                    Some(StoredEntry { entry: LedgerEntry { data: LedgerEntryData::Account(a), .. }, .. }) => Some((a.balance, a.seq_num.0)),
                    _ => None,
                };
                let (b, a2) = (acct(&d.before), acct(&d.after));
                accounts.push(AccountChange {
                    account: a.account_id.to_string(),
                    balance_before: b.map(|x| x.0),
                    balance_after: a2.map(|x| x.0),
                    seq_before: b.map(|x| x.1),
                    seq_after: a2.map(|x| x.1),
                    overridden: d.overridden,
                });
            }
        }
        let fetches = s.ledger().fetches();
        let stats = s.ledger().stats();
        let drift = s.ledger().drift();
        let replayable: Vec<String> = log.iter().flat_map(|t| t.replayable.iter().map(move |r| format!("{}: {r}", t.label))).collect();
        let mut failures = self.failures.clone();
        if !replayable.is_empty() && self.passphrase == MAINNET_PASSPHRASE {
            failures.push(format!("{} signature(s) are valid on mainnet (see Safety)", replayable.len()));
        }
        let info = s.ledger_info();
        Report {
            format: REPORT_FORMAT,
            plan: PlanInfo { path: self.plan_path.display().to_string(), name: self.plan.name.clone(), description: self.plan.description.clone() },
            network: NetworkInfo { name: self.network_name.clone(), passphrase: self.passphrase.clone(), base: self.base_description.clone() },
            fork: ForkInfo { ledger: fork.ledger_seq, close_time: fork.close_time, protocol_version: fork.protocol_version, base_fee: fork.base_fee, base_reserve: fork.base_reserve },
            host: HostInfo { protocol_version: host_protocol(), soroban_env_host: ENV_HOST_VERSION },
            fidelity: vec![
                "Host-exact: contracts run in the same soroban-env-host as the network's protocol, in enforcing mode, with a module cache, and every auth signature is verified.".into(),
                "Envelope-approximate: the transaction layer (sequence numbers, preconditions, signature weights and thresholds, fee bid, resource fee and limits, balance above reserve, fee charged before apply, rent and refund) is a port of stellar-core's checks, not core itself.".into(),
                "Not modelled: classic operations (funding is an override), fee-bump and muxed fee sources, surge pricing, several transactions per ledger, per-ledger limits, and core's PRNG seed.".into(),
                "The fork reads RPC's latest ledger lazily; drift below lists any entry that changed after the fork ledger.".into(),
            ],
            end: LedgerPoint { ledger: info.sequence_number, close_time: info.timestamp },
            passed: failures.is_empty(),
            failures,
            steps: self.steps.clone(),
            overrides: s
                .ledger()
                .overrides()
                .iter()
                .map(|o| OverrideReport { kind: o.kind.as_str().into(), entry: describe_key(&o.key), label: o.label.clone(), detail: o.detail.clone(), at_ledger: o.at_ledger })
                .collect(),
            fees: FeeSummary {
                transactions: log.len(),
                applied: log.iter().filter(|t| matches!(t.status, TxStatus::Applied { .. })).count(),
                failed: log.iter().filter(|t| matches!(t.status, TxStatus::Failed { .. })).count(),
                rejected: log.iter().filter(|t| matches!(t.status, TxStatus::Rejected { .. })).count(),
                total_charged: log.iter().map(|t| t.fee_charged).sum(),
                total_refunded: log.iter().map(|t| t.refund).sum(),
                by_payer: by_payer.into_values().collect(),
            },
            accounts,
            diff: DiffSummary { total: diff.len(), by_type, entries },
            drift: DriftReport {
                fork_ledger: fork.ledger_seq,
                served_at_min: fetches.iter().map(|f| f.served_at_ledger).min(),
                served_at_max: fetches.iter().map(|f| f.served_at_ledger).max(),
                modified_after_fork: drift.iter().map(|f| DriftEntry { key: describe_key(&f.key), last_modified: f.last_modified, served_at: f.served_at_ledger }).collect(),
            },
            fetch: FetchStats {
                rpc_calls: self.rpc.as_ref().map_or(0, |r| r.calls()),
                throttled_retries: self.rpc.as_ref().map_or(0, |r| r.throttled()),
                base_fetch_calls: stats.fetch_calls,
                keys_fetched: stats.keys_fetched,
                keys_present: fetches.iter().filter(|f| f.found).count() as u32,
                local_answers: stats.local_answers,
            },
            safety: Safety {
                replayable,
                note: "The session never submits anything, and rehearsal envelopes keep the real network id. Throwaway keys stand in for every real signer, so these envelopes are not valid on the real network unless a signer the network already has signed them.".into(),
            },
            differential: self.differentials.clone(),
        }
    }
}

/// A forked base: how to open a session on it (again, for `fresh_fork` views).
struct Forked {
    network_name: String,
    passphrase: String,
    rpc: Option<Rc<RpcClient>>,
    description: String,
    fresh: Box<dyn Fn() -> Result<Session>>,
}

fn fork_base(base: Base, options: &SessionOptions) -> Result<Forked> {
    match base {
        Base::Rpc { name, url, passphrase } => {
            let rpc = Rc::new(RpcClient::new(&url));
            let actual = rpc.network_passphrase()?;
            if let Some(p) = &passphrase {
                if *p != actual {
                    bail!("{url} serves {actual:?}, not {p:?}");
                }
            }
            let latest = rpc.latest_ledger()?;
            if latest.protocol_version != host_protocol() {
                bail!("{name} is on protocol {}, this build's host implements protocol {}", latest.protocol_version, host_protocol());
            }
            let fork = ForkPoint {
                ledger_seq: latest.sequence,
                close_time: latest.header.scp_value.close_time.0,
                protocol_version: latest.protocol_version,
                base_reserve: latest.header.base_reserve,
                base_fee: latest.header.base_fee,
            };
            let mut options = options.clone();
            options.network_passphrase = actual.clone();
            let source = rpc.clone();
            Ok(Forked {
                network_name: name,
                passphrase: actual,
                description: RpcSource(rpc.clone()).describe(),
                rpc: Some(rpc),
                fresh: Box::new(move || Session::new(Box::new(RpcSource(source.clone())), fork.clone(), options.clone())),
            })
        }
        Base::Snapshot(path) => {
            let snap = SnapshotFile::load(&path)?;
            let mut options = options.clone();
            options.network_passphrase = snap.network_passphrase.clone();
            Ok(Forked {
                network_name: format!("snapshot {}", path.display()),
                passphrase: snap.network_passphrase.clone(),
                description: format!("snapshot {} ({} entries)", path.display(), snap.entries.len()),
                rpc: None,
                fresh: Box::new(move || Session::new(Box::new(snap.source()?), snap.fork_point(), options.clone())),
            })
        }
    }
}

/// Plan signer specs keyed by address.
struct ResolvedSigners(BTreeMap<ScAddress, Pending>);

enum Pending {
    Ready(AuthSigner),
    NamedRule { name: String, digest: OzDigest, signers: Vec<OzSigner> },
}

impl AuthSignerSource for ResolvedSigners {
    fn signer_for(&self, session: &Session, address: &ScAddress) -> Result<Option<AuthSigner>> {
        Ok(match self.0.get(address) {
            None => None,
            Some(Pending::Ready(s)) => Some(s.clone()),
            Some(Pending::NamedRule { name, digest, signers }) => {
                let id = rule_id(session, address, name)?;
                Some(AuthSigner::OzSmartAccount { rule_ids: vec![id], digest: digest.clone(), signers: signers.clone() })
            }
        })
    }
}

/// The id of the OZ context rule named `name`, read through
/// `get_context_rule(id)` (ids move when an account's rules change).
fn rule_id(session: &Session, account: &ScAddress, name: &str) -> Result<u32> {
    let want = ScVal::String(ScString(name.try_into().map_err(|_| anyhow!("bad rule name {name}"))?));
    let field = ScVal::Symbol(ScSymbol("name".try_into().unwrap()));
    for id in 0..64u32 {
        let call = HostFunction::InvokeContract(InvokeContractArgs {
            contract_address: account.clone(),
            function_name: ScSymbol("get_context_rule".try_into().unwrap()),
            args: vec![ScVal::U32(id)].try_into()?,
        });
        if let Ok(ScVal::Map(Some(m))) = session.view(&call)? {
            if m.iter().any(|e| e.key == field && e.val == want) {
                return Ok(id);
            }
        }
    }
    bail!("{account} has no context rule named {name}")
}

fn key_material(name: &str, spec: &KeySpec) -> Result<KeyMaterial> {
    Ok(match spec {
        KeySpec::Kind(k) => match k.as_str() {
            "ed25519" => KeyMaterial::Ed25519(Ed25519Key::throwaway(name)),
            "secp256r1" => KeyMaterial::Secp256r1(Secp256r1Key::throwaway(name)),
            "webauthn" => KeyMaterial::WebAuthn(Secp256r1Key::throwaway(name), vec![]),
            other => bail!("key {name}: unknown kind {other}"),
        },
        KeySpec::Labeled { ed25519, secp256r1, webauthn, credential_id } => match (ed25519, secp256r1, webauthn) {
            (Some(l), None, None) => KeyMaterial::Ed25519(Ed25519Key::throwaway(l)),
            (None, Some(l), None) => KeyMaterial::Secp256r1(Secp256r1Key::throwaway(l)),
            (None, None, Some(l)) => KeyMaterial::WebAuthn(Secp256r1Key::throwaway(l), credential_id.as_deref().map(unhex).transpose()?.unwrap_or_default()),
            _ => bail!("key {name}: give exactly one of ed25519, secp256r1 or webauthn"),
        },
    })
}

pub fn contract_id(network_id: [u8; 32], deployer: ScAddress, salt: [u8; 32]) -> Result<ScAddress> {
    let pre = HashIdPreimage::ContractId(HashIdPreimageContractId {
        network_id: Hash(network_id),
        contract_id_preimage: ContractIdPreimage::Address(ContractIdPreimageFromAddress { address: deployer, salt: Uint256(salt) }),
    });
    Ok(ScAddress::Contract(ContractId(Hash(Sha256::digest(pre.to_xdr(Limits::none())?).into()))))
}

/// The text a saved value or `expect.equals` compares: an address's strkey, a
/// string's or symbol's text, a number, hex bytes, or ScVal JSON.
pub fn render(v: &ScVal) -> String {
    match v {
        ScVal::String(s) => s.to_utf8_string_lossy(),
        ScVal::Symbol(s) => s.to_utf8_string_lossy(),
        ScVal::Address(_)
        | ScVal::Bool(_)
        | ScVal::U32(_)
        | ScVal::I32(_)
        | ScVal::U64(_)
        | ScVal::I64(_)
        | ScVal::U128(_)
        | ScVal::I128(_)
        | ScVal::Bytes(_) => show_scval(v),
        ScVal::Void => String::new(),
        other => serde_json::to_string(other).unwrap_or_else(|_| show_scval(other)),
    }
}

fn tx_report(t: &TxRecord) -> TxReport {
    TxReport {
        hash: hex(&t.hash),
        source: t.source.as_ref().map(|s| s.to_string()).unwrap_or_default(),
        fee_bid: t.fees.bid,
        resource_fee: t.fees.resource_fee,
        non_refundable_fee: t.fees.non_refundable,
        refundable_fee: t.fees.refundable,
        inclusion_fee: t.fees.inclusion,
        fee_charged: t.fee_charged,
        refunded: t.refund,
        rent_fee: t.rent_fee,
        events_fee: t.events_fee,
        cpu_insns: t.cpu_insns,
        declared_cpu_insns: t.declared_insns,
        mem_bytes: t.mem_bytes,
        write_bytes: t.write_bytes,
        declared_write_bytes: t.declared_write_bytes,
        entries_written: t.entries_written,
        restored: t.restored,
        events: t.events.len(),
        contract_errors: t.contract_errors(),
        signers: t.signers.iter().map(|m| format!("{} for {} (weight {})", m.key, m.account, m.weight)).collect(),
        replayable: t.replayable.clone(),
    }
}

fn not_run(index: usize, label: &str, step: &Step) -> StepReport {
    StepReport {
        index,
        name: label.to_string(),
        kind: step.kind().into(),
        ledger: 0,
        close_time: 0,
        outcome: "not run".into(),
        detail: "an earlier step failed".into(),
        expected: expected_text(step.expect.as_ref()),
        passed: false,
        value: None,
        value_scval: None,
        saved: None,
        tx: None,
    }
}

fn expected_text(e: Option<&Expect>) -> Option<String> {
    let e = e?;
    let mut parts = vec![];
    match &e.fails {
        Some(Fails::Any(true)) => parts.push("fails".to_string()),
        Some(Fails::Containing(s)) => parts.push(format!("fails with {s}")),
        _ => {}
    }
    if let Some(v) = &e.equals {
        parts.push(format!("= {v}"));
    }
    if let Some(v) = &e.value {
        parts.push(format!("= {v}"));
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn progress_line(r: &StepReport) -> String {
    let mark = if r.passed { "✓" } else { "✗" };
    let fee = r.tx.as_ref().filter(|_| r.outcome != "rejected").map(|t| format!(" | fee {} XLM (refund {}) | cpu {}/{}", soroban_sim_core::session::xlm(t.fee_charged), soroban_sim_core::session::xlm(t.refunded), t.cpu_insns, t.declared_cpu_insns)).unwrap_or_default();
    let detail = soroban_sim_core::session::clip(&r.detail, 200);
    format!("  {mark} L{} {} — {}: {}{fee}", r.ledger, r.name, r.outcome, shorten_addresses(&detail))
}

fn hex32(s: &str) -> Result<[u8; 32]> {
    unhex(s)?.try_into().map_err(|_| anyhow!("{s:?} is not 32 bytes of hex"))
}

fn unhex(s: &str) -> Result<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        bail!("{s:?} is not hex");
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| anyhow!("{s:?} is not hex"))).collect()
}

/// For tests: the account key of a G address.
pub fn account_ledger_key(g: &str) -> Result<LedgerKey> {
    Ok(account_key(&g.parse().map_err(|_| anyhow!("{g} is not a G address"))?))
}

/// For snapshot builders: an entry as base64 XDR.
pub fn entry_xdr(e: &LedgerEntry) -> Result<String> {
    Ok(B64.encode(e.to_xdr(Limits::none())?))
}
