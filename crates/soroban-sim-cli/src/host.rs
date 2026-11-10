//! The hosts this binary links, and which one a run uses.
//!
//! Each protocol's host is a separate build of the whole engine: this crate's
//! library (protocol 29) and `soroban-sim-cli-p30`, a byte-for-byte copy of it
//! built against soroban-env-host 30 (see `scripts/sync-protocol-twins.py`).
//! Everything here reads only JSON, YAML and Wasm, never ledger XDR, whose
//! layout is what changes between protocols.
//!
//! A run uses, in order:
//! 1. `--protocol N`;
//! 2. a live network's protocol (`getLatestLedger`'s `protocolVersion`), or a
//!    replay fixture's: those ledgers need that exact host;
//! 3. offline, the oldest host that runs both the snapshot's ledger and every
//!    contract Wasm the plan uploads from a file (`contractenvmetav0`);
//! 4. with nothing to go on, the oldest host.

use anyhow::{bail, Context, Result};
use clap::{ArgMatches, FromArgMatches};
use soroban_sim_cli::cli::{Cli, Command, ReplayCommand, SessionCommand};
use soroban_sim_cli::plan::Plan;
use soroban_sim_cli::replay::ReplayFixture;
use soroban_sim_cli::rpc::RpcClient;
use soroban_sim_cli::run::{base_from_name, base_from_spec, Base};
use soroban_sim_cli::snapshot::SnapshotFile;
use std::collections::BTreeSet;
use std::path::Path;

/// A host this binary links.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    P29,
    P30,
}

impl Host {
    /// Oldest first.
    pub const ALL: [Host; 2] = [Host::P29, Host::P30];

    pub fn protocol(self) -> u32 {
        match self {
            Host::P29 => 29,
            Host::P30 => 30,
        }
    }

    /// Run the parsed command line with this host's engine.
    pub fn run(self, matches: &ArgMatches) -> Result<bool> {
        match self {
            Host::P29 => soroban_sim_cli::cli::run(Cli::from_arg_matches(matches)?),
            Host::P30 => soroban_sim_cli_p30::cli::run(soroban_sim_cli_p30::cli::Cli::from_arg_matches(matches)?),
        }
    }

    fn exactly(protocol: u32) -> Option<Host> {
        Host::ALL.into_iter().find(|h| h.protocol() == protocol)
    }

    fn oldest_running(protocol: u32) -> Option<Host> {
        Host::ALL.into_iter().find(|h| h.protocol() >= protocol)
    }
}

fn supported() -> String {
    Host::ALL.map(|h| h.protocol().to_string()).join(", ")
}

/// What a run's inputs say about its protocol.
#[derive(Debug, PartialEq, Eq)]
pub enum Evidence {
    /// Ledgers that ran on exactly this protocol: a live network or replay
    /// fixtures. `what` names them in errors.
    Exact { what: String, protocol: u32 },
    /// Offline inputs: a snapshot's ledger and contract Wasm. Each runs on
    /// its protocol's host or a newer one.
    AtLeast(Vec<(String, u32)>),
}

/// The host for `evidence`, unless `--protocol` names one.
pub fn select(protocol_override: Option<u32>, evidence: Evidence) -> Result<Host> {
    if let Some(p) = protocol_override {
        return Host::exactly(p).with_context(|| format!("--protocol {p}: this build supports {}", supported()));
    }
    match evidence {
        Evidence::Exact { what, protocol } => {
            Host::exactly(protocol).with_context(|| format!("{what} is on protocol {protocol}, this build supports {}", supported()))
        }
        Evidence::AtLeast(needs) => {
            let Some((what, protocol)) = needs.into_iter().max_by_key(|(_, p)| *p) else {
                return Ok(Host::ALL[0]);
            };
            Host::oldest_running(protocol).with_context(|| format!("{what} is on protocol {protocol}, this build supports {}", supported()))
        }
    }
}

/// The host for a parsed command line. Reads the network only when
/// `--protocol` is absent.
pub fn for_cli(cli: &Cli) -> Result<Host> {
    match cli.protocol {
        Some(p) => select(Some(p), Evidence::AtLeast(vec![])),
        None => select(None, evidence(cli)?),
    }
}

