use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use soroban_sim_cli::plan::Plan;
use soroban_sim_cli::replay::{self, ReplayFixture};
use soroban_sim_cli::rpc::RpcClient;
use soroban_sim_cli::run::{base_from_name, Base, RunConfig, Runner};
use soroban_sim_cli::serve::{self, Facade, ServeConfig};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

/// Simulate Soroban transactions locally, against forked network state.
#[derive(Parser)]
#[command(name = "soroban-sim", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Network sessions: many signed transactions over a fork, nothing sent.
    #[command(subcommand)]
    Session(SessionCommand),
    /// Fidelity: replay real network transactions through the session.
    #[command(subcommand)]
    Replay(ReplayCommand),
    /// Serve a Stellar RPC facade over a fork, so stock tools (stellar,
    /// stellar-sdk) and scripts rehearse against it unchanged. Nothing is sent
    /// to the network.
    Serve(ServeArgs),
}

#[derive(Subcommand)]
enum ReplayCommand {
    /// Record a sample of the latest ledgers' Soroban transactions, with the
    /// exact state each applied against, as a fixture (read-only RPC).
    Fetch(FetchArgs),
    /// Replay fixtures offline and write a JSON and a Markdown fidelity report.
    Run(ReplayRunArgs),
}

#[derive(Args)]
struct FetchArgs {
    /// mainnet, testnet, or an RPC URL.
    #[arg(long, default_value = "mainnet")]
    network: String,
    #[arg(long)]
    network_passphrase: Option<String>,
    /// How many of the latest ledgers to sample from (capped at the current
    /// state-size window period).
    #[arg(long, default_value_t = 60)]
    ledgers: u32,
    #[arg(long, default_value_t = 400)]
    max_transactions: usize,
    /// Transactions per (call, outcome, auth kind) group; rare kinds get 4x.
    #[arg(long, default_value_t = 6)]
    per_group: usize,
    /// The fixture to write (gzipped when it ends in .gz).
    #[arg(long)]
    out: PathBuf,
    /// Replay the fixture right away and write PREFIX.json and PREFIX.md.
    #[arg(long)]
    report: Option<PathBuf>,
    #[arg(long, short)]
    quiet: bool,
}

#[derive(Args)]
struct ReplayRunArgs {
    /// Fixture files.
    #[arg(required = true)]
    fixtures: Vec<PathBuf>,
    /// Report path prefix: writes PREFIX.json and PREFIX.md.
    #[arg(long, default_value = "replay.report")]
    report: PathBuf,
    #[arg(long, short)]
    quiet: bool,
}


#[derive(Args)]
struct ServeArgs {
    /// The network to fork: mainnet, testnet, or an RPC URL.
    #[arg(long, conflicts_with = "snapshot", required_unless_present = "snapshot")]
    fork: Option<String>,
    /// The network passphrase, checked against the RPC.
    #[arg(long)]
    network_passphrase: Option<String>,
    /// Fork a snapshot file instead of a live network.
    #[arg(long)]
    snapshot: Option<PathBuf>,
    /// The address to listen on. Anything but loopback exposes the fork and
    /// its fork_* admin methods to the network.
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    /// The port to listen on (0 picks a free one).
    #[arg(long, default_value_t = 8000)]
    port: u16,
    /// Rewrite PREFIX.json and PREFIX.md after every state change.
    #[arg(long, value_name = "PREFIX")]
    report: Option<PathBuf>,
    /// Close-time step between ledgers, in seconds.
    #[arg(long, default_value_t = 5)]
    seconds_per_ledger: u64,
    /// Apply envelopes that a signer the real network already has signed.
    /// On mainnet those are valid there as they stand, so by default the
    /// facade refuses them.
    #[arg(long)]
    allow_real_signers: bool,
    /// Log every call, reads included.
    #[arg(long, short)]
    verbose: bool,
    /// No line per state change on stderr.
    #[arg(long, short, conflicts_with = "verbose")]
    quiet: bool,
}

#[derive(Subcommand)]
enum SessionCommand {
    /// Run a plan on a fork and write a JSON and a Markdown report.
    Run(RunArgs),
    /// Parse and check a plan without touching the network.
    Check { plan: PathBuf },
}

