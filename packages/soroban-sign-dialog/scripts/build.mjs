#!/usr/bin/env node
// Build the package into dist/:
//
//   dist/soroban-sign-dialog.js   the one-line embed (registers the element)
//   dist/index.js                 the side-effect-free module
//   dist/react.js                 the React wrapper (react stays external)
//   dist/preview/                 the lazy engine, its worker and one reactor
//                                 build per host protocol (+ .br siblings)
//   dist/SHA256SUMS               so a wallet can pin what it serves
//
// --js-only skips the reactors (cargo). Set WASM_OPT to a wasm-opt binary, or
// put one on PATH, to shrink the reactors the way the published sizes assume.
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const root = join(pkg, '..', '..');
const dist = join(pkg, 'dist');
const jsOnly = process.argv.includes('--js-only');

const { BUILDS } = await import(join(pkg, 'src/preview/soroban-sim-preview.js'));

// The engine's table of builds must name the hosts the crate pins.
const manifest = readFileSync(join(root, 'crates/soroban-sim-preview/Cargo.toml'), 'utf8');
for (const [protocol, b] of Object.entries(BUILDS)) {
  const pin = manifest.match(new RegExp(`soroban-env-host-p${protocol} = \\{[^}]*version = "=([^"]+)"`))?.[1];
  if (!pin || b.host !== `soroban-env-host ${pin}`) throw new Error(`BUILDS[${protocol}] says ${b.host}; the crate pins ${pin ?? 'nothing'} for p${protocol}`);
}

if (!jsOnly) rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'preview'), { recursive: true });

const common = { bundle: true, format: 'esm', minify: true, target: 'es2022', legalComments: 'none', logLevel: 'warning' };
await build({ ...common, entryPoints: { 'soroban-sign-dialog': join(pkg, 'src/embed.js'), index: join(pkg, 'src/index.js') }, outdir: dist });
// The wrapper shares dist/index.js rather than bundling a second element.
const shareCore = { name: 'share-core', setup(b) { b.onResolve({ filter: /^\.\/index\.js$/ }, () => ({ path: './index.js', external: true })); } };
await build({ ...common, entryPoints: { react: join(pkg, 'src/react.js') }, outdir: dist, external: ['react'], plugins: [shareCore] });
await build({
  ...common,
  entryPoints: { 'soroban-sim-preview': join(pkg, 'src/preview/soroban-sim-preview.js'), worker: join(pkg, 'src/preview/worker.js') },
  outdir: join(dist, 'preview'),
});

if (!jsOnly) {
  const wasmOpt = process.env.WASM_OPT || (spawnSync('wasm-opt', ['--version']).status === 0 ? 'wasm-opt' : null);
  for (const protocol of Object.keys(BUILDS)) {
    execFileSync('cargo', ['build', '-p', 'soroban-sim-preview', '--release', '--locked', '--target', 'wasm32-wasip1', '--no-default-features', '--features', `p${protocol}`], { cwd: root, stdio: 'inherit' });
    const built = join(root, 'target/wasm32-wasip1/release/soroban_sim_preview.wasm');
    const out = join(dist, 'preview', BUILDS[protocol].wasm);
    if (wasmOpt) {
      // `strip` drops the target_features section, so name the features.
      execFileSync(wasmOpt, ['-O1', '--enable-bulk-memory', '--enable-bulk-memory-opt', '--enable-nontrapping-float-to-int', '--enable-sign-ext',
        '--enable-mutable-globals', '--enable-multivalue', '--enable-reference-types', built, '-o', out], { stdio: 'inherit' });
    } else {
      console.warn(`wasm-opt not found: shipping the p${protocol} reactor unoptimized`);
      copyFileSync(built, out);
    }
  }
}

// Precompressed siblings for servers that send Content-Encoding: br.
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
for (const f of files(dist)) {
  if (!/\.(js|wasm)$/.test(f)) continue;
  writeFileSync(`${f}.br`, brotliCompressSync(readFileSync(f), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
}
const sums = files(dist).filter((f) => /\.(js|wasm)$/.test(f)).sort()
  .map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${relative(dist, f)}`);
writeFileSync(join(dist, 'SHA256SUMS'), sums.join('\n') + '\n');

// The demo's ledger: the captured Perch fixture, shaped for fixtureProvider.
const cap = JSON.parse(readFileSync(join(root, 'crates/soroban-sim-preview/fixtures/perch-capture.json'), 'utf8'));
const A = cap.addresses;
writeFileSync(join(dist, 'demo-fixture.json'), JSON.stringify({
  passphrase: cap.network.passphrase,
  latest: { sequence: cap.network.sequence - 1, protocolVersion: cap.network.protocol, closeTime: cap.network.timestamp - 5 },
  ledger: cap.ledger,
  signer: A.account,
  labels: { [A.account]: 'Your account', [A.shop]: 'Corner Café', [A.payer]: 'Café fee payer', [A.verifier]: 'ed25519 verifier', [A.other]: 'Another address' },
  hints: { [A.account]: { verifier: A.verifier, key: A.appKey, grantId: 1, ruleId: A.spendRuleId } },
  scenarios: cap.scenarios.map((s) => ({ id: s.id, title: s.title, transaction: s.envelope })),
}));
console.log(sums.join('\n'));
if (!existsSync(join(dist, 'preview', BUILDS[29].wasm))) console.warn('no reactor builds in dist/preview (--js-only)');
