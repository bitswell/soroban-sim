// The one-line embed: <script type="module" src="soroban-sign-dialog.js">.
// Registers <soroban-sign-dialog> and exposes `globalThis.SorobanSignDialog`
// for pages that call it from classic scripts.
import * as api from './index.js';

export * from './index.js';

api.define();
globalThis.SorobanSignDialog ??= api;
