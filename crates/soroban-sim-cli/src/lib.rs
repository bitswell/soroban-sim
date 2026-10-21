//! `soroban-sim session`: rehearse a multi-transaction, multi-signer Soroban
//! setup on a fork of a real network, from a plan file, and report on it.
//! Nothing is ever submitted to the network.

pub mod differential;
pub mod plan;
pub mod rpc;
pub mod run;
pub mod snapshot;

/// The session report, shared with the RPC facade and the browser session.
pub use soroban_sim_facade::report;
/// The soroban-env-host release this build links (see the workspace pin).
pub use soroban_sim_facade::ENV_HOST_VERSION;
