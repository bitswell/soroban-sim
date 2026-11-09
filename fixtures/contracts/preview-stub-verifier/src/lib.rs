//! Preview-only verifier: accepts every signature. A wallet preview swaps it
//! in for an account's real verifier, on the local fork only, so the
//! account's policy decides the verdict before the user has signed anything.
//! It must never be deployed.
#![no_std]

use soroban_sdk::{contract, contractimpl, Bytes, Env};

#[contract]
pub struct AcceptAll;

#[contractimpl]
impl AcceptAll {
    pub fn verify(
        _env: Env,
        _signature_payload: Bytes,
        _key_data: Bytes,
        _sig_data: Bytes,
    ) -> bool {
        true
    }
}
