//! The reactor against the captured Perch fixture (`fixtures/perch-capture.json`,
//! a native soroban-sim run of the pinned Perch contracts on a standalone
//! fork): the stub-signed enforcing preview must reach the verdicts the
//! real-key run reached, and the recording must find the transaction's own
//! authorizations only.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use soroban_sim_preview::xdr::{Limits, ReadXdr, SorobanAuthorizationEntry, SorobanCredentials};
use soroban_sim_preview::*;

fn capture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/perch-capture.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn strkey_payload(s: &str) -> [u8; 32] {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let (mut bits, mut n, mut out) = (0u64, 0, vec![]);
    for c in s.bytes() {
        bits = (bits << 5) | A.iter().position(|&a| a == c).unwrap() as u64;
        n += 5;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
            bits &= (1 << n) - 1;
        }
    }
    out[1..33].try_into().unwrap()
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

struct Reply<'a>(&'a [u8]);

impl<'a> Reply<'a> {
    fn u8(&mut self) -> u8 {
        let x = self.0[0];
        self.0 = &self.0[1..];
        x
    }
    fn u32(&mut self) -> u32 {
        let x = u32::from_le_bytes(self.0[..4].try_into().unwrap());
        self.0 = &self.0[4..];
        x
    }
    fn blob(&mut self) -> &'a [u8] {
        let n = self.u32() as usize;
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        a
    }
}

/// A recorded entry with its nonce zeroed: recording draws the nonce from
/// the run's seed, which differs from the capture's.
fn without_nonce(xdr: &[u8]) -> SorobanAuthorizationEntry {
    let mut entry = SorobanAuthorizationEntry::from_xdr(xdr, Limits::none()).unwrap();
    if let SorobanCredentials::Address(c) = &mut entry.credentials {
        c.nonce = 0;
    }
    entry
}

/// Contract error codes, each with the contract that raised it.
fn codes(r: &mut Reply<'_>) -> Vec<(Option<[u8; 32]>, u32)> {
    (0..r.u32())
        .map(|_| {
            let id = r.blob();
            (id.try_into().ok(), r.u32())
        })
        .collect()
}

fn put_blob(v: &mut Vec<u8>, b: &[u8]) {
    v.extend_from_slice(&(b.len() as u32).to_le_bytes());
    v.extend_from_slice(b);
}

/// Run until complete. The fixture is the whole ledger, so every key it lacks
/// is absent: provide it as such and rerun, as the engine does with RPC.
fn run_loop(req: &[u8]) -> Vec<u8> {
    for _ in 0..20 {
        let out = call(req);
        if out[0] != ST_NEEDS_STATE {
            return out;
        }
        let mut r = Reply(&out[1..]);
        let keys: Vec<Vec<u8>> = (0..r.u32()).map(|_| r.blob().to_vec()).collect();
        let mut p = vec![OP_PROVIDE];
        p.extend_from_slice(&0u32.to_le_bytes());
        p.extend_from_slice(&(keys.len() as u32).to_le_bytes());
        for k in &keys {
            put_blob(&mut p, k);
        }
        assert_eq!(call(&p), vec![ST_COMPLETE]);
    }
    panic!("needs-state did not converge");
}

fn provide_ledger(cap: &Value) {
    assert_eq!(call(&[OP_RESET]), vec![ST_COMPLETE]);
    let ledger = cap["ledger"].as_array().unwrap();
    let mut req = vec![OP_PROVIDE];
    req.extend_from_slice(&(ledger.len() as u32).to_le_bytes());
    for e in ledger {
        put_blob(&mut req, &B64.decode(e["entry"].as_str().unwrap()).unwrap());
        let live = e["liveUntil"].as_u64().map(|l| l as u32 + 1).unwrap_or(0);
        req.extend_from_slice(&live.to_le_bytes());
    }
    req.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(call(&req), vec![ST_COMPLETE]);
}

