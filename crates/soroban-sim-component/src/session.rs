//! The WIT `network-session` resource: a [`Facade`] over a [`DeferredBase`]
//! the caller fills in. Every method is one facade JSON-RPC call, so the
//! typed methods and `rpc` share one implementation with `soroban-sim serve`.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use soroban_env_host::xdr::{LedgerEntry, LedgerHeader, LedgerKey, Limits, ReadXdr, WriteXdr};
use soroban_sim_core::session::{ForkPoint, SessionOptions, StoredEntry};
use soroban_sim_facade::{open, DeferredBase, Facade, FacadeConfig, Opened, Reply as FacadeReply};
use std::cell::RefCell;
use std::rc::Rc;

use crate::exports::theahaco::soroban_sim::network_session::{
    BaseBatch, ForkConfig, GuestSession, LedgerOverride, Reply,
};

enum State {
    /// Not opened yet: opening reads the network's settings from the base.
    Pending { fork: ForkPoint, options: SessionOptions, config: FacadeConfig },
    Open(Box<Facade>),
}

pub struct NetworkSession {
    base: Rc<DeferredBase>,
    state: RefCell<State>,
    /// The caller's base RPC counters, applied once the facade is open.
    counters: RefCell<(u32, u32)>,
}

impl GuestSession for NetworkSession {
    fn new(config: ForkConfig) -> Self {
        let mut options = SessionOptions::new(&config.network_passphrase);
        if config.seconds_per_ledger > 0 {
            options.seconds_per_ledger = config.seconds_per_ledger as u64;
        }
        let fork = ForkPoint {
            ledger_seq: config.fork_ledger,
            close_time: config.fork_close_time,
            protocol_version: config.protocol_version,
            base_reserve: config.base_reserve,
            base_fee: config.base_fee,
        };
        // A header that does not decode is dropped for one built from the
        // fork point, as for a snapshot base.
        let header = config.header_xdr.and_then(|b| LedgerHeader::from_xdr(b, Limits::none()).ok());
        let facade = FacadeConfig {
            network_name: config.network_name,
            passphrase: config.network_passphrase,
            base_description: config.base_description.clone(),
            header,
            allow_real_signers: config.allow_real_signers,
            served_by: config.served_by,
        };
        Self {
            base: DeferredBase::new(&config.base_description),
            state: RefCell::new(State::Pending { fork, options, config: facade }),
            counters: RefCell::new((0, 0)),
        }
    }

    fn provide(&self, batch: BaseBatch) -> Result<(), String> {
        let entries = batch
            .entries
            .into_iter()
            .map(|e| {
                Ok(StoredEntry {
                    entry: LedgerEntry::from_xdr(e.entry_xdr, Limits::none()).map_err(|e| format!("a base entry is not LedgerEntry XDR: {e}"))?,
                    live_until: e.live_until_ledger,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let absent = batch
            .absent_keys
            .into_iter()
            .map(|k| LedgerKey::from_xdr(k, Limits::none()).map_err(|e| format!("an absent key is not LedgerKey XDR: {e}")))
            .collect::<Result<Vec<_>, String>>()?;
        self.base.provide(batch.served_at_ledger, entries, absent).map_err(|e| format!("{e:#}"))
    }

    fn rpc(&self, body: String) -> Result<Reply, String> {
        self.answer(body.as_bytes())
    }

    fn submit(&self, envelope_xdr: Vec<u8>) -> Result<Reply, String> {
        self.call("sendTransaction", json!({ "transaction": B64.encode(envelope_xdr) }))
    }

    fn advance(&self, ledgers: u32, seconds: Option<u64>) -> Result<Reply, String> {
        self.call("fork_advanceLedgers", json!({ "ledgers": ledgers, "seconds": seconds }))
    }

    fn set_time(&self, time: u64) -> Result<Reply, String> {
        self.call("fork_setTime", json!({ "time": time }))
    }

    fn apply_override(&self, change: LedgerOverride) -> Result<Reply, String> {
        match change {
            LedgerOverride::SetBalance(o) => self.call("fork_setBalance", json!({ "account": o.account, "stroops": o.stroops, "label": o.label })),
            LedgerOverride::AddSigner(o) => self.call(
                "fork_addSigner",
                json!({ "account": o.account, "signer": o.signer, "replace": o.replace.unwrap_or_else(|| "master".into()), "label": o.label }),
            ),
            LedgerOverride::SetEntry(o) => self.call(
                "fork_setLedgerEntry",
                json!({ "entry": B64.encode(o.entry_xdr), "liveUntilLedgerSeq": o.live_until_ledger, "label": o.label }),
            ),
            LedgerOverride::RemoveEntry(o) => self.call("fork_removeLedgerEntry", json!({ "key": B64.encode(o.key_xdr), "label": o.label })),
        }
    }

    fn snapshot(&self, label: String) -> Result<Reply, String> {
        self.call("fork_snapshot", json!({ "label": label }))
    }

    fn revert(&self, id: u32) -> Result<Reply, String> {
        self.call("fork_revert", json!({ "id": id }))
    }

    fn allow_real_signers(&self, allow: bool) -> Result<Reply, String> {
        self.call("fork_allowRealSigners", json!({ "allow": allow }))
    }

    fn steps(&self) -> Result<Reply, String> {
        self.call("fork_steps", Value::Null)
    }

    fn debug_context(&self, step: u32) -> Result<Reply, String> {
        self.call("fork_debugContext", json!({ "step": step }))
    }

    fn report(&self) -> Result<Reply, String> {
        self.call("fork_report", Value::Null)
    }

    fn set_rpc_counters(&self, calls: u32, throttled_retries: u32) {
        *self.counters.borrow_mut() = (calls, throttled_retries);
        if let State::Open(f) = &mut *self.state.borrow_mut() {
            f.set_rpc_counters(calls, throttled_retries);
        }
    }
}

impl NetworkSession {
    fn call(&self, method: &str, params: Value) -> Result<Reply, String> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        self.answer(body.to_string().as_bytes())
    }

    /// Open the session if it is not yet, then answer `body`. Either step
    /// may need base entries; a call that does is undone.
    fn answer(&self, body: &[u8]) -> Result<Reply, String> {
        let mut state = self.state.borrow_mut();
        if let State::Pending { fork, options, config } = &*state {
            match open(&self.base, fork.clone(), options.clone(), config.clone()).map_err(|e| format!("{e:#}"))? {
                Opened::Ready(mut facade) => {
                    let (calls, throttled) = *self.counters.borrow();
                    facade.set_rpc_counters(calls, throttled);
                    *state = State::Open(facade);
                }
                Opened::NeedsState(keys) => return needs_state(keys),
            }
        }
        let State::Open(facade) = &mut *state else { unreachable!("opened above") };
        match facade.answer(&self.base, body) {
            FacadeReply::Response(v) => Ok(Reply::Response(v.map(|v| v.to_string()))),
            FacadeReply::NeedsState(keys) => needs_state(keys),
        }
    }
}

fn needs_state(keys: Vec<LedgerKey>) -> Result<Reply, String> {
    let keys = keys.iter().map(|k| k.to_xdr(Limits::none()).map_err(|e| e.to_string())).collect::<Result<Vec<_>, _>>()?;
    Ok(Reply::NeedsState(keys))
}
