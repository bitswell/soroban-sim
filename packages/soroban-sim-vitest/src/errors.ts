import { humanizeEvents, type contract, type xdr } from '@stellar/stellar-sdk'

/** A sandbox control (setting a balance, moving time, patching storage) that a local network cannot provide. */
export class SandboxOnlyError extends Error {
  readonly capability: string

  constructor(capability: string) {
    super(
      `${capability} needs soroban-sim: a local network has no way to do it. ` +
        'Skip the test where the suite\'s `sandbox` (or `worker.sandbox`) is false, ' +
        'for example with test.skipIf(!sandbox).',
    )
    this.name = 'SandboxOnlyError'
    this.capability = capability
  }
}

/** A contract call the host refused: a trap, failed authorization, missing entry or exhausted budget. */
export class InvocationError extends Error {
  /** The contract called, `C…`. */
  readonly contract: string
  readonly method: string
  /** The host's error, such as `Error(WasmVm, InvalidAction)` or `Error(Contract, #10)`. */
  readonly hostError: string
  /** The diagnostic events of the failed call, as the RPC returned them. */
  readonly events: xdr.DiagnosticEvent[]

  constructor(target: CallTarget, hostError: string, events: xdr.DiagnosticEvent[], detail: string) {
    super(`${target.method} on ${target.contract} failed: ${hostError}${detail ? `\n\n${detail}` : ''}`)
    this.name = 'InvocationError'
    this.contract = target.contract
    this.method = target.method
    this.hostError = hostError
    this.events = events
  }
}

/** The contract returned one of its own errors (`Error(Contract, #code)`). */
export class ContractError extends InvocationError {
  /** The contract's error code. */
  readonly code: number
  /**
   * The code's name in the called contract's error enum. Undefined when its
   * spec has none, or when a contract it called raised the error: the code
   * is then from that contract's enum.
   */
  readonly errorName: string | undefined

  constructor(target: CallTarget, code: number, errorName: string | undefined, events: xdr.DiagnosticEvent[], detail: string) {
    super(target, `Error(Contract, #${code})${errorName ? ` ${errorName}` : ''}`, events, detail)
    this.name = 'ContractError'
    this.code = code
    this.errorName = errorName
  }
}

/** The network refused or failed a transaction for a reason other than the contract call (a sequence number, a fee). */
export class TransactionError extends Error {
  /** `ERROR` (refused by sendTransaction) or `FAILED` (applied and failed). */
  readonly status: string
  /** The transaction result code, such as `txBadSeq`. */
  readonly result: string | undefined

  constructor(what: string, status: string, result: string | undefined) {
    super(`${what}: ${status}${result ? ` (${result})` : ''}`)
    this.name = 'TransactionError'
    this.status = status
    this.result = result
  }
}

export interface CallTarget {
  contract: string
  method: string
  spec?: contract.Spec | null
}

const HOST_ERROR = /Error\((\w+), ([^)]+)\)/

/**
 * The typed error for a failed call, from the simulation's error text (which
 * carries the host error and its event log) or, for a transaction that
 * failed on the ledger, from its diagnostic events.
 */
export function invocationError(target: CallTarget, text: string, events: xdr.DiagnosticEvent[]): InvocationError {
  const readable = text.trim() || describeEvents(events)
  const found = HOST_ERROR.exec(text) ?? errorInEvents(events)
  if (!found) return new InvocationError(target, text.split('\n')[0] || 'unknown host error', events, readable)
  const [, type, value] = found
  const code = /^#(\d+)$/.exec(value)
  if (type === 'Contract' && code) {
    const n = Number(code[1])
    return new ContractError(target, n, raisedByTarget(events) ? errorName(target.spec, n) : undefined, events, readable)
  }
  return new InvocationError(target, `Error(${type}, ${value})`, events, readable)
}

function errorName(spec: contract.Spec | null | undefined, code: number): string | undefined {
  try {
    return spec?.errorCases().find((c) => c.value === code)?.name.toString()
  } catch {
    return undefined
  }
}

type Humanized = { type?: string; topics?: unknown[]; contractId?: string; data?: unknown }

function humanized(events: xdr.DiagnosticEvent[]): Humanized[] {
  try {
    return humanizeEvents(events) as Humanized[]
  } catch {
    return []
  }
}

/**
 * True when the called contract itself raised the error. The host logs
 * `fn_call` when a contract call starts and `fn_return` when it returns, so a
 * failure inside the called contract leaves that one call unreturned, and a
 * failure in a contract it called leaves more.
 */
function raisedByTarget(events: xdr.DiagnosticEvent[]): boolean {
  const marks = humanized(events)
    .filter((e) => e.type === 'diagnostic')
    .map((e) => e.topics?.[0])
  return marks.filter((m) => m === 'fn_call').length - marks.filter((m) => m === 'fn_return').length === 1
}

/** The `error` diagnostic event's code, as `Error(Type, value)` parts. */
function errorInEvents(events: xdr.DiagnosticEvent[]): RegExpExecArray | null {
  for (const e of humanized(events)) {
    const [topic, err] = e.topics ?? []
    if (topic !== 'error' || !err || typeof err !== 'object') continue
    const { type, code } = err as { type?: string; code?: number | string }
    if (type === undefined || code === undefined) continue
    const name = type.charAt(0).toUpperCase() + type.slice(1)
    return HOST_ERROR.exec(`Error(${name}, ${type === 'contract' ? `#${code}` : code})`)
  }
  return null
}

function describeEvents(events: xdr.DiagnosticEvent[]): string {
  const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
  return humanized(events)
    .map((e, i) => `${i}: ${e.contractId ? `contract:${e.contractId}, ` : ''}topics:${json(e.topics)}, data:${json(e.data)}`)
    .join('\n')
}
