// Two tests write the same key of the contract setup deployed, at the same
// time, from the same account name. Each must read back its own value: on
// soroban-sim because each test has its own server, on a local network
// because each test has its own accounts and its own contract.
import { expect } from 'vitest'
import { defineSuite } from '../src/index.ts'

const storageWasm = new URL('../../../fixtures/contracts/storage.wasm', import.meta.url)

const { test } = defineSuite({
  name: 'isolation',
  wasm: [storageWasm],
  async setup(worker) {
    const writer = await worker.createAccount('writer')
    const storage = await writer.deploy(storageWasm)
    await writer.call(storage, 'put_persist', { key: 1, val: 0 })
    return { writer, storage }
  },
})

/** Resolves once both tests have written (or after a minute, if only one runs). */
function rendezvous(parties: number, timeoutMs = 60_000) {
  let arrived = 0
  let open!: () => void
  const all = new Promise<void>((resolve) => (open = resolve))
  return () => {
    if (++arrived === parties) open()
    return Promise.race([all, new Promise<void>((r) => setTimeout(r, timeoutMs).unref())])
  }
}
const bothWritten = rendezvous(2)

for (const value of [111, 222]) {
  test(`writes ${value} and reads back only its own write`, async ({ setup: { writer, storage } }) => {
    expect(await storage.view('get_persist', { key: 1 })).toBe(0)
    await writer.call(storage, 'put_persist', { key: 1, val: value })
    await bothWritten()
    expect(await storage.view('get_persist', { key: 1 })).toBe(value)
  })
}
