#!/usr/bin/env node
// Size budgets, measured on dist/ at brotli quality 11 (what a server with
// precompressed .br files sends). Exits non-zero over budget.
//
//   tree view: the one-line embed, which holds the whole core     <= 20 KB
//   engine:    engine JS + worker + one reactor build, per protocol <= 600 KB
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const { BUILDS } = await import('../src/preview/soroban-sim-preview.js');
const KB = 1000;
const br = (f) => brotliCompressSync(readFileSync(join(dist, f)), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const raw = (f) => readFileSync(join(dist, f)).length;

const rows = [];
let failed = false;
const check = (name, files, budget) => {
  const missing = files.filter((f) => !existsSync(join(dist, f)));
  if (missing.length) { console.error(`missing ${missing.join(', ')}: run \`pnpm build\``); failed = true; return; }
  const size = files.reduce((n, f) => n + br(f), 0);
  const over = size > budget;
  failed ||= over;
  rows.push([name, files.reduce((n, f) => n + raw(f), 0), size, budget, over ? 'OVER' : 'ok']);
};

check('tree view (soroban-sign-dialog.js)', ['soroban-sign-dialog.js'], 20 * KB);
for (const [p, b] of Object.entries(BUILDS)) {
  check(`engine, protocol ${p}`, ['preview/soroban-sim-preview.js', 'preview/worker.js', `preview/${b.wasm}`], 600 * KB);
}
check('React wrapper (react.js, beside the core)', ['react.js'], 2 * KB);

const pad = (s, n, right) => (right ? String(s).padStart(n) : String(s).padEnd(n));
console.log(`${pad('artifact', 44)} ${pad('raw', 10, 1)} ${pad('brotli', 10, 1)} ${pad('budget', 10, 1)}`);
for (const [name, r, b, budget, verdict] of rows) console.log(`${pad(name, 44)} ${pad(r, 10, 1)} ${pad(b, 10, 1)} ${pad(budget, 10, 1)}  ${verdict}`);
if (failed) process.exit(1);
