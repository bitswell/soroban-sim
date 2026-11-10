//! The `soroban-sim` binary. It links one engine per host protocol and runs
//! each command with the host [`host::for_cli`] picks.

mod host;

use clap::{CommandFactory, FromArgMatches};
use soroban_sim_cli::cli::Cli;
use std::process::ExitCode;

fn main() -> ExitCode {
    let matches = Cli::command().get_matches();
    let run = || -> anyhow::Result<bool> {
        let cli = Cli::from_arg_matches(&matches)?;
        host::for_cli(&cli)?.run(&matches)
    };
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}
