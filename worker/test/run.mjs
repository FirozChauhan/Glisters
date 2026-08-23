/* Worker smoke tests: auth gating, per-user keys, seed guard, LWW, backup
   rotation, legacy claim. Run: node worker/test/run.mjs */
import { register } from 'node:module';
register(new URL('./mock-clerk.mjs', import.meta.url));
const { default: worker } = await import('../src/index.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

/* ---------- fake R2 ---------- */
class FakeR2 {
  constructor() { this.m = new Map(); }
  async get(k) {
    const v = this.m.get(k);
    if (!v) return null;
    return { text: async () => v, body: v, httpEtag: 'etag-' + k };
  }
  async put(k, v, opts) { this.m.set(k, v); return {}; }
  async delete(k) { this.m.delete(k); }
}
const SAVE = new FakeR2();
const env = { SAVE, CLERK_SECRET_KEY: 'sk_test_x' };

const AUTH = { Authorization: 'Bearer good-token' };
function req(method, path, headers, body) {
  return worker.fetch(new Request('https://glisters.test' + path, {
    method, headers: headers || {}, body,
  }), env);
}
const json = async (r) => (r.headers.get('content-type') || '').includes('json') ? r.json() : r.text();
const DOC = { version: 2, updatedAt: 1000, sites: [{ id: 'a', name: 'X', url: 'https://x.com' }], settings: {} };

console.log('--- auth gating ---');
ok((await req('GET', '/save')).status === 401, 'GET without token -> 401');
ok((await req('GET', '/save', { Authorization: 'Bearer forged' })).status === 401, 'GET with forged token -> 401');
ok((await req('PUT', '/save', { Authorization: 'Bearer forged' }, JSON.stringify(DOC))).status === 401, 'PUT with forged token -> 401');
ok((await req('GET', '/backup', { Authorization: 'Bearer forged' })).status === 401, 'backup with forged token -> 401');

console.log('--- per-user namespace ---');
let r = await req('GET', '/save', AUTH);
ok(r.status === 404, 'no save yet -> 404');
r = await req('PUT', '/save', AUTH, JSON.stringify(DOC));
ok(r.status === 200, 'first PUT -> 200');
ok(SAVE.m.has('Glisters/users/user_123/save.json'), 'saved under per-user key');
ok(!SAVE.m.has('Glisters/save.json'), 'nothing written to the old global key');
r = await req('GET', '/save', AUTH);
ok(r.status === 200 && (await r.json()).updatedAt === 1000, 'GET returns own save');

console.log('--- LWW / seed guard ---');
let newer = { version: 2, updatedAt: 2000, sites: [], settings: {} };
r = await req('PUT', '/save', AUTH, JSON.stringify(newer));
ok(r.status === 200, 'PUT with newer updatedAt -> 200');
r = await req('PUT', '/save', AUTH, JSON.stringify(DOC)); /* older */
ok(r.status === 409, 'PUT with older updatedAt -> 409');
r = await req('PUT', '/save', AUTH, JSON.stringify({ version: 2, updatedAt: 3000, sites: [] }), {});
r = await req('PUT', '/save', Object.assign({ 'X-Glisters-Seed': '1' }, AUTH), JSON.stringify({ version: 2, updatedAt: 4000, sites: [], settings: {} }));
ok(r.status === 409, 'seed PUT over existing save -> 409');
ok(JSON.parse(SAVE.m.get('Glisters/users/user_123/save.json')).updatedAt === 3000, 'existing save untouched after refused seed');

console.log('--- backup rotation ---');
ok(SAVE.m.has('Glisters/users/user_123/save.prev1.json'), 'prev1 kept after overwrite');
ok(JSON.parse(SAVE.m.get('Glisters/users/user_123/save.prev1.json')).updatedAt === 2000, 'prev1 = the doc before last write');
r = await req('PUT', '/save', AUTH, JSON.stringify({ version: 2, updatedAt: 4000, sites: [], settings: {} }));
ok(SAVE.m.has('Glisters/users/user_123/save.prev2.json'), 'prev2 kept after second overwrite');
ok(JSON.parse(SAVE.m.get('Glisters/users/user_123/save.prev2.json')).updatedAt === 2000, 'prev2 = rotated from prev1');
r = await req('GET', '/backup', AUTH);
const bk = await json(r);
ok(r.status === 200 && bk.previous && bk.previous2 && bk.previous.updatedAt === 3000, '/backup returns previous + previous2');

console.log('--- legacy claim ---');
const SAVE2 = new FakeR2();
SAVE2.m.set('Glisters/save.json', JSON.stringify({ version: 2, updatedAt: 500, sites: [{ id: 'legacy' }], settings: {} }));
const env2 = { SAVE: SAVE2, CLERK_SECRET_KEY: 'sk_test_x' };
const legacyReq = (method, path, headers, body) =>
  worker.fetch(new Request('https://glisters.test' + path, { method, headers: headers || {}, body }), env2);
const AUTH2 = { Authorization: 'Bearer good-token' }; /* user_123 */
const AUTH3 = { Authorization: 'Bearer good-token2' }; /* must FAIL -> but stub only accepts good-token, so craft via direct stub call */
r = await legacyReq('GET', '/save', AUTH2);
ok(r.status === 200 && (await r.json()).sites[0].id === 'legacy', 'first user claims the legacy save');
ok(SAVE2.m.has('Glisters/users/user_123/save.json'), 'legacy copied into claimer key');
ok(!SAVE2.m.has('Glisters/save.json') && SAVE2.m.has('Glisters/legacy-claimed.json'), 'legacy moved aside + marker written');
r = await legacyReq('GET', '/save', AUTH2);
ok(r.status === 200 && (await r.json()).sites[0].id === 'legacy', 'claimer GET again -> their (claimed) save');
r = await legacyReq('PUT', '/save', Object.assign({ 'X-Glisters-Seed': '1' }, AUTH2), JSON.stringify({ version: 2, updatedAt: 10, sites: [], settings: {} }));
ok(r.status === 409, 'seed PUT for claimer with save -> 409');

console.log('--- /meta stays public ---');
r = await worker.fetch(new Request('https://glisters.test/meta?url=https://example.com'), env);
ok(r.status === 200, '/meta without auth -> 200');
r = await worker.fetch(new Request('https://glisters.test/meta?url=http://127.0.0.1/'), env);
ok(r.status === 200 && (await r.json()).title === '', '/meta SSRF guard still rejects private hosts');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
