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