fn evidence(cli: &Cli) -> Result<Evidence> {
    Ok(match &cli.command {
        Command::Serve(args) => match (&args.fork, &args.snapshot) {
            (Some(f), _) => network(base_from_name(f, None)?)?,
            (None, Some(s)) => Evidence::AtLeast(vec![snapshot(s)?]),
            (None, None) => Evidence::AtLeast(vec![]),
        },
        Command::Session(SessionCommand::Check { plan }) => Evidence::AtLeast(contracts(&Plan::load(plan)?, plan)),
        Command::Session(SessionCommand::Run(args)) => {
            let plan = Plan::load(&args.plan)?;
            match (&args.fork, &args.snapshot, &plan.network) {
                (Some(f), _, _) => network(base_from_name(f, None)?)?,
                (None, Some(s), _) => Evidence::AtLeast([vec![snapshot(s)?], contracts(&plan, &args.plan)].concat()),
                (None, None, Some(spec)) => network(base_from_spec(spec)?)?,
                (None, None, None) => Evidence::AtLeast(contracts(&plan, &args.plan)),
            }
        }
        Command::Replay(ReplayCommand::Fetch(args)) => network(base_from_name(&args.network, None)?)?,
        Command::Replay(ReplayCommand::Run(args)) => {
            let mut protocols = BTreeSet::new();
            for path in &args.fixtures {
                protocols.extend(ReplayFixture::load(path)?.transactions.iter().map(|t| t.protocol_version));
            }
            let list = protocols.iter().map(u32::to_string).collect::<Vec<_>>();
            match list.len() {
                0 => Evidence::AtLeast(vec![]),
                1 => Evidence::Exact { what: "the replay fixtures".into(), protocol: protocols.into_iter().next().unwrap() },
                _ => bail!("the replay fixtures span protocols {}: replay each protocol's fixtures on their own", list.join(", ")),
            }
        }
    })
}

fn network(base: Base) -> Result<Evidence> {
    let Base::Rpc { name, url, .. } = base else { return Ok(Evidence::AtLeast(vec![])) };
    let protocol = RpcClient::new(&url).protocol_version().with_context(|| format!("reading {name}'s protocol"))?;
    Ok(Evidence::Exact { what: name, protocol })
}

fn snapshot(path: &Path) -> Result<(String, u32)> {
    Ok((format!("snapshot {}", path.display()), SnapshotFile::load(path)?.fork.protocol_version))
}

/// The protocol each contract Wasm the plan uploads from a file was built
/// for. Files named through `${…}` or missing are left to the run to report.
fn contracts(plan: &Plan, plan_path: &Path) -> Vec<(String, u32)> {
    let dir = plan_path.parent().unwrap_or(Path::new(""));
    plan.steps
        .iter()
        .filter_map(|s| s.upload.as_ref()?.file.as_deref())
        .filter(|f| !f.contains("${"))
        .filter_map(|f| {
            let bytes = std::fs::read(dir.join(f)).ok()?;
            Some((format!("contract {f}"), contract_protocol(&bytes)?))
        })
        .collect()
}

/// The protocol in a contract's `contractenvmetav0` custom section: its
/// first `SCEnvMetaEntry` of kind 0, an interface version whose high 32 bits
/// (or first field, in later XDR) are the protocol.
pub fn contract_protocol(wasm: &[u8]) -> Option<u32> {
    let mut rest = wasm.strip_prefix(b"\0asm\x01\0\0\0")?;
    while !rest.is_empty() {
        let id = rest[0];
        rest = &rest[1..];
        let size = leb128(&mut rest)? as usize;
        let (section, after) = (rest.get(..size)?, rest.get(size..)?);
        rest = after;
        if id != 0 {
            continue;
        }
        let mut section = section;
        let name_len = leb128(&mut section)? as usize;
        if section.get(..name_len)? != b"contractenvmetav0" {
            continue;
        }
        // Only kind 0 exists so far; another kind has an unknown length.
        let entry = section.get(name_len..name_len + 12)?;
        return (entry[..4] == [0, 0, 0, 0]).then(|| u32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]]));
    }
    None
}

