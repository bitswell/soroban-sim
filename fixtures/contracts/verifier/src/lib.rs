//! A signature verifier in the shape OZ smart accounts call:
//! `verify(signature_payload, key_data, sig_data) -> bool`. One wasm covers
//! the three schemes the session signer adapters produce, chosen at deploy:
//!
//! - `0` ed25519: 32-byte key, 64-byte signature over the payload.
//! - `1` secp256r1: 65-byte uncompressed key, 64-byte ECDSA-SHA256 signature
//!   over the payload.
//! - `2` WebAuthn: 65-byte key (a credential id may follow), `sig_data` is the
//!   XDR of `WebAuthnSigData`. The client data must be a `webauthn.get` whose
//!   challenge is the base64url payload, the authenticator flags must have
//!   user presence and verification set, and the secp256r1 signature must
//!   cover `authenticator_data || sha256(client_data)`.
//!
//! A bad signature traps, as OZ's verifiers do.
#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, xdr::FromXdr, Bytes, BytesN, Env, Symbol,
};

const KIND: Symbol = symbol_short!("KIND");
const FLAGS_UP_UV: u8 = 0x05;

#[contracttype]
pub struct WebAuthnSigData {
    pub signature: BytesN<64>,
    pub authenticator_data: Bytes,
    pub client_data: Bytes,
}

#[contract]
pub struct Verifier;

#[contractimpl]
impl Verifier {
    pub fn __constructor(env: Env, kind: u32) {
        env.storage().instance().set(&KIND, &kind);
    }

    pub fn verify(env: Env, signature_payload: Bytes, key_data: Bytes, sig_data: Bytes) -> bool {
        let kind: u32 = env.storage().instance().get(&KIND).unwrap();
        match kind {
            0 => {
                let key: BytesN<32> = key_data.try_into().unwrap();
                let sig: BytesN<64> = sig_data.try_into().unwrap();
                env.crypto().ed25519_verify(&key, &signature_payload, &sig);
            }
            1 => {
                let key: BytesN<65> = key_data.slice(0..65).try_into().unwrap();
                let sig: BytesN<64> = sig_data.try_into().unwrap();
                let digest = env.crypto().sha256(&signature_payload);
                env.crypto().secp256r1_verify(&key, &digest, &sig);
            }
            2 => verify_webauthn(&env, &signature_payload, &key_data, &sig_data),
            _ => panic!("unknown verifier kind"),
        }
        true
    }
}

fn verify_webauthn(env: &Env, payload: &Bytes, key_data: &Bytes, sig_data: &Bytes) {
    let sig = WebAuthnSigData::from_xdr(env, sig_data).unwrap();
    let key: BytesN<65> = key_data.slice(0..65).try_into().unwrap();
    let flags = sig.authenticator_data.get(32).unwrap();
    assert!(flags & FLAGS_UP_UV == FLAGS_UP_UV, "user presence and verification required");

    let mut client = [0u8; 1024];
    let n = sig.client_data.len() as usize;
    assert!(n <= client.len(), "client data too long");
    sig.client_data.copy_into_slice(&mut client[..n]);
    let client = &client[..n];
    assert!(contains(client, b"\"type\":\"webauthn.get\""), "not a webauthn.get");

    let mut raw = [0u8; 32];
    assert!(payload.len() == 32, "payload is not 32 bytes");
    payload.copy_into_slice(&mut raw);
    let mut challenge = [0u8; 13 + 43 + 1];
    challenge[..13].copy_from_slice(b"\"challenge\":\"");
    base64url_32(&raw, &mut challenge[13..56]);
    challenge[56] = b'"';
    assert!(contains(client, &challenge), "challenge mismatch");

    let mut message = sig.authenticator_data.clone();
    message.append(&env.crypto().sha256(&sig.client_data).into());
    let digest = env.crypto().sha256(&message);
    env.crypto().secp256r1_verify(&key, &digest, &sig.signature);
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Unpadded base64url of 32 bytes: 43 characters.
fn base64url_32(input: &[u8; 32], out: &mut [u8]) {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bits: u32 = 0;
    let mut nbits = 0;
    let mut o = 0;
    for byte in input {
        bits = (bits << 8) | *byte as u32;
        nbits += 8;
        while nbits >= 6 {
            nbits -= 6;
            out[o] = ALPHABET[((bits >> nbits) & 63) as usize];
            o += 1;
        }
    }
    if nbits > 0 {
        out[o] = ALPHABET[((bits << (6 - nbits)) & 63) as usize];
    }
}
