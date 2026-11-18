// The harness's own tests of the soroban-sim setup cache. They need the
// soroban-sim binary, so they run in the soroban-sim environment only.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rpc } from '@stellar/stellar-sdk'
import { describe, expect, test } from 'vitest'
import { cacheKey } from '../src/cache.ts'
import { clearCache, prepareSimSetup, resolveConfig, type Config, type SuiteDefinition } from '../src/index.ts'
import { rpcCall, startServer } from '../src/server.ts'

const env = resolveConfig()
const storage = new URL('../../../fixtures/contracts/storage.wasm', import.meta.url)

/** Two versions of one suite's setup, counting their runs: the second differs in source only. */
function suites() {
  const counter = { runs: 0 }
  const base = { name: 'cache', signers: ['admin'] as const, wasm: { storage } }
  const first: SuiteDefinition<'admin', 'storage', { value: number }> = {
    ...base,
    async setup() {
      counter.runs++
      return { value: 1 }
    },
  }
  const changed: SuiteDefinition<'admin', 'storage', { value: number }> = {
    ...base,
    async setup() {
      counter.runs++
      return { value: 2 }
    },
  }
  return { first, changed, counter }
}

async function config(cache: Config['sim']['cache'] = 'on', cacheDir?: string): Promise<Config> {
  return { ...env, sim: { ...env.sim, cache, cacheDir: cacheDir ?? (await mkdtemp(join(tmpdir(), 'svt-cache-'))) } }
}

describe.skipIf(env.environment !== 'soroban-sim')('setup cache', () => {
  test('a second run takes the snapshot from the cache and does not run setup', async () => {
    const cfg = await config()
    const { first, counter } = suites()
    const a = await prepareSimSetup(first, cfg)
    expect([a.cached, counter.runs, a.result]).toEqual([false, 1, { value: 1 }])
    const b = await prepareSimSetup(first, cfg)
    expect([b.cached, counter.runs, b.result]).toEqual([true, 1, { value: 1 }])
    expect(b.snapshot).toBe(a.snapshot)
    const snap = JSON.parse(await readFile(b.snapshot, 'utf8'))
    expect(snap.format).toBe('soroban-sim-snapshot/2')
  })

  test('changing setup runs it again', async () => {
    const cfg = await config()
    const { first, changed, counter } = suites()
    await prepareSimSetup(first, cfg)
    const c = await prepareSimSetup(changed, cfg)
    expect([c.cached, counter.runs, c.result]).toEqual([false, 2, { value: 2 }])
  })

  test('SOROBAN_TEST_CACHE=off runs setup and stores nothing; clearCache empties the cache', async () => {
    const dir = (await config()).sim.cacheDir
    const { first, counter } = suites()
    await prepareSimSetup(first, await config('off', dir))
    await prepareSimSetup(first, await config('off', dir))
    expect(counter.runs).toBe(2)
    expect((await prepareSimSetup(first, await config('on', dir))).cached).toBe(false)
    expect((await prepareSimSetup(first, await config('on', dir))).cached).toBe(true)
    await clearCache(dir)
    expect((await prepareSimSetup(first, await config('on', dir))).cached).toBe(false)
    expect(counter.runs).toBe(4)
  })

  test('an entry that cannot be read is replaced by a fresh setup run', async () => {
    const damage = [
      (entry: string) => rm(join(entry, 'snapshot.json')),
      (entry: string) => writeFile(join(entry, 'setup.json'), 'not json'),
    ]
    for (const [i, harm] of damage.entries()) {
      const cfg = await config()
      const { first, counter } = suites()
      const a = await prepareSimSetup(first, cfg)
      await harm(dirname(a.snapshot))
      const b = await prepareSimSetup(first, cfg)
      expect([i, b.cached, counter.runs, b.result]).toEqual([i, false, 2, { value: 1 }])
      expect(JSON.parse(await readFile(b.snapshot, 'utf8')).format).toBe('soroban-sim-snapshot/2')
      const c = await prepareSimSetup(first, cfg)
      expect([i, c.cached, counter.runs, c.snapshot]).toEqual([i, true, 2, b.snapshot])
    }
  })

  test('a replaced entry pairs the result with the snapshot of the same setup run', async () => {
    const cfg = await config()
    let runs = 0
    const suite: SuiteDefinition<'admin', never, { account: string; xlm: string }> = {
      name: 'replaced',
      signers: ['admin'],
      async setup({ signers, rpcUrl }) {
        const xlm = String(10 + ++runs)
        await rpcCall(rpcUrl, 'fork_setBalance', { account: signers.admin.publicKey(), xlm })
        return { account: signers.admin.publicKey(), xlm }
      },
    }
    const a = await prepareSimSetup(suite, cfg)
    await rm(join(dirname(a.snapshot), 'setup.json'))
    const b = await prepareSimSetup(suite, cfg)
    expect([b.cached, runs, b.result.xlm, b.snapshot]).toEqual([false, 2, '12', a.snapshot])
    const srv = await startServer(cfg.sim.bin, ['--snapshot', b.snapshot])
    try {
      const entry = await new rpc.Server(srv.url, { allowHttp: true }).getAccountEntry(b.result.account)
      expect(String(entry.balance)).toBe('120000000')
    } finally {
      await srv.stop()
    }
    const c = await prepareSimSetup(suite, cfg)
    expect([c.cached, runs, c.result]).toEqual([true, 2, b.result])
  })

  test('the key covers the Wasm, the signers and the base snapshot', async () => {
    const cfg = await config()
    const { first } = suites()
    const wasm = { storage: Buffer.from(await readFile(storage)) }
    const key = (def = first, c = cfg, w = wasm) => cacheKey(def as never, c, w)
    const original = await key()
    expect(await key()).toBe(original)
    expect(await key(first, cfg, { storage: Buffer.concat([wasm.storage, Buffer.from([0])]) })).not.toBe(original)
    expect(await key({ ...first, signers: ['admin', 'other'] } as never)).not.toBe(original)
    const other = join(cfg.sim.cacheDir, 'other-base.json')
    await writeFile(other, `${await readFile(cfg.sim.snapshot, 'utf8')}\n`)
    expect(await key(first, { ...cfg, sim: { ...cfg.sim, snapshot: other } })).not.toBe(original)
  })

  test('a server started from the snapshot holds what setup wrote', async () => {
    const cfg = await config()
    const prepared = await prepareSimSetup(
      {
        name: 'balance',
        signers: ['admin'],
        async setup({ signers, rpcUrl }) {
          await rpcCall(rpcUrl, 'fork_setBalance', { account: signers.admin.publicKey(), xlm: '12.5' })
          return signers.admin.publicKey()
        },
      },
      cfg,
    )
    const srv = await startServer(cfg.sim.bin, ['--snapshot', prepared.snapshot])
    try {
      const entry = await new rpc.Server(srv.url, { allowHttp: true }).getAccountEntry(prepared.result)
      expect(String(entry.balance)).toBe('125000000')
    } finally {
      await srv.stop()
    }
  })
})
