#!/usr/bin/env node
/* Builds the Firefox release of Glisters.
   - Assembles a Firefox-compatible copy of the extension in dist/firefox/
     (manifest.firefox.json → manifest.json, no Chrome-only keys)
   - Zips it to dist/glisters-firefox-<version>.zip for AMO submission.

   Zero npm dependencies — uses node:fs for copying and the system `zip`
   binary for the archive (dist/ is gitignored).

   Run:  node scripts/build-firefox.mjs
*/
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(dist, 'firefox');

const manifest = JSON.parse(
  readFileSync(join(root, 'manifest.firefox.json'), 'utf8')
);
const version = manifest.version;

/* everything the extension needs at runtime; nothing else ships in the zip
   (no .env, no .git, no worker/, no scripts/, no package.json). captcha.html
   is intentionally excluded: it relies on Chrome's MV3 sandbox-page
   mechanism, which Firefox does not support (auth.js detects the missing
   page and skips the widget). */
const files = [
  ['manifest.firefox.json', 'manifest.json'],
  ['newtab.html', null],
  ['popup.html', null],
  ['popup.js', null],
  ['css', null],
  ['js', null],
  ['icons', null],
  ['default-save.json', null],
  ['links.txt', null],
  ['LICENSE', null],
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const [src, dstName] of files) {
  const dst = dstName || src;
  cpSync(join(root, src), join(out, dst), { recursive: true });
}

const zipPath = join(dist, `glisters-firefox-${version}.zip`);
rmSync(zipPath, { force: true });
execFileSync('zip', ['-r', '-q', zipPath, 'firefox'], { cwd: dist, stdio: 'inherit' });

const count = files.length;
console.log(`[build-firefox] ${version} — ${count} entries copied to dist/firefox/, zipped to dist/glisters-firefox-${version}.zip`);
console.log(`[build-firefox] manifest: name="${manifest.name}" id=${manifest.browser_specific_settings.gecko.id} min=${manifest.browser_specific_settings.gecko.strict_min_version}`);
