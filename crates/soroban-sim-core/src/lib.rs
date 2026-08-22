use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use soroban_env_host::e2e_invoke::RecordingInvocationAuthMode;
use soroban_env_host::fees::{FeeConfiguration, RentFeeConfiguration};
use soroban_env_host::storage::{EntryWithLiveUntil, SnapshotSource};
use soroban_env_host::xdr::{
    AccountId, ContractCodeEntry, ContractCodeEntryExt, ContractCostParamEntry, ContractCostParams,
    ContractCostType, ContractDataDurability, ContractDataEntry, ContractExecutable, ContractId,
    ExtensionPoint, Hash, HostFunction, InvokeContractArgs, LedgerEntry, LedgerEntryData,
    LedgerEntryExt, LedgerKey, LedgerKeyAccount, LedgerKeyConfigSetting, LedgerKeyContractCode,
    LedgerKeyContractData, Limits, PublicKey, ReadXdr, ScAddress, ScContractInstance, ScVal,
    Uint256, VecM, WriteXdr,
};
use soroban_env_host::{meta, HostError, LedgerInfo, DEFAULT_XDR_RW_LIMITS};
use soroban_simulation::simulation::{
    simulate_invoke_host_function_op, InvokeHostFunctionSimulationResult, LedgerEntryDiff,
    SimulationAdjustmentConfig,
};
use soroban_simulation::NetworkConfig;
use std::collections::BTreeMap;
use std::rc::Rc;

pub const FIXTURE_A: i32 = 40;
pub const FIXTURE_B: i32 = 2;
pub const FIXTURE_SUM: i32 = 42;
pub const FIXTURE_CONTRACT_ID: [u8; 32] = [7; 32];
pub const FIXTURE_SOURCE_ACCOUNT: [u8; 32] = [123; 32];
pub const FIXTURE_NETWORK_ID: [u8; 32] = [5; 32];
pub const FIXTURE_PRNG_SEED: [u8; 32] = *b"soroban-sim-milestone-0-seed!!!!";

pub const FIXTURE_CONTRACT_WASM: &[u8] = include_bytes!("../../../fixtures/contracts/add_i32.wasm");

#[derive(Clone, Debug)]
pub struct LedgerEntryWithLiveUntil {
    pub entry: LedgerEntry,
    pub live_until_ledger: Option<u32>,
}

#[derive(Debug)]
pub struct SimulationRequest {
    pub host_function: HostFunction,
    pub source_account: AccountId,
    pub ledger_info: LedgerInfo,
    pub network_config: NetworkConfig,
    pub ledger_entries: Vec<LedgerEntryWithLiveUntil>,
    pub base_prng_seed: [u8; 32],
    pub enable_diagnostics: bool,
}

#[derive(Default)]
pub struct InMemorySnapshotSource {
    map: BTreeMap<Rc<LedgerKey>, EntryWithLiveUntil>,
}

impl InMemorySnapshotSource {
    pub fn from_entries(entries: Vec<LedgerEntryWithLiveUntil>) -> Result<Self> {
        let mut map = BTreeMap::<Rc<LedgerKey>, EntryWithLiveUntil>::new();
        for entry in entries {
            let key = Rc::new(ledger_entry_to_ledger_key(&entry.entry)?);
            map.insert(key, (Rc::new(entry.entry), entry.live_until_ledger));
        }
        Ok(Self { map })
    }
}

impl SnapshotSource for InMemorySnapshotSource {
    fn get(
        &self,
        key: &Rc<LedgerKey>,
    ) -> std::result::Result<Option<EntryWithLiveUntil>, HostError> {
        Ok(self.map.get(key).cloned())
    }
}

pub fn run_fixture() -> Result<Vec<u8>> {
    simulate(fixture_request()?)
}

pub fn simulate(request: SimulationRequest) -> Result<Vec<u8>> {
    let snapshot = Rc::new(InMemorySnapshotSource::from_entries(
        request.ledger_entries,
    )?);
    let result = simulate_invoke_host_function_op(
        snapshot,
        &request.network_config,
        &SimulationAdjustmentConfig::no_adjustments(),
        &request.ledger_info,
        request.host_function,
        RecordingInvocationAuthMode::recording(true, true),
        &request.source_account,
        request.base_prng_seed,
        request.enable_diagnostics,
    )
    .context("soroban-simulation failed")?;
    encode_simulation_result(&result)
}

pub fn fixture_request() -> Result<SimulationRequest> {
    let ledger_info = fixture_ledger_info();
    let live_until = Some(ledger_info.sequence_number + 1_000);
    Ok(SimulationRequest {
        host_function: fixture_host_function()?,
        source_account: account_id(FIXTURE_SOURCE_ACCOUNT),
        ledger_info,
        network_config: fixture_network_config(),
        ledger_entries: vec![
            LedgerEntryWithLiveUntil {
                entry: fixture_contract_code_entry()?,
                live_until_ledger: live_until,
            },
            LedgerEntryWithLiveUntil {
                entry: fixture_contract_instance_entry()?,
                live_until_ledger: live_until,
            },
        ],
        base_prng_seed: FIXTURE_PRNG_SEED,
        enable_diagnostics: true,
    })
}

