import type { Keypair, rpc } from '@stellar/stellar-sdk'
import type { Network } from './contracts.ts'
import type { Signers } from './signers.ts'

/** Every signer starts with this balance on both environments (friendbot's amount). */
export const FUNDING_XLM = '10000'

/** What setup and every test receive: nothing in it depends on which environment runs. */
export interface SetupContext<N extends string, W extends string> extends Network {
  rpcUrl: string
  networkPassphrase: string
  rpc: rpc.Server
  /** Funded throwaway signers, by the names the suite declared. */
  signers: Signers<N>
  /** The suite's Wasm files, read once. */
  wasm: { readonly [K in W]: Buffer }
}

export interface TestEnv<N extends string, W extends string, S> extends SetupContext<N, W> {
  /** What the suite's setup returned (through JSON, as the cache stores it). */
  setup: S
}

export interface SuiteDefinition<N extends string, W extends string, S> {
  /** Names the suite in messages and cache entries. */
  name: string
  /** The signers to derive and fund before setup runs. */
  signers: readonly N[]
  /** Wasm files setup deploys: their contents are part of the cache key. */
  wasm?: { readonly [K in W]: string | URL }
  /**
   * Files besides the Wasm whose contents setup depends on (helper modules
   * it imports, data it reads): the cache key covers setup's own source
   * only, so list them here for a change to them to rerun it.
   */
  cacheFiles?: readonly (string | URL)[]
  /** Deploys, funds, writes; returns what the tests need. Must be JSON-serializable. */
  setup: (ctx: SetupContext<N, W>) => Promise<S>
}

export type AnySuite = SuiteDefinition<string, string, unknown>
export type { Keypair }
