import { test as baseTest, type TestAPI } from 'vitest'
import { resolveConfig, type Config } from './config.ts'
import { environmentFor } from './environments.ts'
import type { SuiteDefinition, TestEnv } from './suite-types.ts'

export { deployContract, invoke, read, submit, uploadWasm, type Network } from './contracts.ts'
export { clearCache } from './cache.ts'
export { DEFAULT_SNAPSHOT, defaultCacheDir, resolveConfig, type Config, type EnvironmentKind } from './config.ts'
export { prepareSimSetup, type PreparedSetup } from './environments.ts'
export { deriveSigners, type Signers } from './signers.ts'
export type { SetupContext, SuiteDefinition, TestEnv } from './suite-types.ts'

export interface Suite<N extends string, W extends string, S> {
  /** Vitest's `test`, with an `env` fixture: each test gets its own copy of the suite's setup. */
  test: TestAPI<{ env: TestEnv<N, W, S> }>
}

/**
 * Declares a suite: signers to fund, a setup that runs once per suite on
 * soroban-sim (once per test on a local network), and a `test` whose tests
 * receive `env`. Which environment runs is configuration (SOROBAN_TEST_ENV),
 * never part of the test code.
 */
export function defineSuite<N extends string, W extends string = never, S = undefined>(
  def: SuiteDefinition<N, W, S>,
  config: Config = resolveConfig(),
): Suite<N, W, S> {
  const environment = environmentFor(def, config)
  const test = baseTest.extend<{ env: TestEnv<N, W, S> }>({
    env: async ({ task }, use) => {
      const lease = await environment.acquire(task.id)
      try {
        await use(lease.env)
      } finally {
        await lease.release()
      }
    },
  })
  return { test }
}
