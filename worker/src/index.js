/* ---------------------------------------------------------------------------
   GLISTERS — sync worker
   Fronts the R2 bucket that stores the save file, so the extension never
   needs R2 credentials. The R2 binding (env.SAVE) is Cloudflare-side only.

     GET  /save    → the save file (404 if none)
     PUT  /save    → overwrite the save file. The previous save is always
                     kept (rotated to Glisters/save.prev1.json and
                     save.prev2.json) BEFORE the overwrite, so a clobber
                     — seed, bug, stale client, malicious PUT — is never
                     permanent. Pushes flagged X-Glisters-Seed: 1 (a fresh
                     install seeding from links.txt) are rejected with 409
                     when a save already exists, so a wiped store can never
                     overwrite real cloud data — the client then pulls and
                     adopts the existing save instead.
     GET  /backup  → the kept previous save(s): { previous, previous2 }
                     (404 if nothing has ever been overwritten)
     GET  /meta    → best-effort page metadata (title + icons) for the
                     add/edit modal — fetched server-side so the browser's
                     CORS rules don't apply; `?url=` must be http(s)
     OPTIONS       → CORS preflight (extension pages are a cross-origin)
--------------------------------------------------------------------------- */

const KEY = 'Glisters/save.json';
const PREV1 = 'Glisters/save.prev1.json';
const PREV2 = 'Glisters/save.prev2.json';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  /* X-Glisters-Seed rides on PUT pushes (the seed guard) — it must be
     preflight-allowable for non-extension (host-permission) callers */
  'Access-Control-Allow-Headers': 'Content-Type, X-Glisters-Seed',
};

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
        return new Response(JSON.stringify({ title: '', icons: [] }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
      try {
        /* redirects are followed manually so every hop re-runs the guard — a
           hostile page can't bounce us to an internal address */
        let cur = tgt;
        let hops = 0;
        let res = await fetch(cur.href, {
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
          },
        });
        while (res.status >= 300 && res.status < 400 && hops < 3) {
          const loc = res.headers.get('location');
          if (!loc) break;
          let next;
          try { next = new URL(loc, cur); } catch (e) { break; }
          if (!/^https?:$/i.test(next.protocol) || isPrivateHost(next.hostname, next.port)) {
            return new Response(JSON.stringify({ title: '', icons: [] }), {
              headers: { ...CORS, 'Content-Type': 'application/json' },
            });
          }
          cur = next;
          hops++;
          res = await fetch(cur.href, { redirect: 'manual', headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
          } });
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
        return new Response(JSON.stringify({ title, icons }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ title: '', icons: [] }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/backup') {
      try {
        const [p1, p2] = await Promise.all([env.SAVE.get(PREV1), env.SAVE.get(PREV2)]);
        if (!p1 && !p2) return new Response('no previous save kept yet', { status: 404, headers: CORS });
        const out = {};
        if (p1) { try { out.previous = JSON.parse(await p1.text()); } catch (e) { out.previous = null; } }
        if (p2) { try { out.previous2 = JSON.parse(await p2.text()); } catch (e) { out.previous2 = null; } }
        return new Response(JSON.stringify(out), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(String((e && e.message) || e), { status: 500, headers: CORS });
      }
    }

    if (url.pathname !== '/save') {
      return new Response('not found', { status: 404, headers: CORS });
    }

    try {
      if (request.method === 'PUT') {
        const body = await request.text();
        let incomingAt = 0;
        try { incomingAt = Number((JSON.parse(body).updatedAt) || 0); } catch (e) { /* not JSON */ }
        /* last-write-wins by timestamp, not arrival order: a stale client
           (older updatedAt) must never clobber a newer save. Reject with 409
           so the client re-pulls and adopts the winner instead. */
        const existing = await env.SAVE.get(KEY);
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
        }
        /* keep the outgoing save BEFORE the overwrite: rotate prev1 → prev2,
           current → prev1. Best-effort — a backup failure must never block
           the write itself. */
        try {
          const oldPrev1 = await env.SAVE.get(PREV1);
          if (oldPrev1) {
            let prev1Text = null;
            try { prev1Text = await oldPrev1.text(); } catch (e) { /* skip */ }
            if (prev1Text != null) await env.SAVE.put(PREV2, prev1Text);
          }
          if (existingText != null) await env.SAVE.put(PREV1, existingText);
        } catch (e) { /* backup skipped — write continues */ }
        await env.SAVE.put(KEY, body, { httpMetadata: { contentType: 'application/json' } });
        return new Response('ok', { headers: CORS });
      }

      if (request.method === 'GET') {
        const obj = await env.SAVE.get(KEY);
        if (!obj) return new Response('not found', { status: 404, headers: CORS });
        return new Response(obj.body, {
          headers: { ...CORS, 'Content-Type': 'application/json', 'ETag': obj.httpEtag || '' },
        });
      }

      return new Response('method not allowed', { status: 405, headers: CORS });
    } catch (e) {
      return new Response(String((e && e.message) || e), { status: 500, headers: CORS });
    }
  },
};
