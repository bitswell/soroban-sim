#!/usr/bin/env node
// Static server for the demo and the browser tests: serves the package
// directory, sends a precompressed .br sibling when the client accepts it,
// and puts /demo/ under a strict Content-Security-Policy (no inline script
// or style) to show the dialog needs none.
//
//   node scripts/serve.mjs [port]     then open http://127.0.0.1:<port>/demo/
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.argv[2] ?? process.env.PORT ?? 4178);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const DEMO_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; worker-src 'self'; connect-src 'self' https://soroban-testnet.stellar.org; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!existsSync(path)) { res.writeHead(404).end('not found'); return; }
  const headers = { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache', vary: 'accept-encoding' };
  if (url.pathname.startsWith('/demo/')) headers['content-security-policy'] = DEMO_CSP;
  let body = readFileSync(path);
  if (/\bbr\b/.test(req.headers['accept-encoding'] ?? '') && existsSync(`${path}.br`)) {
    body = readFileSync(`${path}.br`);
    headers['content-encoding'] = 'br';
  }
  res.writeHead(200, headers).end(body);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/demo/`));
