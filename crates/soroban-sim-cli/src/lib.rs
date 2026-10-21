//! `soroban-sim session`: rehearse a multi-transaction, multi-signer Soroban
//! setup on a fork of a real network, from a plan file, and report on it.
//! Nothing is ever submitted to the network.

pub mod differential;
pub mod meta;
pub mod plan;
pub mod replay;
pub mod report;
pub mod rpc;
pub mod run;
pub mod snapshot;

/// The soroban-env-host release this build links (see the workspace pin).
pub const ENV_HOST_VERSION: &str = "29.0.2";
