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
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
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
        assert_eq!(r.u8(), ST_COMPLETE, "{id}: record {:?}", String::from_utf8_lossy(&out));
        assert_eq!(r.u8(), 1, "{id}: the recording run fails");
        r.blob();
        for _ in 0..r.u32() {
            r.u32();
        }
        let recorded: Vec<_> = (0..r.u32()).map(|_| without_nonce(r.blob())).collect();
        let expected: Vec<_> = s["preview"]["recordedAuth"].as_array().unwrap().iter().map(|v| without_nonce(&B64.decode(v.as_str().unwrap()).unwrap())).collect();
        assert_eq!(recorded, expected, "{id}: recorded tree");
        let supplied = s["preview"]["suppliedAuth"].as_array().unwrap().len();
        if id == "unused-entry" {
            assert_eq!((supplied, recorded.len()), (2, 1), "{id}: the unused entry is not recorded");
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
        assert_eq!(r.u8(), ST_COMPLETE, "{id}: enforce {:?}", String::from_utf8_lossy(&out));
        let ok = r.u8() == 1;
        let detail = String::from_utf8_lossy(r.blob()).to_string();
        let codes: Vec<u32> = (0..r.u32()).map(|_| r.u32()).collect();
        let expected_ok = s["preview"]["result"]["ok"].as_bool().unwrap();
        assert_eq!(ok, expected_ok, "{id}: {detail} {codes:?}");
        // Perch refuses an over-cap spend with PerchAuthError::RuleEvalRefused.
        if !ok {
            assert_eq!(codes, vec![5], "{id}");
        }
    }
}

#[test]
fn refuses_another_protocol() {
    let cap = capture();
    provide_ledger(&cap);
    let env = B64.decode(cap["scenarios"][0]["envelope"].as_str().unwrap()).unwrap();
    let out = call(&run_header(&cap, host_protocol() + 1, &env, MODE_RECORD));
    let mut r = Reply(&out);
    assert_eq!(r.u8(), ST_ERROR);
    let message = String::from_utf8_lossy(r.blob()).to_string();
    assert!(message.contains(&format!("implements protocol {}", host_protocol())), "{message}");
}

#[test]
fn reports_unknown_keys() {
    assert_eq!(call(&[OP_RESET]), vec![ST_COMPLETE]);
    let cap = capture();
    let env = B64.decode(cap["scenarios"][0]["envelope"].as_str().unwrap()).unwrap();
    let out = call(&run_header(&cap, host_protocol(), &env, MODE_RECORD));
    let mut r = Reply(&out);
    assert_eq!(r.u8(), ST_NEEDS_STATE);
    assert!(r.u32() > 0, "an empty store needs at least the network config");
}

#[test]
fn rejects_garbage() {
    let out = call(&[OP_RUN, 1, 2]);
    assert_eq!(out[0], ST_ERROR);
    let out = call(&[99]);
    assert_eq!(out[0], ST_ERROR);
}
