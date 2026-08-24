/**
 * Worker-side XDR decoding for display. All `@stellar/stellar-sdk` usage lives
 * here so the (large) SDK stays off the main thread — the main thread only ever
 * receives already-decoded strings.
 */
import { Address, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";

function hex(bytes: Uint8Array, from = 0, to = bytes.length): string {
  let s = "";
  for (let i = from; i < to; i += 1) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

/**
 * Access a js-xdr arm field that this SDK build exposes as either a method or a
 * bare property (v17 decodes some unions to plain structs).
 */
function field(obj: unknown, name: string): unknown {
  const rec = obj as Record<string, unknown>;
  const v = rec?.[name];
  return typeof v === "function" ? (v as () => unknown).call(obj) : v;
}

export interface KeyLabel {
  kind: string;
  detail: string;
  label: string;
}

/**
 * Decode a LedgerKey XDR blob into a display label. Arm names are read from the
 * reliable `.type` string; per-arm detail is extracted defensively, falling back
 * to fixed XDR byte offsets (the layout is invariant per arm) when the SDK's
 * accessor shape differs.
 */
export function ledgerKeyLabel(bytes: Uint8Array): KeyLabel {
  let arm = "unknown";
  let lk: unknown;
  try {
    lk = xdr.LedgerKey.fromXdr(bytes as unknown as Buffer);
    arm = (lk as { type?: string }).type ?? "unknown";
  } catch {
    return { kind: "Unknown", detail: hex(bytes, 0, 4), label: "Unknown" };
  }
  const v = (lk as { value?: unknown }).value;

  const mk = (kind: string, detail: string): KeyLabel => ({
    kind,
    detail,
    label: detail ? `${kind} ${detail}` : kind,
  });

  try {
    switch (arm) {
      case "contractData": {
        const contract = field(v, "contract");
        const addr = Address.fromScAddress(
          contract as Parameters<typeof Address.fromScAddress>[0],
        ).toString();
        const dur = field(v, "durability") as { name?: string } | string;
        const durName = typeof dur === "string" ? dur : (dur?.name ?? "");
        return mk("ContractData", `${addr.slice(0, 4)}…${addr.slice(-4)} · ${durName}`);
      }
      case "contractCode":
        // LedgerKeyContractCode = discriminant(4) + Hash(32).
        return mk("ContractCode", hex(bytes, 4, 36).slice(0, 8));
      case "account":
        // LedgerKeyAccount = discriminant(4) + PublicKey{type(4)+ed25519(32)}.
        return mk(
          "Account",
          `${StrKey.encodeEd25519PublicKey(bytes.slice(8, 40) as unknown as Buffer).slice(0, 4)}…`,
        );
      case "trustline":
        return mk("Trustline", "");
      case "ttl":
        return mk("Ttl", hex(bytes, bytes.length - 4));
      case "configSetting": {
        const id = field(v, "configSettingId") as { name?: string } | string;
        const name = typeof id === "string" ? id : (id?.name ?? "");
        return mk("ConfigSetting", name.replace(/^configSetting/, ""));
      }
      default:
        return mk(arm.charAt(0).toUpperCase() + arm.slice(1), "");
    }
  } catch {
    return mk(arm.charAt(0).toUpperCase() + arm.slice(1), hex(bytes, bytes.length - 4));
  }
}

export interface ScValLabel {
  type: string;
  display: string;
}

/** Decode a return-value ScVal XDR blob into a type tag + a printable value. */
export function scValLabel(bytes: Uint8Array): ScValLabel {
  try {
    const sv = xdr.ScVal.fromXdr(bytes as unknown as Buffer);
    const rawType = (sv as { type?: string }).type ?? "ScVal";
    const type = rawType.replace(/^scv/, "");
    const native = scValToNative(sv);
    return { type, display: renderNative(native) };
  } catch (e) {
    return { type: "ScVal", display: `undecodable (${(e as Error).message})` };
  }
}

function renderNative(v: unknown): string {
  if (v === null || v === undefined) return "void";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return `0x${hex(v).slice(0, 32)}${v.length > 16 ? "…" : ""}`;
  try {
    return JSON.stringify(v, (_k, val) =>
      typeof val === "bigint" ? val.toString() : val,
    );
  } catch {
    return String(v);
  }
}

// --- footprint / resources (SorobanTransactionData) ------------------------

/**
 * Read the discriminant name of a js-xdr enum member OR union instance. Enum
 * members expose `.name` directly; unions expose their discriminant via
 * `.switch()` (universal) or, on some builds, a bare `.type` getter. Returns ""
 * when no name can be found (callers fall back to a coarser label).
 */
function tagName(u: unknown): string {
  if (u == null) return "";
  const rec = u as Record<string, unknown>;
  // Enum member (e.g. ContractEventType.contract): carries `.name` directly.
  if (typeof rec.name === "string") return rec.name;
  // Union: `.switch()` returns the discriminant enum member.
  const sw = field(u, "switch");
  if (sw && typeof (sw as { name?: unknown }).name === "string") {
    return String((sw as { name: string }).name);
  }
  if (typeof sw === "string") return sw;
  // Some unions expose the discriminant as a bare `.type` getter.
  const t = rec.type;
  if (t && typeof (t as { name?: unknown }).name === "string") {
    return String((t as { name: string }).name);
  }
  if (typeof t === "string") return t;
  return "";
}

/** Re-encode a decoded js-xdr value back to its raw XDR bytes. */
function toXdrBytes(x: unknown): Uint8Array {
  const out = (x as { toXDR?: (f?: string) => Uint8Array; toXdr?: (f?: string) => Uint8Array });
  const fn = out.toXDR ?? out.toXdr;
  return fn ? (fn.call(x) as Uint8Array) : new Uint8Array();
}

export interface FootprintLabels {
  /** Read-only footprint: LedgerKeys the run read but did not modify. */
  readOnly: KeyLabel[];
  /** Read-write footprint: LedgerKeys the run may have modified. */
  readWrite: KeyLabel[];
  /** Adjusted CPU instructions declared in the transaction resources. */
  instructions: number;
  /** Disk read bytes declared in the transaction resources. */
  readBytes: number;
  /** Write bytes declared in the transaction resources. */
  writeBytes: number;
  /** Resource fee in stroops (string to preserve the i64 range). */
  resourceFee: string;
}

/**
 * Decode a `SorobanTransactionData` XDR blob into footprint key labels plus the
 * declared resources and resource fee. Returns `undefined` if decoding fails so
 * a display glitch degrades gracefully rather than throwing in the worker.
 */
export function footprintLabels(txDataXdr: Uint8Array): FootprintLabels | undefined {
  try {
    const td = xdr.SorobanTransactionData.fromXdr(txDataXdr as unknown as Buffer);
    const res = field(td, "resources");
    const fp = field(res, "footprint");
    const ro = (field(fp, "readOnly") as unknown[]) ?? [];
    const rw = (field(fp, "readWrite") as unknown[]) ?? [];
    const num = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v === "bigint") return Number(v);
      if (v && typeof (v as { toString?: () => string }).toString === "function") {
        const n = Number((v as { toString: () => string }).toString());
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    };
    // Protocol 23 renamed readBytes -> diskReadBytes; probe both.
    const readBytes = num(field(res, "diskReadBytes") ?? field(res, "readBytes"));
    const fee = field(td, "resourceFee");
    return {
      readOnly: ro.map((k) => ledgerKeyLabel(toXdrBytes(k))),
      readWrite: rw.map((k) => ledgerKeyLabel(toXdrBytes(k))),
      instructions: num(field(res, "instructions")),
      readBytes,
      writeBytes: num(field(res, "writeBytes")),
      resourceFee:
        fee && typeof (fee as { toString?: () => string }).toString === "function"
          ? (fee as { toString: () => string }).toString()
          : "0",
    };
  } catch {
    return undefined;
  }
}

// --- contract events -------------------------------------------------------

export interface ContractEventLabel {
  /** Event type: contract | system | diagnostic. */
  type: string;
  /** Emitting contract (C… address), when present. */
  contractId?: string;
  /** Topic ScVals, decoded to short printable form. */
  topics: string[];
  /** Data ScVal, decoded to short printable form. */
  data: string;
}

/** Summarize a `ContractEvent` XDR blob (type + topics + data) for display. */
export function contractEventLabel(bytes: Uint8Array): ContractEventLabel {
  try {
    const ev = xdr.ContractEvent.fromXdr(bytes as unknown as Buffer);
    const type = tagName(field(ev, "type")) || "contract";
    let contractId: string | undefined;
    const cid = field(ev, "contractId");
    if (cid) {
      try {
        contractId = StrKey.encodeContract(toXdrBytes(cid).slice(0, 32) as unknown as Buffer);
        // contractId is a Hash (raw 32 bytes), not XDR-wrapped: prefer the raw value.
        if (cid instanceof Uint8Array) {
          contractId = StrKey.encodeContract(cid as unknown as Buffer);
        }
      } catch {
        contractId = undefined;
      }
    }
    const body = field(ev, "body");
    const v0 = field(body, "v0") ?? body;
    const topicsRaw = (field(v0, "topics") as unknown[]) ?? [];
    const topics = topicsRaw.map((t) => {
      const l = scValLabel(toXdrBytes(t));
      return l.display;
    });
    const dataRaw = field(v0, "data");
    const data = dataRaw ? scValLabel(toXdrBytes(dataRaw)).display : "void";
    return { type, contractId, topics, data };
  } catch (e) {
    return { type: "unknown", topics: [], data: `undecodable (${(e as Error).message})` };
  }
}

// --- authorization entries -------------------------------------------------

export interface AuthLabel {
  /** Credentials kind: sourceAccount | address (short form). */
  credentials: string;
  /** Invoked contract (C… address), when the root invocation is a contract fn. */
  contract?: string;
  /** Invoked function name, when the root invocation is a contract fn. */
  fn?: string;
  /** Count of sub-invocations under the root. */
  subInvocations: number;
}

/** Summarize a `SorobanAuthorizationEntry` XDR blob (credentials + invoked fn). */
export function authLabel(bytes: Uint8Array): AuthLabel {
  try {
    const ae = xdr.SorobanAuthorizationEntry.fromXdr(bytes as unknown as Buffer);
    const cred = field(ae, "credentials");
    const credArm = tagName(cred);
    const credentials = credArm.replace(/^sorobanCredentials/, "") || credArm || "unknown";

    const root = field(ae, "rootInvocation");
    const fnUnion = field(root, "function");
    const fnArm = tagName(fnUnion);
    const subs = (field(root, "subInvocations") as unknown[]) ?? [];

    let contract: string | undefined;
    let fn: string | undefined;
    // sorobanAuthorizedFunctionTypeContractFn -> InvokeContractArgs
    const invoke =
      field(fnUnion, "contractFn") ?? field(fnUnion, "invokeContract");
    if (invoke) {
      try {
        const addr = field(invoke, "contractAddress");
        if (addr) {
          contract = Address.fromScAddress(
            addr as Parameters<typeof Address.fromScAddress>[0],
          ).toString();
        }
      } catch {
        contract = undefined;
      }
      const name = field(invoke, "functionName");
      if (name instanceof Uint8Array) fn = new TextDecoder().decode(name);
      else if (typeof name === "string") fn = name;
      else if (name != null) fn = String(name);
    } else if (fnArm) {
      fn = fnArm.replace(/^sorobanAuthorizedFunctionType/, "");
    }

    return {
      credentials,
      contract,
      fn,
      subInvocations: subs.length,
    };
  } catch (e) {
    return { credentials: `undecodable (${(e as Error).message})`, subInvocations: 0 };
  }
}
