use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use soroban_sim_cli::plan::Plan;
use soroban_sim_cli::run::{base_from_name, Base, RunConfig, Runner};
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

fn run() -> Result<bool> {
    match Cli::parse().command {
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
            let json = prefix.with_extension("json");
            let md = prefix.with_extension("md");
            if json == md {
                bail!("bad report prefix {}", prefix.display());
            }
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
