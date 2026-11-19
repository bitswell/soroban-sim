import { describe, expect, test } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { deriveKeypair } from '../src/keys.ts'

describe('account keys', () => {
  test('the same seed and name give the same key; another seed or name another key', () => {
    const admin = deriveKeypair('seed', 'admin')
    expect(deriveKeypair('seed', 'admin').secret()).toBe(admin.secret())
    expect(deriveKeypair('seed', 'alice').publicKey()).not.toBe(admin.publicKey())
    expect(deriveKeypair('other', 'admin').publicKey()).not.toBe(admin.publicKey())
  })
})

describe('configuration', () => {
  test('defaults to soroban-sim over the bundled local-network snapshot, with the cache on', () => {
    const c = resolveConfig({})
    expect(c.environment).toBe('soroban-sim')
    expect(c.sim.cache).toBe('on')
    expect(c.sim.snapshot).toMatch(/snapshots\/local-network\.json$/)
    expect(c.local).toEqual({ rpcUrl: 'http://localhost:8000/rpc', friendbotUrl: 'http://localhost:8000/friendbot' })
  })

  test('reads the environment, snapshot and cache from variables', () => {
    const c = resolveConfig({
      SOROBAN_TEST_ENV: 'local',
      SOROBAN_SIM_SNAPSHOT: '/tmp/base.json',
      SOROBAN_TEST_CACHE: 'off',
      SOROBAN_TEST_RPC_URL: 'http://127.0.0.1:8010/rpc',
    })
    expect(c.environment).toBe('local')
    expect(c.sim.snapshot).toBe('/tmp/base.json')
    expect(c.sim.cache).toBe('off')
    expect(c.local.friendbotUrl).toBe('http://127.0.0.1:8010/friendbot')
  })

  test('refuses values it does not know', () => {
    expect(() => resolveConfig({ SOROBAN_TEST_ENV: 'testnet' })).toThrow(/SOROBAN_TEST_ENV/)
    expect(() => resolveConfig({ SOROBAN_TEST_CACHE: 'no' })).toThrow(/SOROBAN_TEST_CACHE/)
    expect(() => resolveConfig({ SOROBAN_TEST_CACHE: 'refresh' })).toThrow(/SOROBAN_TEST_CACHE/)
  })
})