fn leb128(bytes: &mut &[u8]) -> Option<u32> {
    let mut value = 0u32;
    for shift in (0..35).step_by(7) {
        let (&b, rest) = bytes.split_first()?;
        *bytes = rest;
        value |= u32::from(b & 0x7f).checked_shl(shift)?;
        if b & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exact(what: &str, protocol: u32) -> Evidence {
        Evidence::Exact { what: what.into(), protocol }
    }

    fn at_least(needs: &[(&str, u32)]) -> Evidence {
        Evidence::AtLeast(needs.iter().map(|(w, p)| (w.to_string(), *p)).collect())
    }

    /// A minimal module with one custom section.
    fn wasm_with(name: &str, payload: &[u8]) -> Vec<u8> {
        let mut section = vec![name.len() as u8];
        section.extend_from_slice(name.as_bytes());
        section.extend_from_slice(payload);
        let mut wasm = b"\0asm\x01\0\0\0".to_vec();
        wasm.push(0);
        wasm.push(section.len() as u8);
        wasm.extend(section);
        wasm
    }

    fn env_meta(protocol: u32, pre_release: u32) -> Vec<u8> {
        [0u32, protocol, pre_release].iter().flat_map(|w| w.to_be_bytes()).collect()
    }

    #[test]
    fn a_forked_network_gets_its_own_protocol() {
        assert_eq!(select(None, exact("testnet", 30)).unwrap(), Host::P30);
        assert_eq!(select(None, exact("mainnet", 29)).unwrap(), Host::P29);
    }

    #[test]
    fn offline_the_oldest_host_that_runs_every_input() {
        assert_eq!(select(None, at_least(&[("contract a.wasm", 30)])).unwrap(), Host::P30);
        assert_eq!(select(None, at_least(&[("contract a.wasm", 22)])).unwrap(), Host::P29);
        assert_eq!(select(None, at_least(&[("snapshot s.json", 29), ("contract a.wasm", 30)])).unwrap(), Host::P30);
        assert_eq!(select(None, at_least(&[("snapshot s.json", 30), ("contract a.wasm", 22)])).unwrap(), Host::P30);
        assert_eq!(select(None, at_least(&[])).unwrap(), Host::P29);
    }

    #[test]
    fn protocol_flag_beats_the_network_and_the_contracts() {
        assert_eq!(select(Some(29), exact("testnet", 30)).unwrap(), Host::P29);
        assert_eq!(select(Some(30), exact("mainnet", 29)).unwrap(), Host::P30);
        assert_eq!(select(Some(29), at_least(&[("contract a.wasm", 30)])).unwrap(), Host::P29);
        // Even a network on a protocol this build lacks.
        assert_eq!(select(Some(30), exact("futurenet", 31)).unwrap(), Host::P30);
    }

    #[test]
    fn an_unsupported_protocol_says_which_are() {
        let err = |p, e| select(p, e).unwrap_err().to_string();
        assert_eq!(err(None, exact("testnet", 31)), "testnet is on protocol 31, this build supports 29, 30");
        assert_eq!(err(None, exact("mainnet", 28)), "mainnet is on protocol 28, this build supports 29, 30");
        assert_eq!(err(None, at_least(&[("contract a.wasm", 31)])), "contract a.wasm is on protocol 31, this build supports 29, 30");
        assert_eq!(err(Some(28), exact("mainnet", 29)), "--protocol 28: this build supports 29, 30");
    }

    #[test]
    fn reads_the_contract_env_meta() {
        assert_eq!(contract_protocol(&wasm_with("contractenvmetav0", &env_meta(30, 0))), Some(30));
        assert_eq!(contract_protocol(&wasm_with("contractenvmetav0", &env_meta(22, 0))), Some(22));
        assert_eq!(contract_protocol(&wasm_with("contractmetav0", &env_meta(30, 0))), None);
        assert_eq!(contract_protocol(b"not wasm"), None);
        // A real contract (built with an SDK, so it carries one).
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/contracts/add_i32.wasm")).unwrap();
        assert!(contract_protocol(&bytes).is_some_and(|p| p >= 20), "{:?}", contract_protocol(&bytes));
    }
}