pub fn fixture_ledger_info() -> LedgerInfo {
    LedgerInfo {
        protocol_version: meta::INTERFACE_VERSION.protocol,
        sequence_number: 1_000_000,
        timestamp: 12_345_678,
        network_id: FIXTURE_NETWORK_ID,
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100_000,
        max_entry_ttl: 10_000_000,
    }
}

pub fn fixture_network_config() -> NetworkConfig {
    let default_entry = ContractCostParamEntry {
        ext: ExtensionPoint::V0,
        const_term: 0,
        linear_term: 0,
    };
    let mut cpu_cost_params = vec![default_entry.clone(); ContractCostType::variants().len()];
    let mut memory_cost_params = vec![default_entry; ContractCostType::variants().len()];
    for i in 0..ContractCostType::variants().len() {
        let v = i as i64;
        cpu_cost_params[i].const_term = (v + 1) * 1000;
        cpu_cost_params[i].linear_term = v << 7;
        memory_cost_params[i].const_term = (v + 1) * 500;
        memory_cost_params[i].linear_term = v << 6;
    }

    let ledger_info = fixture_ledger_info();
    NetworkConfig {
        fee_configuration: FeeConfiguration {
            fee_per_instruction_increment: 10,
            fee_per_disk_read_entry: 20,
            fee_per_write_entry: 30,
            fee_per_disk_read_1kb: 40,
            fee_per_write_1kb: 50,
            fee_per_historical_1kb: 60,
            fee_per_contract_event_1kb: 70,
            fee_per_transaction_size_1kb: 80,
        },
        rent_fee_configuration: RentFeeConfiguration {
            fee_per_rent_1kb: 100,
            fee_per_write_1kb: 50,
            fee_per_write_entry: 30,
            persistent_rent_rate_denominator: 100,
            temporary_rent_rate_denominator: 1000,
        },
        tx_max_instructions: 100_000_000,
        tx_memory_limit: 40_000_000,
        cpu_cost_params: ContractCostParams(
            cpu_cost_params.try_into().expect("cost vector length"),
        ),
        memory_cost_params: ContractCostParams(
            memory_cost_params.try_into().expect("cost vector length"),
        ),
        min_temp_entry_ttl: ledger_info.min_temp_entry_ttl,
        min_persistent_entry_ttl: ledger_info.min_persistent_entry_ttl,
        max_entry_ttl: ledger_info.max_entry_ttl,
    }
}

pub fn fixture_host_function() -> Result<HostFunction> {
    Ok(HostFunction::InvokeContract(InvokeContractArgs {
        contract_address: fixture_contract_address(),
        function_name: b"add".to_vec().try_into()?,
        args: VecM::try_from(vec![ScVal::I32(FIXTURE_A), ScVal::I32(FIXTURE_B)])?,
    }))
}

pub fn fixture_contract_address() -> ScAddress {
    ScAddress::Contract(ContractId(Hash(FIXTURE_CONTRACT_ID)))
}

pub fn fixture_contract_code_entry() -> Result<LedgerEntry> {
    let wasm_hash = wasm_hash(FIXTURE_CONTRACT_WASM);
    Ok(ledger_entry(LedgerEntryData::ContractCode(
        ContractCodeEntry {
            ext: ContractCodeEntryExt::V0,
            hash: Hash(wasm_hash),
            code: FIXTURE_CONTRACT_WASM.try_into()?,
        },
    )))
}

pub fn fixture_contract_instance_entry() -> Result<LedgerEntry> {
    let wasm_hash = wasm_hash(FIXTURE_CONTRACT_WASM);
    Ok(ledger_entry(LedgerEntryData::ContractData(
        ContractDataEntry {
            ext: ExtensionPoint::V0,
            contract: fixture_contract_address(),
            key: ScVal::LedgerKeyContractInstance,
            durability: ContractDataDurability::Persistent,
            val: ScVal::ContractInstance(ScContractInstance {
                executable: ContractExecutable::Wasm(Hash(wasm_hash)),
                storage: None,
            }),
        },
    )))
}

