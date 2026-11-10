//! One binary, two hosts: each run gets the host its inputs need. Offline
//! tests build protocol-29 and protocol-30 snapshots and contracts; the live
//! network tests are ignored by default:
//!
//!   cargo test -p soroban-sim-cli --test hosts -- --ignored

use base64::Engine;
use serde_json::{json, Value};
use soroban_env_host::xdr::{LedgerEntry, LedgerEntryData, LedgerEntryExt, Limits, ReadXdr};
use soroban_sim_cli::rpc::RpcClient;
use soroban_sim_cli::run::TESTNET_PASSPHRASE;
use soroban_sim_cli::snapshot::SnapshotFile;
use soroban_sim_core::session::{new_account, Ed25519Key, ForkPoint, StoredEntry};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};

const FORK_LEDGER: u32 = 10_000_000;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("soroban-sim-hosts-test-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn soroban_sim(dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_soroban-sim")).current_dir(dir).args(args).output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The add_i32 fixture contract, its `contractenvmetav0` protocol set to
/// `protocol`.
fn contract_for(dir: &Path, protocol: u32) -> String {
    let mut wasm = std::fs::read(repo().join("fixtures/contracts/add_i32.wasm")).unwrap();
    let at = wasm.windows(17).position(|w| w == b"contractenvmetav0").unwrap() + 17;
    assert_eq!(wasm[at..at + 4], [0, 0, 0, 0], "an interface-version entry");
    wasm[at + 4..at + 8].copy_from_slice(&protocol.to_be_bytes());
    let name = format!("add_p{protocol}.wasm");
    std::fs::write(dir.join(&name), wasm).unwrap();
    name
}

/// A snapshot at `protocol` with testnet's network config and one funded
/// account (the plan's source; the plan substitutes its master key).
fn snapshot_at(dir: &Path, protocol: u32) -> String {
    let raw = std::fs::read_to_string(repo().join("fixtures/parity/native-sac-transfer.json")).unwrap();
    let json: Value = serde_json::from_str(&raw).unwrap();
    let mut entries: Vec<StoredEntry> = json["snapshot"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| {
            let bytes = base64::engine::general_purpose::STANDARD.decode(e["entryXdr"].as_str()?).ok()?;
            let entry = LedgerEntry::from_xdr(bytes, Limits::none()).ok()?;
            matches!(entry.data, LedgerEntryData::ConfigSetting(_)).then_some(StoredEntry { entry, live_until: None })
        })
        .collect();
    entries.push(StoredEntry {
        entry: LedgerEntry {
            last_modified_ledger_seq: FORK_LEDGER - 50,
            data: LedgerEntryData::Account(new_account(owner().account_id(), 500 * 10_000_000, FORK_LEDGER - 50)),
            ext: LedgerEntryExt::V0,
        },
        live_until: None,
    });
    let fork = ForkPoint { ledger_seq: FORK_LEDGER, close_time: 1_800_000_000, protocol_version: protocol, base_reserve: 5_000_000, base_fee: 100 };
    let name = format!("p{protocol}.snapshot.json");
    SnapshotFile::new(TESTNET_PASSPHRASE, &fork, &entries).unwrap().save(&dir.join(&name)).unwrap();
    name
}

fn owner() -> Ed25519Key {
    Ed25519Key::throwaway("snapshot owner")
}

/// Upload `contract`, deploy it and call `add(40, 2)`.
fn add_plan(dir: &Path, contract: &str) -> String {
    let plan = format!(
        r#"
options: {{ source: "{owner}" }}
keys: {{ owner: ed25519 }}
signers: {{ "{owner}": {{ classic: [owner] }} }}
vars:
  add: {{ contract_id: {{ deployer: "{owner}", salt: {{ sha256: add }} }} }}
setup:
  - substitute_master_key: {{ account: "{owner}", key: owner }}
steps:
  - name: upload
    upload: {{ file: {contract} }}
    save: code
  - name: deploy
    deploy: {{ deployer: "{owner}", salt: {{ sha256: add }}, wasm_hash: "${{code}}" }}
  - name: add
    invoke: {{ contract: "${{add}}", fn: add, args: [{{ i32: 40 }}, {{ i32: 2 }}] }}
    expect: {{ equals: "42" }}
"#,
        owner = owner().strkey()
    );
    let name = format!("{}.plan.yaml", contract.trim_end_matches(".wasm"));
    std::fs::write(dir.join(&name), plan).unwrap();
    name
}

fn report_host(dir: &Path, plan: &str) -> Value {
    let report = std::fs::read_to_string(dir.join(format!("{}.report.json", plan.trim_end_matches(".yaml")))).unwrap();
    serde_json::from_str::<Value>(&report).unwrap()["host"].clone()
}

