//! `soroban-sim serve`: a Stellar RPC facade over one session, so stock tools
//! (`stellar`, stellar-sdk, perch-deploy) and the scripts built on them
//! rehearse against a fork unchanged, pointed at it with `STELLAR_RPC_URL`.
//!
//! The request handling is `soroban-sim-facade`, the same code the browser
//! session answers its virtual RPC with. This module adds what a command line
//! needs: forking an RPC or snapshot base, HTTP ([`http`]), progress lines,
//! and the report files rewritten after every state change.
//!
//! The facade keeps the real network passphrase, so every signature it checks
//! is a real one, and an envelope a real key signed is valid on the real
//! network too. On mainnet it refuses those unless started with
//! `--allow-real-signers`; throwaway keys substituted with `fork_addSigner`
//! are the default. Nothing is forwarded to the network: the base is only read.

pub mod http;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use soroban_sim_core::session::{Session, SessionOptions};
use soroban_sim_facade::report::Report;
use soroban_sim_facade::FacadeConfig;
use std::path::PathBuf;
use std::rc::Rc;

pub use soroban_sim_facade::RpcError;

use crate::rpc::RpcClient;
use crate::run::{fork_base, progress_line, Base};

pub struct ServeConfig {
    pub base: Base,
    /// Close-time step between ledgers; the network's 5 s by default.
    pub seconds_per_ledger: Option<u64>,
    /// Apply envelopes a signer of the real network signed, even on mainnet.
    pub allow_real_signers: bool,
    /// Rewrite `PREFIX.json` and `PREFIX.md` after every state change.
    pub report: Option<PathBuf>,
    /// One line on stderr per state change.
    pub progress: bool,
    /// One line on stderr per call, reads included.
    pub verbose: bool,
}

pub struct Facade {
    inner: soroban_sim_facade::Facade,
    rpc: Option<Rc<RpcClient>>,
    report_prefix: Option<PathBuf>,
    progress: bool,
    verbose: bool,
    /// Steps already printed and written to the report files.
    seen: usize,
}

impl Facade {
    pub fn open(config: ServeConfig) -> Result<Self> {
        let mut options = SessionOptions::new("");
        if let Some(s) = config.seconds_per_ledger {
            if s == 0 {
                bail!("--seconds-per-ledger must be at least 1");
            }
            options.seconds_per_ledger = s;
        }
        let forked = fork_base(config.base, &options)?;
        let session = (forked.fresh)().context("forking the network")?;
        let inner = soroban_sim_facade::Facade::new(
            session,
            FacadeConfig {
                network_name: forked.network_name,
                passphrase: forked.passphrase,
                base_description: forked.description,
                header: forked.header,
                allow_real_signers: config.allow_real_signers,
                served_by: "soroban-sim serve".into(),
            },
        );
        Ok(Self { inner, rpc: forked.rpc, report_prefix: config.report, progress: config.progress, verbose: config.verbose, seen: 0 })
    }

    /// The URL clients reach the facade at, for the report.
    pub fn set_url(&mut self, url: &str) {
        self.inner.set_served_by(&format!("soroban-sim serve at {url}"));
    }

    pub fn session(&self) -> &Session {
        self.inner.session()
    }

    pub fn passphrase(&self) -> &str {
        self.inner.passphrase()
    }

    pub fn network_name(&self) -> &str {
        self.inner.network_name()
    }

    /// Answer one HTTP body: a single call or a batch. `None` when every
    /// call was a notification (no `id`), which gets no response.
    pub fn handle_body(&mut self, body: &[u8]) -> Option<Value> {
        let methods = methods(body);
        if self.verbose {
            for (m, _) in &methods {
                eprintln!("  · {m}");
            }
        }
        let mut reply = self.inner.handle_body(body);
        self.after_call();
        // fork_report also says which files it rewrote.
        let report_ids: Vec<&Value> = methods.iter().filter(|(m, _)| m == "fork_report").filter_map(|(_, id)| id.as_ref()).collect();
        if !report_ids.is_empty() {
            let files = json!(self.write_report().unwrap_or_default());
            let replies = match reply.as_mut() {
                Some(Value::Array(rs)) => rs.iter_mut().collect(),
                Some(r) => vec![r],
                None => vec![],
            };
            for r in replies.into_iter().filter(|r| r.get("id").is_some_and(|id| report_ids.contains(&id))) {
                if let Some(result) = r.get_mut("result") {
                    result["files"] = files.clone();
                }
            }
        }
        reply
    }

    /// Run one method. `fork_report` also says which files it rewrote.
    pub fn call(&mut self, method: &str, params: Value) -> std::result::Result<Value, RpcError> {
        if self.verbose {
            eprintln!("  · {method}");
        }
        let result = self.inner.call(method, params);
        self.after_call();
        match (method, result) {
            ("fork_report", Ok(mut r)) => {
                let files = self.write_report().map_err(|e| RpcError { code: RpcError::INTERNAL, message: format!("{e:#}") })?;
                r["files"] = json!(files);
                Ok(r)
            }
            (_, r) => r,
        }
    }

    /// The same report `session run` writes, with one step per state change.
    pub fn report(&self) -> Report {
        self.inner.report()
    }

    /// Print and record the steps the last call added.
    fn after_call(&mut self) {
        if let Some(rpc) = &self.rpc {
            self.inner.set_rpc_counters(rpc.calls(), rpc.throttled());
        }
        let steps = self.inner.step_reports();
        if steps.len() == self.seen {
            return;
        }
        if self.progress {
            for s in &steps[self.seen.min(steps.len())..] {
                eprintln!("{}", progress_line(s));
            }
        }
        self.seen = steps.len();
        if let Err(e) = self.write_report() {
            eprintln!("warning: {e:#}");
        }
    }

    fn write_report(&self) -> Result<Vec<String>> {
        let Some(prefix) = &self.report_prefix else { return Ok(vec![]) };
        let report = self.report();
        let json_path = PathBuf::from(format!("{}.json", prefix.display()));
        let md_path = PathBuf::from(format!("{}.md", prefix.display()));
        std::fs::write(&json_path, report.to_json()?).with_context(|| format!("writing {}", json_path.display()))?;
        std::fs::write(&md_path, report.to_markdown()).with_context(|| format!("writing {}", md_path.display()))?;
        Ok(vec![json_path.display().to_string(), md_path.display().to_string()])
    }
}

/// Each call's method and id in a body.
fn methods(body: &[u8]) -> Vec<(String, Option<Value>)> {
    let Ok(v) = serde_json::from_slice::<Value>(body) else { return vec![] };
    let calls = match v {
        Value::Array(calls) => calls,
        call => vec![call],
    };
    calls.iter().filter_map(|c| Some((c.get("method")?.as_str()?.to_string(), c.get("id").cloned()))).collect()
}
