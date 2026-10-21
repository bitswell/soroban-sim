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
    // 33 dependent transactions apply; the replay, the non-signer envelope
    // and the admin's key alone are rejected, and the expired ci-publish rule
    // fails at apply.
    assert_eq!((report.fees.applied, report.fees.rejected, report.fees.failed), (33, 3, 1));
    // Every override is in the report: only the root manager's key and top-up.
    assert_eq!(report.overrides.len(), 2);
    assert!(report.overrides.iter().all(|o| o.entry == "GAMPJROHOAW662FINQ4XQOY2ULX5IEGYXCI4SMZYE75EHQBR6PSTJG3M"), "{:#?}", report.overrides);
    assert!(report.safety.replayable.is_empty());

    // The admin's and the CI delegate's accounts were created by a real
    // CreateAccount transaction, and the admin's co-signer by SetOptions.
    let key = |name: &str| soroban_sim_core::session::Ed25519Key::throwaway(name).strkey();
    for (name, xlm) in [("author-admin", 10), ("ci-delegate", 5)] {
        let a = report.accounts.iter().find(|a| a.account == key(name)).unwrap_or_else(|| panic!("{name} in the report"));
        assert!(!a.overridden && a.balance_before.is_none(), "{name}: {a:?}");
        assert!(a.balance_after.unwrap() < xlm * 10_000_000, "{name} paid its own fees");
    }
    let admin = report.accounts.iter().find(|a| a.account == key("author-admin")).unwrap();
    assert!(admin.changes.iter().any(|c| c == &format!("signer {} added (weight 1)", key("author-admin-backup"))), "{:?}", admin.changes);
    let step = |name: &str| report.steps.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("no step {name}"));
    let (cosign, perch) = (step("accounts: the admin account adds a backup co-signer (thresholds 1/2/2)"), step("create-registry perch: root.deploy(registry)"));
    assert_eq!(cosign.ledger, perch.ledger, "one ledger for both");
    assert_eq!((cosign.tx.as_ref().unwrap().application_order, perch.tx.as_ref().unwrap().application_order), (Some(1), Some(2)), "the classic phase first");
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
