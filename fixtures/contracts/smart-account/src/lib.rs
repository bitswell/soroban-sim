//! An OpenZeppelin-shaped smart account for the session engine's signer
//! tests. It accepts the same `AuthPayload` OZ's `stellar-accounts` does
//! (`context_rule_ids` plus a `Signer -> signature bytes` map) and supports the
//! two digest schemes the signer adapters produce:
//!
//! - `0` (`oz_rule_ids`): `sha256(signature_payload || rule_ids XDR)`.
//! - `1` (`addr_oz_v1`): the payload is first bound to this account's contract
//!   id, `sha256("perch/account/auth-addr-v1" || id || signature_payload)`,
//!   then hashed with the rule ids as above.
//!
//! `External(verifier, key)` signers are checked by calling the verifier
//! contract; `Delegated(address)` signers are forwarded to the host through
//! CAP-71 delegation. A single context rule (id 0) covers every context, and
//! it can carry a `valid_until` ledger, past which auth fails with OZ's
//! `UnvalidatedContext` (3002).
#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractclient, contracterror, contractimpl, contracttype,
    crypto::Hash,
    xdr::ToXdr,
    Address, Bytes, Env, Map, Vec,
};

const ADDR_DOMAIN: &[u8] = b"perch/account/auth-addr-v1";

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    UnknownSigner = 1,
    UnknownRule = 2,
    VerifierRejected = 3,
    NoSigners = 4,
    UnvalidatedContext = 3002,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Signer {
    External(Address, Bytes),
    Delegated(Address),
}

#[contracttype]
#[derive(Clone)]
pub struct AuthPayload {
    pub context_rule_ids: Vec<u32>,
    pub signers: Map<Signer, Bytes>,
}

#[contracttype]
enum Key {
    Signers,
    Scheme,
    ValidUntil,
}

#[contractclient(name = "VerifierClient")]
pub trait Verifier {
    fn verify(env: Env, signature_payload: Bytes, key_data: Bytes, sig_data: Bytes) -> bool;
}

#[contract]
pub struct SmartAccount;

#[contractimpl]
impl SmartAccount {
    /// `scheme`: 0 = `oz_rule_ids`, 1 = `addr_oz_v1`. `valid_until`: the last
    /// ledger rule 0 is valid in, or 0 for no expiry.
    pub fn __constructor(env: Env, signers: Vec<Signer>, scheme: u32, valid_until: u32) {
        let storage = env.storage().instance();
        storage.set(&Key::Signers, &signers);
        storage.set(&Key::Scheme, &scheme);
        storage.set(&Key::ValidUntil, &valid_until);
    }

    /// Requires this account's own authorization, then echoes `x`.
    pub fn guarded(env: Env, x: u32) -> u32 {
        env.current_contract_address().require_auth();
        x
    }
}

#[contractimpl]
impl CustomAccountInterface for SmartAccount {
    type Signature = AuthPayload;
    type Error = Error;

    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        auth: AuthPayload,
        contexts: Vec<Context>,
    ) -> Result<(), Error> {
        if auth.context_rule_ids.len() != contexts.len() {
            return Err(Error::UnknownRule);
        }
        for id in auth.context_rule_ids.iter() {
            if id != 0 {
                return Err(Error::UnknownRule);
            }
        }
        let storage = env.storage().instance();
        let valid_until: u32 = storage.get(&Key::ValidUntil).unwrap();
        if valid_until != 0 && valid_until < env.ledger().sequence() {
            return Err(Error::UnvalidatedContext);
        }
        if auth.signers.is_empty() {
            return Err(Error::NoSigners);
        }
        let registered: Vec<Signer> = storage.get(&Key::Signers).unwrap();
        let scheme: u32 = storage.get(&Key::Scheme).unwrap();
        let digest = digest(&env, &signature_payload, &auth.context_rule_ids, scheme);
        for (signer, sig) in auth.signers.iter() {
            if registered.first_index_of(&signer).is_none() {
                return Err(Error::UnknownSigner);
            }
            match signer {
                Signer::External(verifier, key) => {
                    if !VerifierClient::new(&env, &verifier).verify(&digest, &key, &sig) {
                        return Err(Error::VerifierRejected);
                    }
                }
                Signer::Delegated(address) => env.custom_account().delegate_auth(&address),
            }
        }
        Ok(())
    }
}

fn digest(env: &Env, payload: &Hash<32>, rule_ids: &Vec<u32>, scheme: u32) -> Bytes {
    let mut base = Bytes::from_array(env, &payload.to_array());
    if scheme == 1 {
        // The contract id is the last 32 bytes of the address's ScVal XDR.
        let address = env.current_contract_address().to_xdr(env);
        let mut bound = Bytes::from_slice(env, ADDR_DOMAIN);
        bound.append(&address.slice(address.len() - 32..));
        bound.append(&base);
        base = env.crypto().sha256(&bound).into();
    }
    base.append(&rule_ids.to_xdr(env));
    env.crypto().sha256(&base).into()
}