fn run_header(cap: &Value, protocol: u32, envelope: &[u8], mode: u8) -> Vec<u8> {
    let net = &cap["network"];
    let nid: [u8; 32] = Sha256::digest(net["passphrase"].as_str().unwrap().as_bytes()).into();
    let mut r = vec![OP_RUN];
    r.extend_from_slice(&protocol.to_le_bytes());
    r.extend_from_slice(&(net["sequence"].as_u64().unwrap() as u32).to_le_bytes());
    r.extend_from_slice(&net["timestamp"].as_u64().unwrap().to_le_bytes());
    r.extend_from_slice(&nid);
    r.extend_from_slice(&(net["baseReserve"].as_u64().unwrap() as u32).to_le_bytes());
    put_blob(&mut r, envelope);
    r.push(mode);
    r
}

/// The fixture was captured on protocol 29. Its ledger has no entry that
/// protocol 30 changed the shape of, so a protocol-30 build runs it as if
/// the network had upgraded at the captured ledger.
#[test]
fn perch_fixture_verdicts() {
    let cap = capture();
    provide_ledger(&cap);
    let a = &cap["addresses"];
    let account = strkey_payload(a["account"].as_str().unwrap());
    let verifier = strkey_payload(a["verifier"].as_str().unwrap());
    let app_key = hex_decode(a["appKey"].as_str().unwrap());

    for s in cap["scenarios"].as_array().unwrap() {
        let id = s["id"].as_str().unwrap();
        let env = B64.decode(s["envelope"].as_str().unwrap()).unwrap();

        // Recording: the authorizations the transaction itself needs.
        let out = run_loop(&run_header(&cap, host_protocol(), &env, MODE_RECORD));
        let mut r = Reply(&out);
        assert_eq!(
            r.u8(),
            ST_COMPLETE,
            "{id}: record {:?}",
            String::from_utf8_lossy(&out)
        );
        assert_eq!(r.u8(), 1, "{id}: the recording run fails");
        r.blob();
        codes(&mut r);
        let recorded: Vec<_> = (0..r.u32()).map(|_| without_nonce(r.blob())).collect();
        let expected: Vec<_> = s["preview"]["recordedAuth"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| without_nonce(&B64.decode(v.as_str().unwrap()).unwrap()))
            .collect();
        assert_eq!(recorded, expected, "{id}: recorded tree");
        let supplied = s["preview"]["suppliedAuth"].as_array().unwrap().len();
        if id == "unused-entry" {
            assert_eq!(
                (supplied, recorded.len()),
                (2, 1),
                "{id}: the unused entry is not recorded"
            );
        } else {
            assert_eq!(supplied, recorded.len(), "{id}");
        }

        // Enforcing, with the stub verifier and the grant's rule id.
        let mut q = run_header(&cap, host_protocol(), &env, MODE_ENFORCE);
        q.extend_from_slice(&1u32.to_le_bytes());
        q.extend_from_slice(&verifier);
        q.extend_from_slice(&1u32.to_le_bytes());
        q.extend_from_slice(&account);
        q.extend_from_slice(&1u32.to_le_bytes());
        q.extend_from_slice(&1u32.to_le_bytes());
        q.extend_from_slice(&(a["spendRuleId"].as_u64().unwrap() as u32).to_le_bytes());
        q.extend_from_slice(&1u32.to_le_bytes());
        q.extend_from_slice(&verifier);
        put_blob(&mut q, &app_key);
        let out = run_loop(&q);
        let mut r = Reply(&out);
        assert_eq!(
            r.u8(),
            ST_COMPLETE,
            "{id}: enforce {:?}",
            String::from_utf8_lossy(&out)
        );
        let ok = r.u8() == 1;
        let detail = String::from_utf8_lossy(r.blob()).to_string();
        let codes = codes(&mut r);
        let expected_ok = s["preview"]["result"]["ok"].as_bool().unwrap();
        assert_eq!(ok, expected_ok, "{id}: {detail} {codes:?}");
        // Perch refuses an over-cap spend with PerchAuthError::RuleEvalRefused,
        // raised in the account's own frame.
        if !ok {
            assert!(codes.contains(&(Some(account), 5)), "{id}: {codes:?}");
        }
    }
}

