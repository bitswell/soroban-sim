//! Snapshot files (see [`soroban_sim_facade::snapshot`] for both versions of
//! the format), and capturing a network's settings as one.

use anyhow::{bail, Result};
use soroban_env_host::xdr::{ConfigSettingId, LedgerKey, LedgerKeyConfigSetting};

pub use soroban_sim_facade::snapshot::*;

use crate::rpc::RpcClient;

/// A self-contained snapshot of `rpc`'s latest ledger holding only the
/// network's settings (every `ConfigSetting` entry) and its header: the
/// network's configuration, passphrase and protocol over an otherwise empty
/// ledger. Reads nothing else and runs nothing against the network.
pub fn capture(rpc: &RpcClient, passphrase: Option<&str>) -> Result<SnapshotFile> {
    let actual = rpc.network_passphrase()?;
    if let Some(p) = passphrase {
        if p != actual {
            bail!("{} serves {actual:?}, not {p:?}", rpc.url);
        }
    }
    let latest = rpc.latest_ledger()?;
    let keys: Vec<LedgerKey> =
        ConfigSettingId::VARIANTS.iter().map(|id| LedgerKey::ConfigSetting(LedgerKeyConfigSetting { config_setting_id: *id })).collect();
    let mut entries = vec![];
    for chunk in keys.chunks(200) {
        entries.extend(rpc.ledger_entries(chunk)?.entries);
    }
    SnapshotFile::minimal(&actual, &latest.header, &entries)
}
