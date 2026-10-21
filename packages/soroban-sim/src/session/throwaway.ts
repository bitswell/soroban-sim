/**
 * Throwaway keys: the same derivation as soroban-sim-core's
 * `Ed25519Key::throwaway(label)`, `sha256("soroban-sim throwaway:" ‖ label)`
 * as the ed25519 seed. A label gives the same address in the browser and in
 * `soroban-sim session run`, so plans and logs need no secrets.
 *
 * Anyone can derive these keys from their labels. They are safe only because
 * the real network has never heard of them: a session substitutes them for
 * real signers (`fork_addSigner`) or funds them by override.
 */
import { hash, Keypair } from "@stellar/stellar-sdk";

const THROWAWAY_DOMAIN = "soroban-sim throwaway:";

export function throwawayKeypair(label: string): Keypair {
  // The SDK's hash and Keypair take its Buffer, which is a Uint8Array.
  const bytes = new TextEncoder().encode(`${THROWAWAY_DOMAIN}${label}`);
  const seed = hash(bytes as unknown as Parameters<typeof hash>[0]);
  return Keypair.fromRawEd25519Seed(seed);
}
