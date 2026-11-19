// The same storage suite with the client `stellar contract bindings
// typescript` generated for the contract: methods and results are typed.
import { expect } from 'vitest'
import { defineSuite } from '../src/index.ts'
import { Client as StorageClient } from './bindings/storage.ts'

const storageWasm = new URL('../../../fixtures/contracts/storage.wasm', import.meta.url)

const { test } = defineSuite({
  name: 'storage with bindings',
  wasm: [{ file: storageWasm, client: StorageClient }],
  async setup(worker) {
    const admin = await worker.createAccount('admin')
    const alice = await worker.createAccount('alice')
    const storage = await admin.deploy(storageWasm, { client: StorageClient })
    await (await storage.put_persist({ key: 1, val: 7 })).signAndSend()
    return { alice, storage }
  },
})

test('setup’s client comes back as the generated class', async ({ setup: { storage } }) => {
  expect(storage).toBeInstanceOf(StorageClient)
  const { result } = await storage.get_persist({ key: 1 })
  expect(result).toBe(7)
})

test('another account writes and reads its own value back', async ({ setup: { alice, storage } }) => {
  const asAlice = alice.client(storage)
  expect(asAlice).toBeInstanceOf(StorageClient)
  await (await asAlice.put_persist({ key: 2, val: 42 })).signAndSend()
  expect((await asAlice.get_persist({ key: 2 })).result).toBe(42)
})

test('a contract a test deploys from the paired Wasm gets the generated class too', async ({ worker, setup: { alice } }) => {
  const mine = await alice.deploy(storageWasm)
  expect(mine).toBeInstanceOf(StorageClient)
  const found = await worker.contract(mine.options.contractId, StorageClient)
  await (await mine.put_persist({ key: 3, val: 3 })).signAndSend()
  expect((await found.get_persist({ key: 3 })).result).toBe(3)
})