#[test]
fn refuses_another_protocol() {
    let cap = capture();
    provide_ledger(&cap);
    let env = B64
        .decode(cap["scenarios"][0]["envelope"].as_str().unwrap())
        .unwrap();
    let out = call(&run_header(&cap, host_protocol() + 1, &env, MODE_RECORD));
    let mut r = Reply(&out);
    assert_eq!(r.u8(), ST_ERROR);
    let message = String::from_utf8_lossy(r.blob()).to_string();
    assert!(
        message.contains(&format!("implements protocol {}", host_protocol())),
        "{message}"
    );
}

#[test]
fn reports_unknown_keys() {
    assert_eq!(call(&[OP_RESET]), vec![ST_COMPLETE]);
    let cap = capture();
    let env = B64
        .decode(cap["scenarios"][0]["envelope"].as_str().unwrap())
        .unwrap();
    let out = call(&run_header(&cap, host_protocol(), &env, MODE_RECORD));
    let mut r = Reply(&out);
    assert_eq!(r.u8(), ST_NEEDS_STATE);
    assert!(
        r.u32() > 0,
        "an empty store needs at least the network config"
    );
}

#[test]
fn rejects_garbage() {
    let out = call(&[OP_RUN, 1, 2]);
    assert_eq!(out[0], ST_ERROR);
    let out = call(&[99]);
    assert_eq!(out[0], ST_ERROR);
}

