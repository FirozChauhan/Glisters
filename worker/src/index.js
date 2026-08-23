/* ---------------------------------------------------------------------------
   GLISTERS — sync worker
   Fronts the R2 bucket that stores the save file, so the extension never
   needs R2 credentials. The R2 binding (env.SAVE) is Cloudflare-side only.

   AUTH (multi-user): every /save and /backup request must carry
   `Authorization: Bearer <clerk-session-jwt>`. The JWT is verified with
   @clerk/backend (env.CLERK_SECRET_KEY — `wrangler secret put
   CLERK_SECRET_KEY`). Everything is namespaced per user:

     Glisters/users/<userId>/save.json        — the save doc
     Glisters/users/<userId>/save.prev1.json  — kept before every overwrite
     Glisters/users/<userId>/save.prev2.json  — rotated from prev1

     GET  /save    → the calling user's save (404 if none)
     PUT  /save    → overwrite the calling user's save. The previous save is
                     always rotated to prev1/prev2 BEFORE the overwrite, so a
                     clobber — seed, bug, stale client, malicious PUT — is
                     never permanent. Pushes flagged X-Glisters-Seed: 1 (a
                     fresh install seeding from links.txt) are rejected with
                     409 when a save already exists, so a wiped store can
                     never overwrite real cloud data — the client then pulls
                     and adopts the existing save instead.
     GET  /backup  → the calling user's kept previous save(s):
                     { previous, previous2 } (404 if never overwritten)
     GET  /meta    → best-effort page metadata (title + icons) for the
                     add/edit modal — fetched server-side so the browser's
                     CORS rules don't apply; `?url=` must be http(s).
                     Public (no auth — no user data involved).
     OPTIONS       → CORS preflight (extension pages are a cross-origin)

   LEGACY MIGRATION: the pre-multi-user save lived at Glisters/save.json.
   On the first GET /save where the caller has no save yet, that object is
   claimed — copied into the caller's key, then moved out of the way
   (deleted + a Glisters/legacy-claimed.json marker written). Whoever signs
   in first gets the old personal save; every later sign-in starts fresh.
--------------------------------------------------------------------------- */

import { createClerkClient } from '@clerk/backend';

const LEGACY_KEY = 'Glisters/save.json';
const LEGACY_CLAIMED = 'Glisters/legacy-claimed.json';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  /* X-Glisters-Seed rides on PUT pushes (the seed guard); Authorization is
     the Clerk session JWT — both must be preflight-allowable */
  'Access-Control-Allow-Headers': 'Content-Type, X-Glisters-Seed, Authorization',
};

let clerkClient = null;
function clerk(env) {
  /* constructed lazily per isolate; verifyToken fetches + caches JWKS */
  if (!clerkClient) clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY || '' });
  return clerkClient;
}

function userKey(id) { return 'Glisters/users/' + id + '/save.json'; }
function prev1Key(id) { return 'Glisters/users/' + id + '/save.prev1.json'; }
function prev2Key(id) { return 'Glisters/users/' + id + '/save.prev2.json'; }

/* ---- auth: Bearer session JWT -> Clerk user id (or null) -----------------
   Any invalid/expired/forged token is simply `null` → the route answers 401.
   The worker is locked down even before CLERK_SECRET_KEY is set (verification
   fails → 401), which is the point: unauthenticated access is impossible. */

async function authUser(request, env) {
  const h = String(request.headers.get('authorization') || '');
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) return null;
  try {
    const payload = await clerk(env).verifyToken(m[1]);
    return (payload && payload.sub) || null;
  } catch (e) {
    return null;
  }
}

/* created per-call, NOT at module scope — workerd forbids constructing
   streams/Response outside a request context (deploy-time error 10021) */
function unauthorized() {
  return new Response('unauthorized — sign in to sync', { status: 401, headers: CORS });
}

function jsonResponse(body, status) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/* ---- /meta SSRF guard ----------------------------------------------------
   The meta route fetches an arbitrary URL server-side. That is a classic
   SSRF surface, so only public http(s) targets on standard ports are allowed:
   private / link-local / loopback / cloud-metadata ranges, local hostnames,
   and non-80/443 ports are rejected outright. */

