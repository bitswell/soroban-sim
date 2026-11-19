import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheKey, readEntry, writeEntry, type StoredSetup } from './cache.ts'
import { SEED, type Config } from './config.ts'
import { ACCOUNTS, ADMIN, ADOPT, DEPLOYS, MARKER } from './internal.ts'
import { toPath } from './paths.ts'
import { Worker } from './worker.ts'

export interface SuiteDefinition<S> {
  /** Names the suite in messages and cache entries. */
  name: string
  /** The Wasm files setup deploys: their contents are part of the cache key, and setup may deploy no others. */
  wasm?: readonly (string | URL)[]
  /**
   * Files besides the Wasm whose contents setup depends on (helper modules
   * it imports, data it reads): the cache key covers setup's own source
   * only, so list them here for a change to them to rerun it.
   */
  cacheFiles?: readonly (string | URL)[]
  /**
   * Creates accounts, deploys, writes; returns what the tests need. The
   * result must be JSON values, accounts and contracts: each test gets its
   * own copy, with the accounts and contracts on its own network.
   */
  setup: (worker: Worker) => Promise<S>
}

export type AnySuite = SuiteDefinition<unknown>

/** A test's worker and setup, and how to give them back. */
export interface Lease<S> {
  worker: Worker
  setup: S
  release(): Promise<void>
}

export interface Environment<S> {
  acquire(testId: string): Promise<Lease<S>>
}

export function environmentFor<S>(def: SuiteDefinition<S>, config: Config): Environment<S> {
  return config.environment === 'local' ? localEnvironment(def, config) : simEnvironment(def, config)
}

async function loadWasm(def: AnySuite): Promise<Buffer[]> {
  return Promise.all((def.wasm ?? []).map((file) => readFile(toPath(file))))
}

const hashes = (wasm: Buffer[]) => new Set(wasm.map((code) => createHash('sha256').update(code).digest('hex')))

/** Runs setup on `worker` and returns its result as stored: JSON, with markers for accounts and contracts. */
async function runSetup(def: AnySuite, worker: Worker, wasm: Buffer[]): Promise<StoredSetup> {
  worker[DEPLOYS] = hashes(wasm)
  try {
    const value = await def.setup(worker)
    const text = value === undefined ? undefined : JSON.stringify(value)
    if (value !== undefined && text === undefined) throw new Error(`${def.name}: setup must return JSON values, accounts and contracts`)
    return { result: text === undefined ? undefined : JSON.parse(text), accounts: worker[ACCOUNTS]() }
  } finally {
    worker[DEPLOYS] = undefined
  }
}

/** A stored setup result with its accounts and contracts bound to `worker`. */
function revive<S>(stored: StoredSetup, worker: Worker): S {
  worker[ADOPT](stored.accounts)
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (value === null || typeof value !== 'object') return value
    const marked = value as Record<string, unknown>
    if (marked[MARKER] === 'account') return worker.account(marked.name as string)
    if (marked[MARKER] === 'contract') return worker.contract(marked.id as string, (marked.wasmHash as string | null) ?? undefined)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
  }
  return walk(stored.result) as S
}

// --- soroban-sim ---

export interface PreparedSetup extends StoredSetup {
  /** The snapshot each test's server starts from. */
  snapshot: string
  /** True when the snapshot came from the cache and setup did not run. */
  cached: boolean
}

let scratch: string | undefined

function scratchDir(): string {
  if (!scratch) {
    const dir = mkdtempSync(join(tmpdir(), 'soroban-sim-vitest-'))
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
    scratch = dir
  }
  return scratch
}

/**
 * Runs the suite's setup once on a fresh `soroban-sim serve` and exports the
 * result with `fork_exportSnapshot`, or takes that snapshot from the cache.
 */
export async function prepareSimSetup(def: AnySuite, config: Config, loaded?: Buffer[]): Promise<PreparedSetup> {
  const wasm = loaded ?? (await loadWasm(def))
  const key = await cacheKey(def, config, wasm)
  const { cache, cacheDir } = config.sim
  if (cache === 'on') {
    const hit = await readEntry(cacheDir, key)
    if (hit) return { ...hit, cached: true }
  }

  const worker = await Worker.init({ config: { ...config, environment: 'soroban-sim' }, snapshot: config.sim.snapshot, seed: SEED })
  let stored: StoredSetup
  let snapshot: unknown
  try {
    stored = await runSetup(def, worker, wasm)
    snapshot = await worker[ADMIN]('exportSnapshot', 'fork_exportSnapshot', {})
  } finally {
    await worker.tearDown()
  }
  const text = JSON.stringify(snapshot)
  if (cache === 'on') return { ...(await writeEntry(cacheDir, key, text, stored)), cached: false }
  const file = join(scratchDir(), `${def.name.replace(/[^\w.-]+/g, '_')}-${process.pid}-${Date.now()}.json`)
  await writeFile(file, text)
  return { ...stored, snapshot: file, cached: false }
}

function simEnvironment<S>(def: SuiteDefinition<S>, config: Config): Environment<S> {
  let prepared: Promise<PreparedSetup> | undefined
  return {
    async acquire() {
      // Setup runs (or comes from the cache) once, for the first test to ask.
      prepared ??= prepareSimSetup(def as AnySuite, config)
      const setup = await prepared
      const worker = await Worker.init({ config, snapshot: setup.snapshot, seed: SEED })
      try {
        return { worker, setup: revive<S>(setup, worker), release: () => worker.tearDown() }
      } catch (e) {
        await worker.tearDown()
        throw e
      }
    },
  }
}

// --- local network ---

const runNonce = `${process.pid}-${Date.now()}`

function localEnvironment<S>(def: SuiteDefinition<S>, config: Config): Environment<S> {
  let wasm: Promise<Buffer[]> | undefined
  let attempt = 0
  return {
    async acquire(testId) {
      wasm ??= loadWasm(def as AnySuite)
      // A local network keeps every account, so each test, and each run,
      // derives keys of its own: tests share no accounts and no contracts.
      const seed = `${SEED}/local/${runNonce}/${def.name}/${testId}/${attempt++}`
      const worker = await Worker.init({ config, seed })
      const stored = await runSetup(def as AnySuite, worker, await wasm)
      return { worker, setup: revive<S>(stored, worker), release: () => worker.tearDown() }
    },
  }
}
