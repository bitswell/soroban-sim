#![no_std]

use soroban_sdk::{contract, contractimpl};

#[contract]
pub struct AddI32;

#[contractimpl]
impl AddI32 {
    pub fn add(a: i32, b: i32) -> i32 {
        a + b
    }
}
