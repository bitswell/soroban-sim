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
   * spec has none, or when a contract it called raised the error and it
   * passed through: the code is then from that contract's enum.
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
  const logged = loggedErrors(events)
  const found = HOST_ERROR.exec(text) ?? HOST_ERROR.exec(logged.at(-1)?.error ?? '')
  if (!found) return new InvocationError(target, text.split('\n')[0] || 'unknown host error', events, readable)
  const [, type, value] = found
  const code = /^#(\d+)$/.exec(value)
  if (type === 'Contract' && code) {
    const n = Number(code[1])
    // The contract that raises an error logs it first; its callers log it again as it passes through them.
    const raisedIn = logged.find((e) => e.error === found[0])?.contractId
    return new ContractError(target, n, raisedIn === target.contract ? errorName(target.spec, n) : undefined, events, readable)
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

/** The host errors in the diagnostic `error` events, oldest first, each with the contract that logged it. */
function loggedErrors(events: xdr.DiagnosticEvent[]): { error: string; contractId: string | undefined }[] {
  return humanized(events).flatMap((e) => {
    const [topic, err] = e.topics ?? []
    if (e.type !== 'diagnostic' || topic !== 'error' || !err || typeof err !== 'object') return []
    const { type, code } = err as { type?: string; code?: number | string }
    if (type === undefined || code === undefined) return []
    const name = type.charAt(0).toUpperCase() + type.slice(1)
    return [{ error: `Error(${name}, ${type === 'contract' ? `#${code}` : code})`, contractId: e.contractId }]
  })
}

function describeEvents(events: xdr.DiagnosticEvent[]): string {
  const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
  return humanized(events)
    .map((e, i) => `${i}: ${e.contractId ? `contract:${e.contractId}, ` : ''}topics:${json(e.topics)}, data:${json(e.data)}`)
    .join('\n')
}