#[derive(Args)]
struct RunArgs {
    /// The plan file (YAML or JSON).
    plan: PathBuf,
    /// The network to fork: mainnet, testnet, or an RPC URL. Default: the plan's.
    #[arg(long, conflicts_with = "snapshot")]
    fork: Option<String>,
    /// The network passphrase, checked against the RPC (needed for a custom URL
    /// only if you want it checked).
    #[arg(long)]
    network_passphrase: Option<String>,
    /// Fork a snapshot file instead of a live network (offline, reproducible).
    #[arg(long)]
    snapshot: Option<PathBuf>,
    /// Save every base entry the run read, as a snapshot file for offline replays.
    #[arg(long)]
    save_snapshot: Option<PathBuf>,
    /// Directories to search for Wasm by hash (file names containing the hash).
    #[arg(long = "wasm-dir")]
    wasm_dirs: Vec<PathBuf>,
    /// Report path prefix: writes PREFIX.json and PREFIX.md. Default: the plan's
    /// file name with `.report`, in the current directory.
    #[arg(long)]
    report: Option<PathBuf>,
    /// Compare each prepared step that reads no session-changed state with
    /// RPC simulateTransaction.
    #[arg(long)]
    differential: bool,
    /// Keep running after a step fails unexpectedly.
    #[arg(long)]
    keep_going: bool,
    /// Set a plan variable: NAME=VALUE (repeatable).
    #[arg(long = "var", value_parser = parse_var)]
    vars: Vec<(String, String)>,
    /// No per-step progress on stderr.
    #[arg(long, short)]
    quiet: bool,
}

fn parse_var(s: &str) -> Result<(String, String), String> {
    s.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).ok_or_else(|| format!("{s:?} is not NAME=VALUE"))
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}

fn replay_report(fixtures: Vec<(PathBuf, ReplayFixture)>, prefix: &std::path::Path, progress: bool) -> Result<bool> {
    let loaded: Vec<ReplayFixture> = fixtures.iter().map(|(_, f)| f.clone()).collect();
    let outcomes = replay::run(&loaded, progress)?;
    let info = fixtures
        .iter()
        .map(|(p, f)| replay::FixtureInfo {
            path: p.display().to_string(),
            source: f.source.clone(),
            ledgers: f.ledgers,
            soroban_transactions_seen: f.soroban_transactions_seen,
            sampled: f.transactions.len(),
        })
        .collect();
    let report = replay::FidelityReport::build(info, &outcomes);
    let json = PathBuf::from(format!("{}.json", prefix.display()));
    let md = PathBuf::from(format!("{}.md", prefix.display()));
    std::fs::write(&json, report.to_json()?).with_context(|| format!("writing {}", json.display()))?;
    std::fs::write(&md, report.to_markdown()).with_context(|| format!("writing {}", md.display()))?;
    eprintln!(
        "{}: {} transactions, {} matched, {} explained, {} unexplained; report {} and {}",
        if report.passed { "passed" } else { "FAILED" },
        report.transactions,
        report.matched,
        report.explained,
        report.unexplained,
        json.display(),
        md.display()
    );
    Ok(report.passed)
}