function isPrivateHost(hostname, port) {
  if (port !== '' && port !== '80' && port !== '443') return true;
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') ||
      h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') ||
      h === 'metadata.google.internal') return true;

  /* resolve literals by hand — no DNS involved */
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const oct = h.split('.').map(Number);
    const n = ((oct[0] << 24) | (oct[1] << 16) | (oct[2] << 8) | oct[3]) >>> 0;
    if (oct.some((o) => o > 255)) return true;
    /* 0/8 · 10/8 · 100.64/10 · 127/8 · 169.254/16 · 172.16/12 · 192.0.0/24 ·
       192.168/16 · 198.18/15 · 224/4+ */
    if (n >>> 24 === 0) return true;
    if ((n >>> 24) === 10) return true;
    if ((n >>> 22) === 0x64) return true;            /* 100.64.0.0/10 */
    if ((n >>> 24) === 127) return true;
    if ((n >>> 16) === 0xA9FE) return true;          /* 169.254.0.0/16 */
    if ((n >>> 20) === 0xAC1) return true;           /* 172.16.0.0/12 */
    if ((n >>> 24) === 192 && (n >>> 8) % 256 === 0) return true; /* 192.0.0.0/24 */
    if ((n >>> 16) === 0xC0A8) return true;          /* 192.168.0.0/16 */
    if ((n >>> 21) === 0xC612) return true;          /* 198.18.0.0/15 */
    if (n >>> 28 >= 14) return true;                 /* 224/4 multicast + up */
    return false;
  }
  if (/^[0-9a-f:]+$/i.test(h) && h.includes(':')) {
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') ||
        h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') ||
        h.startsWith('feb') || h.startsWith('::ffff:127.')) return true;
  }
  return false;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    /* best-effort page metadata: title (og:title first, then <title>) and
       the icons the page declares, as absolute URLs. Failures return an
       empty set rather than an error so the modal just skips suggestions. */
    if (url.pathname === '/meta') {
      const target = url.searchParams.get('url') || '';
      let tgt = null;
      try { tgt = new URL(target); } catch (e) { /* fall through to reject */ }
      if (!tgt || !/^https?:$/i.test(tgt.protocol) ||
          isPrivateHost(tgt.hostname, tgt.port)) {
        return jsonResponse({ title: '', icons: [] });
      }
      try {
        /* redirects are followed manually so every hop re-runs the guard — a
           hostile page can't bounce us to an internal address */
        let cur = tgt;
        let hops = 0;
        const UA = {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        };
        let res = await fetch(cur.href, { redirect: 'manual', headers: UA });
        while (res.status >= 300 && res.status < 400 && hops < 3) {
          const loc = res.headers.get('location');
          if (!loc) break;
          let next;
          try { next = new URL(loc, cur); } catch (e) { break; }
          if (!/^https?:$/i.test(next.protocol) || isPrivateHost(next.hostname, next.port)) {
            return jsonResponse({ title: '', icons: [] });
          }
          cur = next;
          hops++;
          res = await fetch(cur.href, { redirect: 'manual', headers: UA });
        }
        if (!res.ok) throw new Error('fetch failed: ' + res.status);
        const cLen = parseInt(res.headers.get('content-length') || '0', 10);
        if (cLen > 4 * 1024 * 1024) throw new Error('too big');
        const html = await res.text();
        if (html.length > 4 * 1024 * 1024) throw new Error('too big');
        const clean = (s) => String(s || '')
          .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html);
        const tw = /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)/i.exec(html);
        const tl = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        const title = clean((og && og[1]) || (tw && tw[1]) || (tl && tl[1]));
        const base = new URL(target);
        const icons = [];
        const seen = {};
        const linkRe = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi;
        let m;
        while ((m = linkRe.exec(html)) && icons.length < 8) {
          const href = /href=["']([^"']+)["']/i.exec(m[0]);
          if (!href || !href[1]) continue;
          let abs;
          try { abs = new URL(href[1], base).href; } catch (e) { continue; }
          if (!/^https?:\/\//i.test(abs) || seen[abs]) continue;
          seen[abs] = 1;
          icons.push(abs);
        }
        return jsonResponse({ title, icons });
      } catch (e) {
        return jsonResponse({ title: '', icons: [] });
      }
    }

    /* ---- everything below is per-user: verify the session first ---- */

    const userId = await authUser(request, env);
    if (!userId) return unauthorized();

    if (url.pathname === '/backup') {
      try {
        const [p1, p2] = await Promise.all([env.SAVE.get(prev1Key(userId)), env.SAVE.get(prev2Key(userId))]);
        if (!p1 && !p2) return new Response('no previous save kept yet', { status: 404, headers: CORS });
        const out = {};
        if (p1) { try { out.previous = JSON.parse(await p1.text()); } catch (e) { out.previous = null; } }
        if (p2) { try { out.previous2 = JSON.parse(await p2.text()); } catch (e) { out.previous2 = null; } }
        return jsonResponse(out);
      } catch (e) {
        return new Response(String((e && e.message) || e), { status: 500, headers: CORS });
      }
    }

    if (url.pathname !== '/save') {
      return new Response('not found', { status: 404, headers: CORS });
    }

    try {
      if (request.method === 'PUT') {
        const key = userKey(userId);
        const body = await request.text();
        let incomingAt = 0;
        try { incomingAt = Number((JSON.parse(body).updatedAt) || 0); } catch (e) { /* not JSON */ }
        /* last-write-wins by timestamp, not arrival order: a stale client
           (older updatedAt) must never clobber a newer save. Reject with 409
           so the client re-pulls and adopts the winner instead. */
        const existing = await env.SAVE.get(key);
        let existingText = null;
        if (existing) {
          /* read the body ONCE — text() drains the stream, so reusing
             existing.body afterwards would back up an empty object */
          try { existingText = await existing.text(); } catch (e) { existingText = null; }
          let old = null;
          try { old = existingText ? JSON.parse(existingText) : null; } catch (e) { /* unreadable */ }
          if (old && typeof old.updatedAt === 'number' && old.updatedAt > incomingAt) {
            return new Response('conflict — a newer save exists', { status: 409, headers: CORS });
          }
          /* a fresh install's seed must never replace real cloud data. The
             client only flags this while it has no real local edits; reject
             so it pulls and adopts the existing save instead of seeding over
             it. (Defense-in-depth — the client also prefers the cloud.) */
          if (request.headers.get('x-glisters-seed') === '1') {
            return new Response('seed refused — an existing save wins', { status: 409, headers: CORS });
          }
        } else if (request.headers.get('x-glisters-seed') === '1') {
          /* brand-new user with no save yet — but the pre-multi-user legacy
             save may still be unclaimed. Refuse the seed so the client pulls
             first (which claims the legacy save) instead of seeding over it. */
          const legacy = await env.SAVE.get(LEGACY_KEY);
          if (legacy) {
            return new Response('seed refused — legacy save pending claim', { status: 409, headers: CORS });
          }
        }
        /* keep the outgoing save BEFORE the overwrite: rotate prev1 → prev2,
           current → prev1. Best-effort — a backup failure must never block
           the write itself. */
        try {
          const p1 = prev1Key(userId), p2 = prev2Key(userId);
          const oldPrev1 = await env.SAVE.get(p1);
          if (oldPrev1) {
            let prev1Text = null;
            try { prev1Text = await oldPrev1.text(); } catch (e) { /* skip */ }
            if (prev1Text != null) await env.SAVE.put(p2, prev1Text);
          }
          if (existingText != null) await env.SAVE.put(p1, existingText);
        } catch (e) { /* backup skipped — write continues */ }
        await env.SAVE.put(key, body, { httpMetadata: { contentType: 'application/json' } });
        return new Response('ok', { headers: CORS });
      }

      if (request.method === 'GET') {
        const key = userKey(userId);
        const obj = await env.SAVE.get(key);
        if (obj) {
          return new Response(obj.body, {
            headers: { ...CORS, 'Content-Type': 'application/json', 'ETag': obj.httpEtag || '' },
          });
        }
        /* one-time legacy claim: the pre-multi-user personal save belongs to
           whoever signs in first. Copy it into the caller's key, then move it
           out of the way so no later sign-in can claim it too. */
        const legacy = await env.SAVE.get(LEGACY_KEY);
        if (legacy) {
          let text = null;
          try { text = await legacy.text(); } catch (e) { text = null; }
          if (text != null) {
            try {
              await env.SAVE.put(key, text, { httpMetadata: { contentType: 'application/json' } });
              await env.SAVE.put(LEGACY_CLAIMED,
                JSON.stringify({ claimedBy: userId, at: Date.now() }),
                { httpMetadata: { contentType: 'application/json' } });
              await env.SAVE.delete(LEGACY_KEY);
              return new Response(text, {
                headers: { ...CORS, 'Content-Type': 'application/json' },
              });
            } catch (e) { /* claim failed — fall through to 404, retried next pull */ }
          }
        }
        return new Response('not found', { status: 404, headers: CORS });
      }

      return new Response('method not allowed', { status: 405, headers: CORS });
    } catch (e) {
      return new Response(String((e && e.message) || e), { status: 500, headers: CORS });
    }
  },
};