pub fn ledger_entry_to_ledger_key(entry: &LedgerEntry) -> Result<LedgerKey> {
    match &entry.data {
        LedgerEntryData::Account(a) => Ok(LedgerKey::Account(LedgerKeyAccount {
            account_id: a.account_id.clone(),
        })),
        LedgerEntryData::ContractData(cd) => Ok(LedgerKey::ContractData(LedgerKeyContractData {
            contract: cd.contract.clone(),
            key: cd.key.clone(),
            durability: cd.durability,
        })),
        LedgerEntryData::ContractCode(code) => Ok(LedgerKey::ContractCode(LedgerKeyContractCode {
            hash: code.hash.clone(),
        })),
        LedgerEntryData::ConfigSetting(cs) => {
            Ok(LedgerKey::ConfigSetting(LedgerKeyConfigSetting {
                config_setting_id: cs.discriminant(),
            }))
        }
        other => bail!("unsupported fixture ledger entry type: {other:?}"),
    }
}

pub fn account_id(bytes: [u8; 32]) -> AccountId {
    AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(bytes)))
}

pub fn wasm_hash(wasm: &[u8]) -> [u8; 32] {
    Sha256::digest(wasm).into()
}

fn ledger_entry(data: LedgerEntryData) -> LedgerEntry {
    LedgerEntry {
        last_modified_ledger_seq: 0,
        data,
        ext: LedgerEntryExt::V0,
    }
}

fn encode_simulation_result(result: &InvokeHostFunctionSimulationResult) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    out.extend_from_slice(b"SSIM0\0");
    out.extend_from_slice(&result.simulated_instructions.to_be_bytes());
    out.extend_from_slice(&result.simulated_memory.to_be_bytes());

    match &result.invoke_result {
        Ok(sc_val) => {
            out.push(0);
            push_bytes(&mut out, &sc_val.to_xdr(DEFAULT_XDR_RW_LIMITS)?);
        }
        Err(err) => {
            out.push(1);
            push_bytes(&mut out, format!("{err:?}").as_bytes());
        }
    }

    push_xdr_vec(&mut out, &result.auth)?;
    push_xdr_vec(&mut out, &result.contract_events)?;
    push_xdr_vec(&mut out, &result.diagnostic_events)?;
    match &result.transaction_data {
        Some(data) => {
            out.push(1);
            push_bytes(&mut out, &data.to_xdr(DEFAULT_XDR_RW_LIMITS)?);
        }
        None => out.push(0),
    }
    push_ledger_entry_diffs(&mut out, &result.modified_entries)?;
    Ok(out)
}

fn push_xdr_vec<T: WriteXdr>(out: &mut Vec<u8>, values: &[T]) -> Result<()> {
    push_len(out, values.len())?;
    for value in values {
        push_bytes(out, &value.to_xdr(DEFAULT_XDR_RW_LIMITS)?);
    }
    Ok(())
}

fn push_ledger_entry_diffs(out: &mut Vec<u8>, values: &[LedgerEntryDiff]) -> Result<()> {
    push_len(out, values.len())?;
    for diff in values {
        push_optional_entry(out, &diff.state_before)?;
        push_optional_entry(out, &diff.state_after)?;
    }
    Ok(())
}

fn push_optional_entry(out: &mut Vec<u8>, value: &Option<LedgerEntry>) -> Result<()> {
    match value {
        Some(entry) => {
            out.push(1);
            push_bytes(out, &entry.to_xdr(DEFAULT_XDR_RW_LIMITS)?);
        }
        None => out.push(0),
    }
    Ok(())
}

fn push_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn push_len(out: &mut Vec<u8>, len: usize) -> Result<()> {
    let len: u32 = len
        .try_into()
        .map_err(|_| anyhow!("too many encoded result items"))?;
    out.extend_from_slice(&len.to_be_bytes());
    Ok(())
}

pub fn scval_i32_from_xdr(bytes: &[u8]) -> Result<i32> {
    let value = ScVal::from_xdr(bytes, Limits::none())?;
    match value {
        ScVal::I32(v) => Ok(v),
        other => bail!("expected ScVal::I32, got {other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_env_host::xdr::ReadXdr;

    #[test]
    fn fixture_invokes_real_contract_wasm() {
        let output = run_fixture().unwrap();
        assert!(output.starts_with(b"SSIM0\0"));

        let result_xdr = first_result_xdr(&output).unwrap();
        let value = ScVal::from_xdr(result_xdr, Limits::none()).unwrap();
        assert_eq!(value, ScVal::I32(FIXTURE_SUM));
    }

    #[test]
    fn fixture_output_is_deterministic() {
        let first = run_fixture().unwrap();
        let second = run_fixture().unwrap();
        assert_eq!(first, second);
        let digest: [u8; 32] = Sha256::digest(&first).into();
        assert_eq!(digest.len(), 32);
    }

    fn first_result_xdr(output: &[u8]) -> Result<Vec<u8>> {
        let mut offset = b"SSIM0\0".len() + 4 + 4;
        if output.get(offset) != Some(&0) {
            bail!("fixture invoke did not return success");
        }
        offset += 1;
        let len = u32::from_be_bytes(output[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        Ok(output[offset..offset + len].to_vec())
    }
}
