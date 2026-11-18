import { createHash } from 'node:crypto'
import { Keypair } from '@stellar/stellar-sdk'

export type Signers<N extends string> = { readonly [K in N]: Keypair }

/**
 * Throwaway keypairs derived from `seed` and each name: the same seed and
 * name give the same key on every run, so a cached snapshot and the tests
 * started from it agree on who the signers are.
 */
export function deriveSigners<N extends string>(seed: string, names: readonly N[]): Signers<N> {
  const out = {} as Record<N, Keypair>
  for (const name of names) {
    if (Object.hasOwn(out, name)) throw new Error(`signer ${JSON.stringify(name)} is listed twice`)
    const raw = createHash('sha256').update(`soroban-sim-vitest/signer\0${seed}\0${name}`).digest()
    out[name] = Keypair.fromRawEd25519Seed(raw)
  }
  return out
}
