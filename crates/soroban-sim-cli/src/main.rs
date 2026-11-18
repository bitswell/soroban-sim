//! The `soroban-sim` binary. It links one engine per host protocol and runs
//! each command with the host [`host::for_cli`] picks.

mod host;

use clap::Parser;
use soroban_sim_cli::cli::Cli;
use std::ffi::OsString;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().collect();
    let cli = Cli::parse_from(&args);
    let run = || -> anyhow::Result<bool> { host::for_cli(&cli)?.run(&args) };
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}
