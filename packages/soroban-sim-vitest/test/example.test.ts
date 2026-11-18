// The example suite: nothing here names an environment. `pnpm test` runs it
// on soroban-sim, `pnpm test:local` against a local network.
import { nativeToScVal } from '@stellar/stellar-sdk'
import { expect } from 'vitest'
import { defineSuite, deployContract, invoke, read } from '../src/index.ts'

const u32 = (n: number) => nativeToScVal(n, { type: 'u32' })

const { test } = defineSuite({
  name: 'storage example',
  signers: ['admin', 'alice', 'bob'],
  wasm: { storage: new URL('../../../fixtures/contracts/storage.wasm', import.meta.url) },
  async setup({ signers, wasm, ...net }) {
    const contractId = await deployContract(net, signers.admin, wasm.storage)
    await invoke(net, signers.admin, contractId, 'put_persist', [u32(1), u32(7)])
    return { contractId }
  },
})

test('reads what setup wrote', async ({ env }) => {
  expect(await read(env, env.signers.alice, env.setup.contractId, 'get_persist', [u32(1)])).toBe(7)
})

test('a signer writes and reads its own value back', async ({ env }) => {
  await invoke(env, env.signers.alice, env.setup.contractId, 'put_persist', [u32(2), u32(42)])
  expect(await read(env, env.signers.alice, env.setup.contractId, 'get_persist', [u32(2)])).toBe(42)
})

test('the signers setup did not use still hold their funding', async ({ env }) => {
  for (const name of ['alice', 'bob'] as const) {
    const entry = await env.rpc.getAccountEntry(env.signers[name].publicKey())
    expect(String(entry.balance)).toBe('100000000000')
  }
})

test('a test deploys a contract of its own', async ({ env }) => {
  const mine = await deployContract(env, env.signers.bob, env.wasm.storage)
  expect(mine).not.toBe(env.setup.contractId)
  await invoke(env, env.signers.bob, mine, 'put_persist', [u32(1), u32(9)])
  expect(await read(env, env.signers.bob, mine, 'get_persist', [u32(1)])).toBe(9)
  expect(await read(env, env.signers.bob, env.setup.contractId, 'get_persist', [u32(1)])).toBe(7)
})
