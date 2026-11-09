// @theahaco/soroban-sign-dialog: the element, its decoder and helpers.
// Side-effect free and safe to import during server rendering; call
// `define()` to register <soroban-sign-dialog>, or use `request()`, which
// defines it on first use.
export { SorobanSignDialog, define, request, TAG } from './element.js';
export { STRINGS } from './strings.js';
export {
  XdrError, decodeEnvelope, decodeAuthEntry, decodeEvent, decodeLedgerEntry, decodeLedgerKey, decodeScVal,
  compareAuth, authPayloadHash, transactionHash, nativeAssetContract, networkId, formatAmount, strkeyFor, fromStrkey, NETWORKS,
} from './xdr.js';

export const VERSION = '0.1.0';