fn run() -> Result<bool> {
    match Cli::parse().command {
        Command::Replay(ReplayCommand::Fetch(args)) => {
            let Base::Rpc { url, passphrase, .. } = base_from_name(&args.network, args.network_passphrase.clone())? else {
                bail!("replay fetch needs an RPC network");
            };
            let rpc = RpcClient::new(&url);
            let actual = rpc.network_passphrase()?;
            if let Some(p) = &passphrase {
                if *p != actual {
                    bail!("{url} serves {actual:?}, not {p:?}");
                }
            }
            let fixture = replay::fetch(
                &rpc,
                &actual,
                &replay::FetchOptions { ledgers: args.ledgers, max_transactions: args.max_transactions, per_group: args.per_group, progress: !args.quiet },
            )?;
            fixture.save(&args.out)?;
            eprintln!(
                "wrote {}: {} transactions from ledgers {}..={} ({} entries, {} RPC calls)",
                args.out.display(),
                fixture.transactions.len(),
                fixture.ledgers[0],
                fixture.ledgers[1],
                fixture.entries.len(),
                rpc.calls()
            );
            match &args.report {
                Some(prefix) => replay_report(vec![(args.out.clone(), fixture)], prefix, !args.quiet),
                None => Ok(true),
            }
        }
        Command::Replay(ReplayCommand::Run(args)) => {
            let fixtures = args.fixtures.iter().map(|p| Ok((p.clone(), ReplayFixture::load(p)?))).collect::<Result<Vec<_>>>()?;
            replay_report(fixtures, &args.report, !args.quiet)
        }
        Command::Serve(args) => {
            let base = match (&args.fork, &args.snapshot) {
                (Some(f), _) => base_from_name(f, args.network_passphrase.clone())?,
                (None, Some(s)) => Base::Snapshot(s.clone()),
                (None, None) => bail!("pass --fork mainnet|testnet|URL or --snapshot FILE"),
            };
            let (server, addr) = serve::http::bind(&args.host, args.port)?;
            let mut facade = Facade::open(ServeConfig {
                base,
                seconds_per_ledger: Some(args.seconds_per_ledger),
                allow_real_signers: args.allow_real_signers,
                report: args.report.clone(),
                progress: !args.quiet,
                verbose: args.verbose,
            })?;
            let url = format!("http://{addr}");
            facade.set_url(&url);
            let fork = facade.session().fork_point();
            eprintln!("soroban-sim RPC facade on {url}: a fork of {} at ledger {} (protocol {})", facade.network_name(), fork.ledger_seq, fork.protocol_version);
            eprintln!("  point tools at it: STELLAR_RPC_URL={url} STELLAR_NETWORK_PASSPHRASE={:?}", facade.passphrase());
            eprintln!("  nothing is sent to the network; fork_addSigner substitutes throwaway signers, fork_report reports");
            if !addr.ip().is_loopback() {
                eprintln!("warning: {addr} is not loopback: anyone who can reach it can read the fork and call fork_* methods");
            }
            if let Some(p) = &args.report {
                eprintln!("  report: {}.json and {}.md, rewritten after every state change", p.display(), p.display());
            }
            serve::http::serve(&mut facade, &server);
            Ok(true)
        }
        Command::Session(SessionCommand::Check { plan }) => {
            let p = Plan::load(&plan)?;
            println!("{}: {} steps, {} keys, {} vars, {} setup overrides", plan.display(), p.steps.len(), p.keys.len(), p.vars.len(), p.setup.len());
            Ok(true)
        }
        Command::Session(SessionCommand::Run(args)) => {
            let base = match (&args.fork, &args.snapshot) {
                (Some(f), _) => Some(base_from_name(f, args.network_passphrase.clone())?),
                (None, Some(s)) => Some(Base::Snapshot(s.clone())),
                (None, None) => None,
            };
            let prefix = match &args.report {
                Some(p) => p.clone(),
                None => {
                    let stem = args.plan.file_stem().context("plan path has no file name")?.to_string_lossy().to_string();
                    PathBuf::from(format!("{stem}.report"))
                }
            };
            let runner = Runner::new(RunConfig {
                plan_path: args.plan.clone(),
                base,
                wasm_dirs: args.wasm_dirs,
                differential: args.differential,
                keep_going: args.keep_going,
                vars: args.vars.into_iter().collect::<BTreeMap<_, _>>(),
                progress: !args.quiet,
            })?;
            let report = runner.run(args.save_snapshot.as_deref())?;
            let json = PathBuf::from(format!("{}.json", prefix.display()));
            let md = PathBuf::from(format!("{}.md", prefix.display()));
            std::fs::write(&json, report.to_json()?).with_context(|| format!("writing {}", json.display()))?;
            std::fs::write(&md, report.to_markdown()).with_context(|| format!("writing {}", md.display()))?;
            eprintln!(
                "{}: {} transactions ({} applied), {} overrides, {} entries changed; report {} and {}",
                if report.passed { "passed" } else { "FAILED" },
                report.fees.transactions,
                report.fees.applied,
                report.overrides.len(),
                report.diff.total,
                json.display(),
                md.display()
            );
            for f in &report.failures {
                eprintln!("  ✗ {f}");
            }
            Ok(report.passed)
        }
    }
}
