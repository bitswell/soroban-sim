// The plain `test`: a worker of the test's own, no suite setup.
import { expect } from 'vitest'
import { test } from '../src/index.ts'

const storageWasm = new URL('../../../fixtures/contracts/storage.wasm', import.meta.url)

test('accounts by name deploy, call and view', async ({ worker }) => {
  const alice = await worker.createAccount('alice')
  const storage = await alice.deploy(storageWasm)
  await alice.call(storage, 'put_persist', { key: 1, val: 3 })
  expect(await storage.view('get_persist', { key: 1 })).toBe(3)
  expect(worker.account('alice')).toBe(alice)
  expect(await worker.contract(storage.id).view('get_persist', { key: 1 })).toBe(3)
})

test('a name is one account: creating it twice is refused, as is an unknown name', async ({ worker }) => {
  await worker.createAccount('alice')
  await expect(worker.createAccount('alice')).rejects.toThrow(/already exists/)
  expect(() => worker.account('carol')).toThrow(/no account "carol"/)
})

test('a function the contract does not have is refused with the ones it has', async ({ worker }) => {
  const alice = await worker.createAccount('alice')
  const storage = await alice.deploy(storageWasm)
  await expect(alice.call(storage, 'put', { key: 1 })).rejects.toThrow(/has no function "put"; it has .*put_persist/)
})
