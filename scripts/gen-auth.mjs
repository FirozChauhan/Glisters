/* Bundles js-src/auth.js (+ the Clerk SDK) into js/auth.js with esbuild.
   The extension ships plain script tags with a strict CSP (script-src 'self'),
   so the Clerk SDK — the only npm dependency in the extension — is compiled
   into a local file. No remote code ever runs (store-review requirement).

   Run: node scripts/gen-auth.mjs   (or: npm run gen-auth) */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [resolve(root, 'js-src/auth.js')],
  outfile: resolve(root, 'js/auth.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info'
});

console.log('wrote js/auth.js (' + resolve(root, 'js/auth.js') + ')');
