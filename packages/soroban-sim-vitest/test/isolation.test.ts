// Two tests write the same key of the contract setup deployed, at the same
// time, with the same signer name. Each must read back its own value: on
// soroban-sim because each test has its own server, on a local network
// because each test has its own keys and its own contract.
import { nativeToScVal } from '@stellar/stellar-sdk'
import { expect } from 'vitest'
import { defineSuite, invoke, read, deployContract } from '../src/index.ts'

const u32 = (n: number) => nativeToScVal(n, { type: 'u32' })

const { test } = defineSuite({
  name: 'isolation',
  signers: ['writer'],
  wasm: { storage: new URL('../../../fixtures/contracts/storage.wasm', import.meta.url) },
  async setup({ signers, wasm, ...net }) {
    const contractId = await deployContract(net, signers.writer, wasm.storage)
    await invoke(net, signers.writer, contractId, 'put_persist', [u32(1), u32(0)])
    return { contractId }
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
  test(`writes ${value} and reads back only its own write`, async ({ env }) => {
    const { contractId } = env.setup
    expect(await read(env, env.signers.writer, contractId, 'get_persist', [u32(1)])).toBe(0)
    await invoke(env, env.signers.writer, contractId, 'put_persist', [u32(1), u32(value)])
    await bothWritten()
    expect(await read(env, env.signers.writer, contractId, 'get_persist', [u32(1)])).toBe(value)
  })
}
