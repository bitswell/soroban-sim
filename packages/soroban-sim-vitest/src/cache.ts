import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, rename, rm, mkdir, writeFile, access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEED, type Config } from './config.ts'
import { FUNDING_XLM, type AnySuite } from './suite-types.ts'

const KEY_FORMAT = 'soroban-sim-vitest/cache/1'

export interface CacheEntry<S> {
  snapshot: string
  result: S
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

export function toPath(file: string | URL): string {
  return file instanceof URL ? fileURLToPath(file) : file
}

/** The key of a suite's setup snapshot: a hash of everything that decides it. */
export async function cacheKey(def: AnySuite, config: Config, wasm: Record<string, Buffer>): Promise<string> {
  const { snapshot, bin } = config.sim
  const files = await Promise.all((def.cacheFiles ?? []).map(async (f) => sha256(await readFile(toPath(f)))))
  const material = {
    format: KEY_FORMAT,
    suite: def.name,
    setup: def.setup.toString(),
    signers: [...def.signers],
    seed: SEED,
    funding: FUNDING_XLM,
    wasm: Object.keys(wasm)
      .sort()
      .map((name) => [name, sha256(wasm[name])]),
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

export async function readEntry<S>(dir: string, key: string): Promise<CacheEntry<S> | undefined> {
  const entry = join(dir, key)
  try {
    const setup = JSON.parse(await readFile(join(entry, 'setup.json'), 'utf8')) as { result: S }
    await access(join(entry, 'snapshot.json'))
    return { snapshot: join(entry, 'snapshot.json'), result: setup.result }
  } catch {
    return undefined
  }
}

const occupied = (e: unknown) => ['EEXIST', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')

/**
 * Stores a setup's snapshot and result under `key` and returns the entry
 * now there, as read back from disk: this worker's, or the one another
 * worker stored first (snapshot and result both). The entry is written
 * aside and renamed into place, so a reader sees all of it or none. An
 * entry that cannot be read is moved aside and replaced; a readable one is
 * never removed.
 */
export async function writeEntry<S>(dir: string, key: string, snapshot: string, result: S): Promise<CacheEntry<S>> {
  const staging = join(dir, `.staging-${randomBytes(6).toString('hex')}`)
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'snapshot.json'), snapshot)
  await writeFile(join(staging, 'setup.json'), JSON.stringify({ result }))
  const entry = join(dir, key)
  try {
    let placed = false
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!placed) {
        try {
          await rename(staging, entry)
          placed = true
        } catch (e) {
          if (!occupied(e)) throw e
        }
      }
      const installed = await readEntry<S>(dir, key)
      if (installed) return installed
      const aside = `.damaged-${randomBytes(6).toString('hex')}`
      try {
        await rename(entry, join(dir, aside))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
      if (await readEntry(dir, aside)) {
        await rename(join(dir, aside), entry).catch((e) => {
          if (!occupied(e)) throw e
        })
      }
      await rm(join(dir, aside), { recursive: true, force: true })
    }
    throw new Error(`could not store the cached setup ${entry}: the entry there stayed unreadable`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Deletes every cached setup snapshot under `dir`. */
export async function clearCache(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
