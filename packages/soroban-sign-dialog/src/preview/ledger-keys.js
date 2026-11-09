// Base64 LedgerKey XDR for the few keys the engine asks for itself, before
// the reactor names them: network config, nonces, and account adapters'
// storage.
import { toB64 } from '../xdr.js';

const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const i64be = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(n)); return b; };
export const cat = (...p) => { const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

/** ScVal XDR: Symbol, U32, Vec. */
export const xSym = (s) => { const b = new TextEncoder().encode(s); return cat(be32(15), be32(b.length), b, new Uint8Array((4 - (b.length % 4)) % 4)); };
export const xU32 = (n) => cat(be32(3), be32(n));
export const xVec = (...items) => cat(be32(16), be32(1), be32(items.length), ...items);

/** LedgerKey::ContractData of contract `id` (32 bytes) under an ScVal key. */
export const contractDataKey = (id, scvalKey, persistent = true) => toB64(cat(be32(6), be32(1), id, scvalKey, be32(persistent ? 1 : 0)));
export const instanceKey = (id) => contractDataKey(id, be32(20));

const xAddress = (a) => (a.kind === 'contract' ? cat(be32(1), a.key) : cat(be32(0), be32(0), a.key));

/** LedgerKey of an address credential's nonce: temporary contract data. */
export const nonceKey = (address, nonce) => toB64(cat(be32(6), xAddress(address), be32(21), i64be(nonce), be32(0)));

/** Whether LedgerKey bytes are a nonce key (any address). */
export function isNonceKey(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 48 || v.getUint32(0) !== 6) return false;
  const at = v.getUint32(4);
  const o = at === 1 ? 40 : at === 0 ? 44 : -1;
  return o > 0 && b.length >= o + 4 && v.getUint32(o) === 21;
}

// The settings soroban-simulation reads to build the network config (the
// facade's OPEN_SETTINGS): ids 0-10, 12 and 15. A build that reads more asks
// for them through needs-state.
const CONFIG_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15];
export const CONFIG_KEYS = CONFIG_IDS.map((id) => toB64(cat(be32(8), be32(id))));
