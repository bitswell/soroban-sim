//! The acceptance scenario on a live mainnet fork. Read-only (the RPC client
//! refuses to send anything), and ignored by default because it needs the
//! network and the release Wasm:
//!
//!   SOROBAN_SIM_BOOTSTRAP_WASM=/path/to/release-wasm \
//!     cargo test -p soroban-sim-cli --test network -- --ignored

use soroban_sim_cli::run::{base_from_name, RunConfig, Runner};
use std::collections::BTreeMap;
use std::path::Path;

#[test]
#[ignore = "reads mainnet RPC and needs SOROBAN_SIM_BOOTSTRAP_WASM"]
fn perch_nido_bootstrap_on_a_mainnet_fork() {
    let wasm = std::env::var("SOROBAN_SIM_BOOTSTRAP_WASM").expect("SOROBAN_SIM_BOOTSTRAP_WASM: a directory with the release Wasm");
    let report = Runner::new(RunConfig {
        plan_path: Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/session/perch-nido-bootstrap.yaml"),
        base: Some(base_from_name("mainnet", None).unwrap()),
        wasm_dirs: vec![wasm.into()],
        differential: true,
        keep_going: false,
        vars: BTreeMap::new(),
        progress: true,
    })
    .unwrap()
    .run(None)
    .unwrap();

    assert!(report.passed, "{:#?}", report.failures);
    // 31 dependent transactions apply; the replay and the non-signer envelope
    // are rejected, and the expired ci-publish rule fails at apply.
    assert_eq!((report.fees.applied, report.fees.rejected, report.fees.failed), (31, 2, 1));
    // Every override is in the report.
    assert_eq!(report.overrides.len(), 4);
    assert!(report.safety.replayable.is_empty());
    // Steps that read only network state simulate the same on RPC.
    let compared: Vec<_> = report.differential.iter().filter(|d| d.status != "skipped").collect();
    assert!(!compared.is_empty());
    for d in compared {
        assert_ne!(d.status, "error", "{}: {}", d.step, d.detail);
        for f in d.fields.iter().filter(|f| f.field != "resource fee") {
            assert!(f.equal, "{}: {} ours {} rpc {}", d.step, f.field, f.ours, f.rpc);
        }
    }
}
