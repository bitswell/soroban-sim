import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rpc } from '@stellar/stellar-sdk'
import { cacheKey, readEntry, toPath, writeEntry } from './cache.ts'
import { SEED, type Config } from './config.ts'
import { rpcCall, startServer } from './server.ts'
import { deriveSigners, type Signers } from './signers.ts'
import { FUNDING_XLM, type SetupContext, type SuiteDefinition, type TestEnv } from './suite-types.ts'

/** A test's environment and how to give it back. */
export interface Lease<E> {
  env: E
  release(): Promise<void>
}

/** One environment's way of handing each test a fresh copy of the suite's setup. */
export interface Environment<N extends string, W extends string, S> {
  acquire(testId: string): Promise<Lease<TestEnv<N, W, S>>>
}

export function environmentFor<N extends string, W extends string, S>(
  def: SuiteDefinition<N, W, S>,
  config: Config,
): Environment<N, W, S> {
  return config.environment === 'local' ? localEnvironment(def, config) : simEnvironment(def, config)
}

async function loadWasm<W extends string>(def: SuiteDefinition<string, W, unknown>): Promise<{ [K in W]: Buffer }> {
  const entries = Object.entries<string | URL>(def.wasm ?? ({} as Record<W, string>))
  const loaded = await Promise.all(entries.map(async ([name, file]) => [name, await readFile(toPath(file))] as const))
  return Object.fromEntries(loaded) as { [K in W]: Buffer }
}

function server(url: string): rpc.Server {
  return new rpc.Server(url, { allowHttp: url.startsWith('http:') })
}

/** Setup's result as the cache would hand it back, so a cached and an uncached run see the same value. */
function throughJson<S>(suite: string, result: S): S {
  if (result === undefined) return result
  const text = JSON.stringify(result)
  if (text === undefined) throw new Error(`${suite}: setup must return a JSON-serializable value`)
  return JSON.parse(text) as S
}

// --- soroban-sim ---

export interface PreparedSetup<S> {
  /** The snapshot each test's server starts from. */
  snapshot: string
  result: S
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
export async function prepareSimSetup<N extends string, W extends string, S>(
  def: SuiteDefinition<N, W, S>,
  config: Config,
  loaded?: { [K in W]: Buffer },
): Promise<PreparedSetup<S>> {
  const wasm = loaded ?? (await loadWasm(def))
  const key = await cacheKey(def, config, wasm)
  const { cache, cacheDir } = config.sim
  if (cache === 'on') {
    const hit = await readEntry<S>(cacheDir, key)
    if (hit) return { ...hit, cached: true }
  }

  const srv = await startServer(config.sim.bin, ['--snapshot', config.sim.snapshot])
  let snapshot: unknown
  let result: S
  try {
    const signers = deriveSigners(SEED, def.signers)
    for (const kp of Object.values<(typeof signers)[N]>(signers)) {
      await rpcCall(srv.url, 'fork_setBalance', { account: kp.publicKey(), xlm: FUNDING_XLM, label: 'signer' })
    }
    const ctx = await context(srv.url, signers, wasm)
    result = throughJson(def.name, await def.setup(ctx))
    snapshot = await rpcCall(srv.url, 'fork_exportSnapshot')
  } finally {
    await srv.stop()
  }
  const text = JSON.stringify(snapshot)
  if (cache === 'on') {
    const entry = await writeEntry(cacheDir, key, text, result)
    return { ...entry, cached: false }
  }
  const file = join(scratchDir(), `${def.name.replace(/[^\w.-]+/g, '_')}-${process.pid}-${Date.now()}.json`)
  await writeFile(file, text)
  return { snapshot: file, result, cached: false }
}

function simEnvironment<N extends string, W extends string, S>(
  def: SuiteDefinition<N, W, S>,
  config: Config,
): Environment<N, W, S> {
  let prepared: Promise<[PreparedSetup<S>, { [K in W]: Buffer }]> | undefined
  const signers = deriveSigners(SEED, def.signers)
  return {
    async acquire() {
      // Setup runs (or comes from the cache) once, for the first test to ask.
      prepared ??= loadWasm(def).then(async (code) => [await prepareSimSetup(def, config, code), code])
      const [setup, code] = await prepared
      const srv = await startServer(config.sim.bin, ['--snapshot', setup.snapshot])
      try {
        const ctx = await context(srv.url, signers, code)
        return { env: { ...ctx, setup: setup.result }, release: () => srv.stop() }
      } catch (e) {
        await srv.stop()
        throw e
      }
    },
  }
}

// --- local network ---

const runNonce = `${process.pid}-${Date.now()}`

function localEnvironment<N extends string, W extends string, S>(
  def: SuiteDefinition<N, W, S>,
  config: Config,
): Environment<N, W, S> {
  let wasm: Promise<{ [K in W]: Buffer }> | undefined
  let attempt = 0
  return {
    async acquire(testId) {
      wasm ??= loadWasm(def)
      // A local network keeps every account, so each test, and each run,
      // derives keys of its own: tests share no keys and no contracts.
      const seed = `${SEED}/local/${runNonce}/${def.name}/${testId}/${attempt++}`
      const signers = deriveSigners(seed, def.signers)
      const { rpcUrl, friendbotUrl } = config.local
      await Promise.all(Object.values<(typeof signers)[N]>(signers).map((kp) => friendbot(friendbotUrl, kp.publicKey())))
      const ctx = await context(rpcUrl, signers, await wasm)
      const result = throughJson(def.name, await def.setup(ctx))
      return { env: { ...ctx, setup: result }, release: async () => {} }
    },
  }
}

async function friendbot(url: string, account: string): Promise<void> {
  let last = ''
  for (let i = 0, delay = 250; i < 8; i++, delay *= 2) {
    try {
      const res = await fetch(`${url}?addr=${encodeURIComponent(account)}`)
      if (res.ok) return
      last = `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`
      if (res.status < 500 && res.status !== 429) break
    } catch (e) {
      last = `${(e as Error).message}; is a local network running? (stellar container start local)`
    }
    await new Promise((r) => setTimeout(r, delay))
  }
  throw new Error(`friendbot ${url} could not fund ${account}: ${last}`)
}

async function context<N extends string, W extends string>(
  rpcUrl: string,
  signers: Signers<N>,
  wasm: { [K in W]: Buffer },
): Promise<SetupContext<N, W>> {
  const client = server(rpcUrl)
  const { passphrase } = await client.getNetwork()
  return { rpcUrl, networkPassphrase: passphrase, rpc: client, signers, wasm }
}
