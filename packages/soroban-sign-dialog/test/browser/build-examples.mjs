// Playwright global setup: bundle each framework example against the built
// package (dist/), the way an app would consume it, into .tmp/examples/.
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(pkg, '.tmp', 'examples');

const self = {
  name: 'self',
  setup(b) {
    b.onResolve({ filter: /^@theahaco\/soroban-sign-dialog(\/react)?$/ }, (a) => ({ path: join(pkg, 'dist', a.path.endsWith('/react') ? 'react.js' : 'index.js') }));
  },
};
const svelte = {
  name: 'svelte',
  setup(b) {
    b.onLoad({ filter: /\.svelte$/ }, (a) => ({ contents: compile(readFileSync(a.path, 'utf8'), { filename: a.path, generate: 'client' }).js.code, loader: 'js' }));
  },
};

const APPS = {
  react19: { entry: 'react/main.jsx' },
  react18: { entry: 'react/main.jsx', alias: { react: 'react18', 'react-dom': 'react-dom18' } },
  vue: { entry: 'vue/main.js', alias: { vue: 'vue/dist/vue.esm-bundler.js' } },
  svelte: { entry: 'svelte/main.js' },
  angular: { entry: 'angular/main.ts', root: '<app-root></app-root>' },
};

export default async function buildExamples() {
  if (!existsSync(join(pkg, 'dist', 'index.js'))) throw new Error('run `pnpm build` before the browser tests');
  mkdirSync(out, { recursive: true });
  for (const [name, app] of Object.entries(APPS)) {
    await build({
      entryPoints: [join(pkg, 'examples', app.entry)],
      outfile: join(out, `${name}.js`),
      bundle: true, format: 'esm', target: 'es2022', jsx: 'automatic', logLevel: 'warning',
      alias: app.alias ?? {},
      conditions: ['svelte', 'browser'],
      plugins: [self, svelte],
      define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    writeFileSync(join(out, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<script type="module" src="./${name}.js"></script></head><body>${app.root ?? '<div id="root"></div>'}</body></html>\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildExamples();
