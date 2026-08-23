/* Copies js-src/auth.js into js/auth.js with a generated-at timestamp.
   No bundling needed — the cookie-based auth has zero ClerkJS dependencies,
   so no esbuild invocation and no 2.8MB bundle.

   Run: node scripts/gen-auth.mjs   (or: npm run gen-auth) */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'js-src/auth.js'), 'utf8');
const banner = '/* Generated at ' + new Date().toISOString() + '. DO NOT EDIT — edit js-src/auth.js instead. */\n';
writeFileSync(resolve(root, 'js/auth.js'), banner + src);
console.log('wrote js/auth.js (' + resolve(root, 'js/auth.js') + ')');