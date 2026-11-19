// The example suite: nothing here names an environment. `pnpm test` runs it
// on soroban-sim, `pnpm test:local` against a local network.
import { expect } from 'vitest'
import { ContractError, InvocationError, defineSuite } from '../src/index.ts'

const storageWasm = new URL('../../../fixtures/contracts/storage.wasm', import.meta.url)

const { test } = defineSuite({
  name: 'storage example',
  wasm: [storageWasm],
  async setup(worker) {
    const admin = await worker.createAccount('admin')
    const alice = await worker.createAccount('alice')
    const bob = await worker.createAccount('bob')
    const storage = await admin.deploy(storageWasm)
    await admin.call(storage, 'put_persist', { key: 1, val: 7 })
    return { admin, alice, bob, storage }
  },
})

test('reads what setup wrote', async ({ setup: { storage } }) => {
  expect(await storage.view('get_persist', { key: 1 })).toBe(7)
})

test('an account writes and reads its own value back', async ({ setup: { alice, storage } }) => {
  await alice.call(storage, 'put_persist', { key: 2, val: 42 })
  expect(await storage.view('get_persist', { key: 2 })).toBe(42)
})

test('accounts setup did not use still hold their funding', async ({ setup: { alice, bob } }) => {
  expect(await alice.balance()).toBe(10_000_0000000n)
  expect(await bob.balance()).toBe(10_000_0000000n)
})

test('a test deploys a contract of its own', async ({ setup: { bob, storage } }) => {
  const mine = await bob.deploy(storageWasm)
  expect(mine.id).not.toBe(storage.id)
  await bob.call(mine, 'put_persist', { key: 1, val: 9 })
  expect(await mine.view('get_persist', { key: 1 })).toBe(9)
  expect(await storage.view('get_persist', { key: 1 })).toBe(7)
})

test('XLM moves between accounts through the native asset contract', async ({ worker, setup: { alice, bob } }) => {
  const xlm = await worker.xlm()
  await alice.call(xlm, 'transfer', { from: alice, to: bob, amount: 25_0000000n })
  expect(await xlm.view('balance', { id: bob })).toBe(10_025_0000000n)
})

test("a contract's own error comes back as a ContractError with its code", async ({ worker, setup: { alice, bob } }) => {
  const xlm = await worker.xlm()
  const error = await alice.call(xlm, 'transfer', { from: alice, to: bob, amount: 1_000_000_0000000n }).catch((e) => e)
  expect(error).toBeInstanceOf(ContractError)
  expect(error).toMatchObject({ code: 10, errorName: 'BalanceError', method: 'transfer', contract: xlm.id })
  expect(error.events.length).toBeGreaterThan(0)
})

test('a trap comes back as an InvocationError with the host error and its events', async ({ setup: { storage } }) => {
  const error = await storage.view('get_persist', { key: 99 }).catch((e) => e)
  expect(error).toBeInstanceOf(InvocationError)
  expect(error).not.toBeInstanceOf(ContractError)
  expect(error.hostError).toMatch(/^Error\(WasmVm, /)
  expect(error.events.length).toBeGreaterThan(0)
})
