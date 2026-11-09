//! A payment two parties authorize, for the sign dialog's multi-party
//! preview test: `a` and `b` both `require_auth` at the root, then `b` pays.
//! A wallet previewing for `a` sees `b`'s entry unsigned.
#![no_std]

use soroban_sdk::{contract, contractimpl, token::TokenClient, Address, Env};

#[contract]
pub struct TwoParty;

#[contractimpl]
impl TwoParty {
    pub fn pay(env: Env, a: Address, b: Address, token: Address, to: Address, amount: i128) {
        a.require_auth();
        b.require_auth();
        TokenClient::new(&env, &token).transfer(&b, &to, &amount);
    }
}
