wit_bindgen::generate!({
    path: "../../wit",
    world: "simulator",
});

use soroban_env_host::xdr::{
    AccountId, HostFunction, LedgerEntry as XdrLedgerEntry, Limits, ReadXdr,
};
use soroban_env_host::LedgerInfo;
use soroban_sim_core::{
    fixture_network_config, simulate, LedgerEntryWithLiveUntil, SimulationRequest,
};

struct Component;

impl Guest for Component {
    fn run_fixture() -> Result<Vec<u8>, String> {
        soroban_sim_core::run_fixture().map_err(|e| e.to_string())
    }

    fn simulate(request: Request) -> Result<Outcome, String> {
        simulate_request(request)
            .map(Outcome::Complete)
            .map_err(|e| e.to_string())
    }
}

fn simulate_request(request: Request) -> anyhow::Result<Vec<u8>> {
    let host_function = HostFunction::from_xdr(request.host_function_xdr, Limits::none())?;
    let source_account = AccountId::from_xdr(request.source_account_xdr, Limits::none())?;
    let ledger_info = ledger_info_from_wit(request.ledger_context)?;
    let base_prng_seed = fixed_32(request.base_prng_seed, "base-prng-seed")?;
    let ledger_entries = request
        .ledger_entries
        .into_iter()
        .map(ledger_entry_from_wit)
        .collect::<anyhow::Result<Vec<_>>>()?;

    simulate(SimulationRequest {
        host_function,
        source_account,
        ledger_info,
        // Milestone 0 keeps fee/cost model deterministic and local. Full network
        // config encoding is tracked for the next interface revision.
        network_config: fixture_network_config(),
        ledger_entries,
        base_prng_seed,
        enable_diagnostics: request.enable_diagnostics,
    })
}

fn ledger_info_from_wit(context: LedgerContext) -> anyhow::Result<LedgerInfo> {
    Ok(LedgerInfo {
        protocol_version: context.protocol_version,
        sequence_number: context.sequence_number,
        timestamp: context.timestamp,
        network_id: fixed_32(context.network_id, "network-id")?,
        base_reserve: context.base_reserve,
        min_temp_entry_ttl: context.min_temp_entry_ttl,
        min_persistent_entry_ttl: context.min_persistent_entry_ttl,
        max_entry_ttl: context.max_entry_ttl,
    })
}

fn ledger_entry_from_wit(entry: LedgerEntry) -> anyhow::Result<LedgerEntryWithLiveUntil> {
    Ok(LedgerEntryWithLiveUntil {
        entry: XdrLedgerEntry::from_xdr(entry.entry_xdr, Limits::none())?,
        live_until_ledger: entry.live_until_ledger,
    })
}

fn fixed_32(bytes: Vec<u8>, name: &str) -> anyhow::Result<[u8; 32]> {
    bytes
        .try_into()
        .map_err(|v: Vec<u8>| anyhow::anyhow!("{name} must be 32 bytes, got {}", v.len()))
}

export!(Component);

#[cfg(test)]
mod tests {
    #[test]
    fn component_fixture_matches_core_fixture() {
        let direct = soroban_sim_core::run_fixture().unwrap();
        let again = soroban_sim_core::run_fixture().unwrap();
        assert_eq!(direct, again);
    }
}
