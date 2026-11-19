import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, rename, rm, mkdir, writeFile, access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { SEED, type Config } from './config.ts'
import type { AnySuite } from './environments.ts'
import { toPath } from './paths.ts'
import { FUNDING_XLM } from './worker.ts'

const KEY_FORMAT = 'soroban-sim-vitest/cache/2'

/** What setup produced besides the snapshot: its result as JSON, and the accounts it created. */
export interface StoredSetup {
  result: unknown
  accounts: string[]
}

export interface CacheEntry extends StoredSetup {
  snapshot: string
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

/**
 * The key of a suite's setup snapshot: a hash of everything that decides it.
 * `testFile` is the file that defines the suite, for the values and helpers
 * setup takes from it.
 */
export async function cacheKey(def: AnySuite, config: Config, wasm: readonly Buffer[], testFile?: string): Promise<string> {
  const { snapshot, bin } = config.sim
  const files = await Promise.all((def.cacheFiles ?? []).map(async (f) => sha256(await readFile(toPath(f)))))
  const material = {
    format: KEY_FORMAT,
    suite: def.name,
    setup: def.setup.toString(),
    testFile: testFile === undefined ? null : sha256(await readFile(testFile)),
    seed: SEED,
    funding: FUNDING_XLM,
    wasm: wasm.map((code) => sha256(code)).sort(),
    files,
    binary: await binaryIdentity(bin),
    base: { snapshot: sha256(await readFile(snapshot)) },
  }
  return sha256(JSON.stringify(material)).slice(0, 32)
}

const identities = new Map<string, Promise<{ version: string; sha256: string }>>()

/** `soroban-sim --version` and a hash of the binary itself, since a local build keeps its version. */
export function binaryIdentity(bin: string): Promise<{ version: string; sha256: string }> {
  let found = identities.get(bin)
  if (!found) {
    found = (async () => {
      const file = await which(bin)
      const [{ stdout }, bytes] = await Promise.all([promisify(execFile)(file, ['--version']), readFile(file)])
      return { version: stdout.trim(), sha256: sha256(bytes) }
    })()
    identities.set(bin, found)
  }
  return found
}

async function which(bin: string): Promise<string> {
  if (bin.includes('/') || bin.includes('\\')) return bin
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, bin)
    try {
      await access(candidate)
      return candidate
    } catch {
      // not in this directory
    }
  }
  throw new Error(`${bin} is not on PATH; build it (cargo build --release -p soroban-sim-cli) and set SOROBAN_SIM_BIN to it`)
}

export async function readEntry(dir: string, key: string): Promise<CacheEntry | undefined> {
  const entry = join(dir, key)
  try {
    const setup = JSON.parse(await readFile(join(entry, 'setup.json'), 'utf8')) as StoredSetup
    if (!Array.isArray(setup.accounts)) return undefined
    await access(join(entry, 'snapshot.json'))
    return { snapshot: join(entry, 'snapshot.json'), result: setup.result, accounts: setup.accounts }
  } catch {
    return undefined
  }
}

const occupied = (e: unknown) => ['EEXIST', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')

/**
 * Stores a setup's snapshot, result and accounts under `key` and returns
 * the entry now there, as read back from disk: this worker's, or the one
 * another worker stored first (all of it). The entry is written aside and
 * renamed into place, so a reader sees all of it or none.
 */
export async function writeEntry(dir: string, key: string, snapshot: string, stored: StoredSetup): Promise<CacheEntry> {
  const staging = join(dir, `.staging-${randomBytes(6).toString('hex')}`)
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'snapshot.json'), snapshot)
  await writeFile(join(staging, 'setup.json'), JSON.stringify({ result: stored.result, accounts: stored.accounts }))
  const entry = join(dir, key)
  try {
    await rename(staging, entry).catch((e) => {
      if (!occupied(e)) throw e
    })
    const installed = await readEntry(dir, key)
    if (!installed) {
      throw new Error(
        `the cached setup ${entry} cannot be read, and is not replaced: ` +
          `clear the cache (delete ${dir}, or call clearCache) and run again`,
      )
    }
    return installed
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Deletes every cached setup snapshot under `dir`. */
export async function clearCache(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
