import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheKey, readEntry, writeEntry, type StoredSetup } from './cache.ts'
import { SEED, type Config } from './config.ts'
import { attach } from './account.ts'
import type { BindingsClass } from './clients.ts'
import { ACCOUNTS, ADMIN, ADOPT, BINDINGS, DEPLOYS, MARKER } from './internal.ts'
import { RUN_NONCE } from './keys.ts'
import { toPath } from './paths.ts'
import { Worker } from './worker.ts'

/** A Wasm file, or a Wasm file with the client generated for it (`stellar contract bindings typescript`). */
export type WasmEntry = string | URL | { file: string | URL; client: BindingsClass<any> }

export interface SuiteDefinition<S> {
  /** Names the suite in messages and cache entries. */
  name: string
  /**
   * The Wasm files setup deploys: their contents are part of the cache key,
   * and setup may deploy no others. A file paired with its generated client
   * makes every client for that code, in setup and in the tests, of that class.
   */
  wasm?: readonly WasmEntry[]
  /**
   * Files besides the Wasm and the test file whose contents setup depends
   * on (helper modules it imports, data it reads): the cache key covers the
   * test file only, so list them here for a change to them to rerun it.
   */
  cacheFiles?: readonly (string | URL)[]
  /**
   * Creates accounts, deploys, writes; returns what the tests need. The
   * result must be JSON values, accounts and contract clients: each test
   * gets its own copy, with the accounts and clients on its own network.
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
  /** `testFile` is the file the test is in, which defines the suite. */
  acquire(testId: string, testFile: string): Promise<Lease<S>>
}

export function environmentFor<S>(def: SuiteDefinition<S>, config: Config): Environment<S> {
  return config.environment === 'local' ? localEnvironment(def, config) : simEnvironment(def, config)
}

const fileOf = (entry: WasmEntry) => (typeof entry === 'string' || entry instanceof URL ? entry : entry.file)

async function loadWasm(def: AnySuite): Promise<Buffer[]> {
  return Promise.all((def.wasm ?? []).map((entry) => readFile(toPath(fileOf(entry)))))
}

const sha256 = (code: Buffer) => createHash('sha256').update(code).digest('hex')
const hashes = (wasm: Buffer[]) => new Set(wasm.map(sha256))

/** Tells `worker` which generated client each of the suite's Wasm files has. */
function pairBindings(def: AnySuite, worker: Worker, wasm: Buffer[]): void {
  ;(def.wasm ?? []).forEach((entry, i) => {
    if (typeof entry === 'object' && !(entry instanceof URL)) worker[BINDINGS].set(sha256(wasm[i]), entry.client)
  })
}

/** Runs setup on `worker` and returns its result as stored: JSON, with markers for accounts and contracts. */
async function runSetup(def: AnySuite, worker: Worker, wasm: Buffer[]): Promise<StoredSetup> {
  worker[DEPLOYS] = hashes(wasm)
  try {
    const value = await def.setup(worker)
    const text = value === undefined ? undefined : JSON.stringify(value)
    if (value !== undefined && text === undefined) throw new Error(`${def.name}: setup must return JSON values, accounts and contract clients`)
    return { result: text === undefined ? undefined : JSON.parse(text), accounts: worker[ACCOUNTS]() }
  } finally {
    worker[DEPLOYS] = undefined
  }
}

/** A stored setup result with its accounts and contract clients bound to `worker`, each client with the same signer. */
async function revive<S>(stored: StoredSetup, worker: Worker): Promise<S> {
  worker[ADOPT](stored.accounts)
  const walk = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(walk))
    if (value === null || typeof value !== 'object') return value
    const marked = value as Record<string, unknown>
    if (marked[MARKER] === 'account') return worker.account(marked.name as string)
    if (marked[MARKER] === 'contract') {
      const signer = marked.signer === null ? undefined : worker.account(marked.signer as string)
      return attach(worker, marked.id as string, undefined, signer, marked.wasmHash as string | null)
    }
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await walk(v)])))
  }
  return (await walk(stored.result)) as S
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
 * `testFile` is the file that defines the suite: its contents are part of
 * the cache key.
 */
export async function prepareSimSetup(def: AnySuite, config: Config, testFile?: string): Promise<PreparedSetup> {
  const wasm = await loadWasm(def)
  const key = await cacheKey(def, config, wasm, testFile)
  const { cache, cacheDir } = config.sim
  if (cache === 'on') {
    const hit = await readEntry(cacheDir, key)
    if (hit) return { ...hit, cached: true }
  }

  const worker = await Worker.init({ config: { ...config, environment: 'soroban-sim' }, snapshot: config.sim.snapshot, seed: SEED })
  pairBindings(def, worker, wasm)
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
  let wasm: Promise<Buffer[]> | undefined
  return {
    async acquire(_testId, testFile) {
      // Setup runs (or comes from the cache) once, for the first test to ask.
      prepared ??= prepareSimSetup(def as AnySuite, config, testFile)
      wasm ??= loadWasm(def as AnySuite)
      const setup = await prepared
      const worker = await Worker.init({ config, snapshot: setup.snapshot, seed: SEED })
      try {
        pairBindings(def as AnySuite, worker, await wasm)
        return { worker, setup: await revive<S>(setup, worker), release: () => worker.tearDown() }
      } catch (e) {
        await worker.tearDown()
        throw e
      }
    },
  }
}

// --- local network ---

function localEnvironment<S>(def: SuiteDefinition<S>, config: Config): Environment<S> {
  let wasm: Promise<Buffer[]> | undefined
  let attempt = 0
  return {
    async acquire(testId) {
      wasm ??= loadWasm(def as AnySuite)
      // A local network keeps every account, so each test, and each run,
      // derives keys of its own: tests share no accounts and no contracts.
      const seed = `${SEED}/local/${RUN_NONCE}/${def.name}/${testId}/${attempt++}`
      const worker = await Worker.init({ config, seed })
      const code = await wasm
      pairBindings(def as AnySuite, worker, code)
      const stored = await runSetup(def as AnySuite, worker, code)
      return { worker, setup: await revive<S>(stored, worker), release: () => worker.tearDown() }
    },
  }
}
