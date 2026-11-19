// The harness's own tests of the soroban-sim setup cache. They need the
// soroban-sim binary, so they run in the soroban-sim environment only.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { cacheKey } from '../src/cache.ts'
import { Worker, clearCache, prepareSimSetup, resolveConfig, type Config, type SuiteDefinition } from '../src/index.ts'

const env = resolveConfig()
const storage = new URL('../../../fixtures/contracts/storage.wasm', import.meta.url)
const addI32 = new URL('../../../fixtures/contracts/add_i32.wasm', import.meta.url)

/** Two versions of one suite's setup, counting their runs: the second differs in source only. */
function suites() {
  const counter = { runs: 0 }
  const base = { name: 'cache', wasm: [storage] }
  const first: SuiteDefinition<{ value: number }> = {
    ...base,
    async setup() {
      counter.runs++
      return { value: 1 }
    },
  }
  const changed: SuiteDefinition<{ value: number }> = {
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

  test('changing the test file that defines the suite runs setup again', async () => {
    const cfg = await config()
    const { first, counter } = suites()
    const testFile = join(cfg.sim.cacheDir, 'suite.test.ts')
    await writeFile(testFile, 'const INITIAL = 7\n')
    await prepareSimSetup(first, cfg, testFile)
    expect([(await prepareSimSetup(first, cfg, testFile)).cached, counter.runs]).toEqual([true, 1])
    await writeFile(testFile, 'const INITIAL = 8\n')
    expect([(await prepareSimSetup(first, cfg, testFile)).cached, counter.runs]).toEqual([false, 2])
    expect([(await prepareSimSetup(first, cfg, testFile)).cached, counter.runs]).toEqual([true, 2])
  })

  test('an entry that cannot be read fails the run, naming the cache to clear', async () => {
    const damage = [
      (entry: string) => rm(join(entry, 'snapshot.json')),
      (entry: string) => writeFile(join(entry, 'setup.json'), 'not json'),
    ]
    for (const harm of damage) {
      const cfg = await config()
      const { first } = suites()
      const a = await prepareSimSetup(first, cfg)
      await harm(dirname(a.snapshot))
      const error: Error = await prepareSimSetup(first, cfg).catch((e) => e)
      expect(error.message).toContain(`${dirname(a.snapshot)} cannot be read`)
      expect(error.message).toContain(`delete ${cfg.sim.cacheDir}, or call clearCache`)
      await clearCache(cfg.sim.cacheDir)
      expect((await prepareSimSetup(first, cfg)).cached).toBe(false)
      expect((await prepareSimSetup(first, cfg)).cached).toBe(true)
    }
  })

  test('the key covers the Wasm, the suite name and the base snapshot', async () => {
    const cfg = await config()
    const { first } = suites()
    const wasm = [await readFile(storage)]
    const key = (def = first, c = cfg, w = wasm) => cacheKey(def as never, c, w)
    const original = await key()
    expect(await key()).toBe(original)
    expect(await key(first, cfg, [Buffer.concat([wasm[0], Buffer.from([0])])])).not.toBe(original)
    expect(await key({ ...first, name: 'other' })).not.toBe(original)
    const other = join(cfg.sim.cacheDir, 'other-base.json')
    await writeFile(other, `${await readFile(cfg.sim.snapshot, 'utf8')}\n`)
    expect(await key(first, { ...cfg, sim: { ...cfg.sim, snapshot: other } })).not.toBe(original)
  })

  test('a worker started from the snapshot holds what setup wrote, accounts and contracts included', async () => {
    const cfg = await config()
    const prepared = await prepareSimSetup(
      {
        name: 'state',
        wasm: [storage],
        async setup(worker) {
          const admin = await worker.createAccount('admin')
          await admin.setBalance(12_5000000n)
          const contract = await admin.deploy(storage)
          await admin.call(contract, 'put_persist', { key: 1, val: 7 })
          return { admin, contract }
        },
      },
      cfg,
    )
    expect(prepared.result).toMatchObject({ admin: { name: 'admin' }, contract: { id: expect.stringMatching(/^C/) } })
    const worker = await Worker.init({ config: cfg, snapshot: prepared.snapshot })
    try {
      const { contract } = prepared.result as { contract: { id: string } }
      expect(await worker.contract(contract.id).view('get_persist', { key: 1 })).toBe(7)
    } finally {
      await worker.tearDown()
    }
  })

  test('setup may deploy only the Wasm the suite lists, so the key covers it', async () => {
    const cfg = await config()
    const suite: SuiteDefinition<undefined> = {
      name: 'unlisted',
      wasm: [storage],
      async setup(worker) {
        const admin = await worker.createAccount('admin')
        await admin.deploy(addI32)
      },
    }
    await expect(prepareSimSetup(suite, cfg)).rejects.toThrow(/does not list in `wasm`/)
  })
})
