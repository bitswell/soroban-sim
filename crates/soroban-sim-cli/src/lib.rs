//! `soroban-sim session`: rehearse a multi-transaction, multi-signer Soroban
//! setup on a fork of a real network, from a plan file, and report on it.
//! `soroban-sim serve`: the same fork behind a Stellar RPC facade, so stock
//! tools and the scripts built on them rehearse unchanged. Nothing is ever
//! submitted to the network.

pub mod classic;
pub mod differential;
pub mod plan;
pub mod report;
pub mod rpc;
pub mod run;
pub mod serve;
pub mod snapshot;

/// The soroban-env-host release this build links (see the workspace pin).
pub const ENV_HOST_VERSION: &str = "29.0.2";