#[test]
fn a_protocol_30_contract_runs_offline_on_the_protocol_30_host() {
    let dir = scratch("p30-offline");
    let snapshot = snapshot_at(&dir, 30);
    let plan = add_plan(&dir, &contract_for(&dir, 30));
    let out = soroban_sim(&dir, &["session", "run", &plan, "--snapshot", &snapshot, "--quiet"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(report_host(&dir, &plan), json!({ "protocol_version": 30, "soroban_env_host": "30.0.0" }));

    // The protocol-29 host cannot run that ledger.
    let out = soroban_sim(&dir, &["session", "run", &plan, "--snapshot", &snapshot, "--quiet", "--protocol", "29"]);
    assert!(!out.status.success());
}

#[test]
fn a_protocol_29_snapshot_runs_on_the_protocol_29_host() {
    let dir = scratch("p29-offline");
    let snapshot = snapshot_at(&dir, 29);
    std::fs::copy(repo().join("fixtures/contracts/add_i32.wasm"), dir.join("add_i32.wasm")).unwrap();
    let plan = add_plan(&dir, "add_i32.wasm");
    let out = soroban_sim(&dir, &["session", "run", &plan, "--snapshot", &snapshot, "--quiet"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(report_host(&dir, &plan), json!({ "protocol_version": 29, "soroban_env_host": "29.0.2" }));
}

#[test]
fn without_a_ledger_the_contracts_pick_the_host() {
    let dir = scratch("check");
    let check = |plan: &str, extra: &[&str]| {
        let out = soroban_sim(&dir, &[&["session", "check", plan][..], extra].concat());
        (out.status.code(), text(&out.stdout), text(&out.stderr))
    };
    let p30 = add_plan(&dir, &contract_for(&dir, 30));
    let p22 = add_plan(&dir, &contract_for(&dir, 22));
    let p31 = add_plan(&dir, &contract_for(&dir, 31));
    assert!(check(&p30, &[]).1.contains("(protocol 30 host)"));
    assert!(check(&p22, &[]).1.contains("(protocol 29 host)"));
    // --protocol beats the contracts.
    assert!(check(&p30, &["--protocol", "29"]).1.contains("(protocol 29 host)"));
    assert!(check(&p31, &["--protocol", "30"]).1.contains("(protocol 30 host)"));
    assert_eq!(check(&p31, &[]).2, "error: contract add_p31.wasm is on protocol 31, this build supports 29, 30\n");
    assert_eq!(check(&p30, &["--protocol", "28"]).2, "error: --protocol 28: this build supports 29, 30\n");
    assert_eq!(check(&p30, &["--protocol", "28"]).0, Some(2));
}

/// A canned `getLatestLedger` answer on a local port.
fn fake_rpc(latest: Value) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}", server.server_addr().to_ip().unwrap());
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let body = json!({ "jsonrpc": "2.0", "id": 1, "result": latest }).to_string();
            let _ = request.respond(tiny_http::Response::from_string(body));
        }
    });
    url
}

#[test]
fn a_network_on_another_protocol_is_refused_before_its_header_is_decoded() {
    // Protocol 30's header has a StellarValue ext arm this host's XDR lacks.
    let url = fake_rpc(json!({ "sequence": 7, "protocolVersion": 30, "headerXdr": "not a header" }));
    let err = format!("{:#}", RpcClient::new(&url).latest_ledger().err().unwrap());
    assert_eq!(err, format!("{url} is on protocol 30, this build's host implements protocol 29"));
    assert_eq!(RpcClient::new(&url).protocol_version().unwrap(), 30);

    let url = fake_rpc(json!({ "sequence": 7, "protocolVersion": 29, "headerXdr": "AAAA" }));
    let err = format!("{:#}", RpcClient::new(&url).latest_ledger().err().unwrap());
    assert!(err.starts_with("getLatestLedger: decoding ledger 7's headerXdr (protocol 29): "), "{err}");
}

/// `serve` until its banner, then the facade's URL and the banner.
struct Serve(Child);

impl Serve {
    fn start(dir: &Path, args: &[&str]) -> (Self, String, String) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_soroban-sim"))
            .current_dir(dir)
            .args([&["serve", "--port", "0", "--quiet"][..], args].concat())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
        let mut seen = String::new();
        let banner = loop {
            let line = lines.next().unwrap_or_else(|| panic!("serve exited: {seen}")).unwrap();
            seen += &line;
            if line.contains("RPC facade on ") {
                break line;
            }
        };
        // Keep reading: serve writes more lines, and a closed pipe would end it.
        std::thread::spawn(move || lines.for_each(drop));
        let url = banner.split("RPC facade on ").nth(1).unwrap().split(':').take(3).collect::<Vec<_>>().join(":");
        (Serve(child), url, banner)
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn rpc(url: &str, method: &str) -> Value {
    let r: Value = ureq::post(url).send_json(json!({ "jsonrpc": "2.0", "id": 1, "method": method })).unwrap().into_json().unwrap();
    r["result"].clone()
}

fn serves(dir: &Path, args: &[&str], protocol: u32, host: &str) {
    let (_serve, url, banner) = Serve::start(dir, args);
    assert!(banner.ends_with(&format!("(protocol {protocol})")), "{banner}");
    assert_eq!(rpc(&url, "getLatestLedger")["protocolVersion"], protocol);
    let version = rpc(&url, "getVersionInfo");
    assert_eq!(version["protocolVersion"], protocol);
    assert_eq!(version["captiveCoreVersion"], format!("none: soroban-env-host {host} in soroban-sim"));
}

#[test]
fn serve_forks_a_snapshot_with_its_protocols_host() {
    let dir = scratch("serve-snapshot");
    serves(&dir, &["--snapshot", &snapshot_at(&dir, 30)], 30, "30.0.0");
    serves(&dir, &["--snapshot", &snapshot_at(&dir, 29)], 29, "29.0.2");
}

#[test]
#[ignore = "reads testnet RPC"]
fn serve_forks_testnet_on_the_protocol_30_host() {
    serves(&scratch("serve-testnet"), &["--fork", "testnet"], 30, "30.0.0");
}

#[test]
#[ignore = "reads mainnet RPC"]
fn serve_forks_mainnet_on_the_protocol_29_host() {
    serves(&scratch("serve-mainnet"), &["--fork", "mainnet"], 29, "29.0.2");
}