fn strkey(version: u8, payload: &[u8; 32]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut data = vec![version];
    data.extend_from_slice(payload);
    let mut crc: u16 = 0;
    for b in &data {
        crc ^= (*b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    data.extend_from_slice(&crc.to_le_bytes());
    let (mut bits, mut n, mut out) = (0u64, 0, String::new());
    for b in data {
        bits = (bits << 8) | b as u64;
        n += 8;
        while n >= 5 {
            n -= 5;
            out.push(A[((bits >> n) & 31) as usize] as char);
        }
    }
    out
}

fn multi_party() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/multi-party.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Both fixtures' ledgers, then a run in `mode` (enforce: the multi-party
/// account hinted, its verifier stubbed).
fn run_multi_party(cap: &Value, mp: &Value, mode: u8) -> Vec<u8> {
    provide_ledger(cap);
    let extra = mp["ledger"].as_array().unwrap();
    let mut req = vec![OP_PROVIDE];
    req.extend_from_slice(&(extra.len() as u32).to_le_bytes());
    for e in extra {
        put_blob(&mut req, &B64.decode(e["entry"].as_str().unwrap()).unwrap());
        req.extend_from_slice(&(e["liveUntil"].as_u64().unwrap() as u32 + 1).to_le_bytes());
    }
    req.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(call(&req), vec![ST_COMPLETE]);
    let a = &mp["addresses"];
    let verifier = strkey_payload(a["verifier"].as_str().unwrap());
    let env = B64.decode(mp["envelope"].as_str().unwrap()).unwrap();
    let mut q = run_header(cap, host_protocol(), &env, mode);
    if mode == MODE_ENFORCE {
        q.extend_from_slice(&1u32.to_le_bytes());
        q.extend_from_slice(&verifier);
        q.extend_from_slice(&1u32.to_le_bytes());
        q.extend_from_slice(&strkey_payload(a["account"].as_str().unwrap()));
        q.extend_from_slice(&1u32.to_le_bytes());
        q.extend_from_slice(&1u32.to_le_bytes());
        q.extend_from_slice(&0u32.to_le_bytes());
        q.extend_from_slice(&1u32.to_le_bytes());
        q.extend_from_slice(&verifier);
        put_blob(&mut q, &hex_decode(a["key"].as_str().unwrap()));
    }
    run_loop(&q)
}

/// The multi-party fixture: the hinted account's policy accepts, but the
/// other party has not signed. The enforcing run fails on that missing
/// signature, with no contract error from the account, while the recording
/// succeeds.
#[test]
fn multi_party_fails_on_the_other_signer_only() {
    let (cap, mp) = (capture(), multi_party());
    let account = strkey_payload(mp["addresses"]["account"].as_str().unwrap());

    let out = run_multi_party(&cap, &mp, MODE_RECORD);
    let mut r = Reply(&out);
    assert_eq!(
        r.u8(),
        ST_COMPLETE,
        "record {:?}",
        String::from_utf8_lossy(&out)
    );
    assert_eq!(
        r.u8(),
        1,
        "the recording run fails: {}",
        String::from_utf8_lossy(r.blob())
    );
    r.blob();
    codes(&mut r);
    assert_eq!(r.u32(), 2, "the recording needs both parties");

    let out = run_multi_party(&cap, &mp, MODE_ENFORCE);
    let mut r = Reply(&out);
    assert_eq!(
        r.u8(),
        ST_COMPLETE,
        "enforce {:?}",
        String::from_utf8_lossy(&out)
    );
    assert_eq!(
        r.u8(),
        0,
        "the other party's missing signature fails the enforcing run"
    );
    r.blob();
    assert!(!codes(&mut r).iter().any(|(c, _)| *c == Some(account)));
}

/// Writes `fixtures/multi-party.json`: `fixtures/contracts/smart_account.wasm`
/// (rule 0 covers every context; its verifier is the capture's) as the hinted
/// account, and `fixtures/contracts/preview_two_party.wasm`, whose `pay(a, b,
/// token, to, amount)` needs both `a` and `b` at the root and moves `b`'s XLM.
/// `b` is a classic account of the capture holding 10 XLM. The entries are
/// the recording's own, unsigned. Run with `--ignored` after changing either
/// contract.
#[test]
#[ignore]
fn write_multi_party_fixture() {
    use soroban_sim_preview::xdr::*;
    const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let cap = capture();
    let a = &cap["addresses"];
    let seq = cap["network"]["sequence"].as_u64().unwrap() as u32;
    let wasm = |name: &str| std::fs::read(format!("{ROOT}/fixtures/contracts/{name}")).unwrap();
    let id = |s: &str| -> [u8; 32] { Sha256::digest(s.as_bytes()).into() };
    let sym = |s: &str| ScVal::Symbol(s.try_into().unwrap());
    let vec = |v: Vec<ScVal>| ScVal::Vec(Some(v.try_into().unwrap()));
    let contract = |id: [u8; 32]| ScAddress::Contract(ContractId(Hash(id)));
    let account_of = |s: &str| {
        ScAddress::Account(AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(
            strkey_payload(s),
        ))))
    };
    let code = |w: &[u8]| LedgerEntry {
        last_modified_ledger_seq: 0,
        data: LedgerEntryData::ContractCode(ContractCodeEntry {
            ext: ContractCodeEntryExt::V0,
            hash: Hash(Sha256::digest(w).into()),
            code: w.to_vec().try_into().unwrap(),
        }),
        ext: LedgerEntryExt::V0,
    };
    let instance = |id: [u8; 32], w: &[u8], storage: Option<ScMap>| LedgerEntry {
        last_modified_ledger_seq: 0,
        data: LedgerEntryData::ContractData(ContractDataEntry {
            ext: ExtensionPoint::V0,
            contract: contract(id),
            key: ScVal::LedgerKeyContractInstance,
            durability: ContractDataDurability::Persistent,
            val: ScVal::ContractInstance(ScContractInstance {
                executable: ContractExecutable::Wasm(Hash(Sha256::digest(w).into())),
                storage,
            }),
        }),
        ext: LedgerEntryExt::V0,
    };

    let cosigner = "GBVPPZKZBYNEDWZLPUZYZVQNRP3VAMYS4ZPD2AOW54NXAPCF43V4SD25";
    let (account, payee) = (
        id("soroban-sim-preview multi-party account"),
        id("soroban-sim-preview two-party contract"),
    );
    let (smart, two) = (wasm("smart_account.wasm"), wasm("preview_two_party.wasm"));
    let verifier = strkey_payload(a["verifier"].as_str().unwrap());
    let key = hex_decode(a["appKey"].as_str().unwrap());
    let storage = ScMap(
        vec![
            ScMapEntry {
                key: vec(vec![sym("Scheme")]),
                val: ScVal::U32(0),
            },
            ScMapEntry {
                key: vec(vec![sym("Signers")]),
                val: vec(vec![vec(vec![
                    sym("External"),
                    ScVal::Address(contract(verifier)),
                    ScVal::Bytes(key.try_into().unwrap()),
                ])]),
            },
            ScMapEntry {
                key: vec(vec![sym("ValidUntil")]),
                val: ScVal::U32(0),
            },
        ]
        .try_into()
        .unwrap(),
    );
    let ledger = [
        code(&smart),
        instance(account, &smart, Some(storage)),
        code(&two),
        instance(payee, &two, None),
    ];

    let envelope = |auth: Vec<SorobanAuthorizationEntry>| {
        let args = vec![
            ScVal::Address(contract(account)),
            ScVal::Address(account_of(cosigner)),
            ScVal::Address(contract(strkey_payload(a["nativeSac"].as_str().unwrap()))),
            ScVal::Address(account_of(a["shop"].as_str().unwrap())),
            ScVal::I128(Int128Parts {
                hi: 0,
                lo: 10_000_000,
            }),
        ];
        let op = Operation {
            source_account: None,
            body: OperationBody::InvokeHostFunction(InvokeHostFunctionOp {
                host_function: HostFunction::InvokeContract(InvokeContractArgs {
                    contract_address: contract(payee),
                    function_name: "pay".try_into().unwrap(),
                    args: args.try_into().unwrap(),
                }),
                auth: auth.try_into().unwrap(),
            }),
        };
        TransactionEnvelope::Tx(TransactionV1Envelope {
            tx: Transaction {
                source_account: MuxedAccount::Ed25519(Uint256(strkey_payload(
                    a["payer"].as_str().unwrap(),
                ))),
                fee: 1_000_000,
                seq_num: SequenceNumber(1),
                cond: Preconditions::None,
                memo: Memo::None,
                operations: vec![op].try_into().unwrap(),
                ext: TransactionExt::V0,
            },
            signatures: VecM::default(),
        })
        .to_xdr(Limits::none())
        .unwrap()
    };

    let json_ledger: Vec<serde_json::Value> = ledger
        .iter()
        .map(|e| {
            serde_json::json!({
                "key": B64.encode(e.to_key().to_xdr(Limits::none()).unwrap()),
                "entry": B64.encode(e.to_xdr(Limits::none()).unwrap()),
                "liveUntil": seq + 100_000,
            })
        })
        .collect();
    let mut mp = serde_json::json!({
        "notice": "Generated by `cargo test -p soroban-sim-preview --test fixture -- --ignored write_multi_party_fixture`. Entries to add to perch-capture.json's ledger, and an envelope whose two authorization entries are the recording's own, unsigned.",
        "addresses": {
            "account": strkey(2 << 3, &account),
            "contract": strkey(2 << 3, &payee),
            "cosigner": cosigner,
            "shop": a["shop"],
            "verifier": a["verifier"],
            "key": a["appKey"],
        },
        "ledger": json_ledger,
        "envelope": B64.encode(envelope(vec![])),
    });
    let out = run_multi_party(&cap, &mp, MODE_RECORD);
    let mut r = Reply(&out);
    assert_eq!(r.u8(), ST_COMPLETE, "{:?}", String::from_utf8_lossy(&out));
    assert_eq!(r.u8(), 1, "{}", String::from_utf8_lossy(r.blob()));
    r.blob();
    codes(&mut r);
    let auth = (0..r.u32())
        .map(|_| {
            let mut e = SorobanAuthorizationEntry::from_xdr(r.blob(), Limits::none()).unwrap();
            if let SorobanCredentials::Address(c) = &mut e.credentials {
                c.signature_expiration_ledger = seq + 100;
            }
            e
        })
        .collect();
    mp["envelope"] = B64.encode(envelope(auth)).into();
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/multi-party.json");
    std::fs::write(path, serde_json::to_string_pretty(&mp).unwrap() + "\n").unwrap();
}
