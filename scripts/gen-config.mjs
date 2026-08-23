import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');

if (!existsSync(envPath)) {
  console.error('missing .env — copy .env.example to .env and fill it in first');
  process.exit(1);
}

const env = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const required = ['R2_WORKER_URL'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error('missing env keys: ' + missing.join(', '));
  process.exit(1);
}

/* the worker is the only thing config.js needs — it holds the R2 binding, so
   no credentials ever end up in the extension. The Clerk publishable key is
   public by design (it only identifies the Clerk instance); the SECRET key
   never ships here — it lives in the worker (wrangler secret / .dev.vars). */
const cfg = {
  worker: env.R2_WORKER_URL.replace(/\/+$/, ''),
  wallhavenKey: env.WALLHAVEN_API_KEY ? env.WALLHAVEN_API_KEY.trim() : '',
  publishableKey: env.CLERK_PUBLISHABLE_KEY ? env.CLERK_PUBLISHABLE_KEY.trim() : '',
  /* reachable Clerk frontend API (the pk embeds a dead vercel.app subdomain;
     auth.js routes all Clerk calls through this proxy — see js-src/auth.js) */
  clerkProxyUrl: env.CLERK_PROXY_URL ? env.CLERK_PROXY_URL.trim().replace(/\/+$/, '') : '',
  generatedAt: new Date().toISOString()
};

writeFileSync(resolve(root, 'js/config.js'), 'window.CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n');
console.log('wrote js/config.js');
console.log('worker: ' + cfg.worker);
console.log('clerk publishable key: ' + (cfg.publishableKey ? 'set' : 'NOT SET (sync stays sign-in-gated / off)'));
console.log('clerk proxy url: ' + (cfg.clerkProxyUrl || 'NOT SET (auth.js falls back to the morphica proxy)'));
