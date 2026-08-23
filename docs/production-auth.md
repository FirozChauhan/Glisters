# Production auth rework — design

**Status**: draft (evaluate before committing to the work)
**Goal**: remove Clerk's `[development]` email branding (requires a **production**
Clerk instance) while keeping sign-in working inside the extension.

## 1. Why this is non-trivial

The current auth flow is **raw Clerk FAPI with dev browser tokens**:

```
extension → POST /v1/dev_browser        → mints a dev browser token
          → POST /v1/client/sign_ins    ?__clerk_db_jwt=<token>   (form-encoded)
          → client.sessions[0].last_active_token → session JWT stored in chrome.storage
          → worker: Authorization: Bearer <jwt>  (verified via @clerk/backend)
```

Two things break in a production Clerk instance:

1. **`/v1/dev_browser` does not exist in production** — dev browser tokens are a
   dev-mode-only mechanism (they simulate a browser client for cookie-less
   clients). In production the FAPI authenticates requests by **cookies**
   (`__client`, `__session`) set on the frontend API domain, not by a query
   token.
2. **MV3 CSP forbids loading ClerkJS in extension pages**
   (`script-src 'self'`), so we can't just drop the SDK in and let it manage
   cookies for us. This is the constraint that forces the whole design.

The worker side is **unaffected** — it verifies the JWT, not the auth flow. No
worker auth changes needed.

## 2. The two viable paths

### Path A — iframe-hosted ClerkJS (recommended)

Host a tiny **auth page** that loads real ClerkJS, and embed it in the
extension as an iframe. ClerkJS does everything (password, email-code, OAuth,
session, cookies); it `postMessage`s the session JWT back to the extension.

```
┌─────────── extension page (newtab.html) ───────────┐
│  #authOverlay                                      │
│   └─ <iframe src="https://glisters…workers.dev/auth.html">  │
│        loads ClerkJS from js.clerk.com             │
│        <SignIn> / <SignUp> renders inside          │
│        on success: postMessage({type:'session', jwt}) │
│  auth.js listens, validates origin, stores jwt     │
└────────────────────────────────────────────────────┘
```

**Where the auth page lives**: the Cloudflare Worker itself serves a static
`/auth` route (it's already deployed, CORS-open, and the extension has
`https://*/*` host permission). No extra hosting.

**Why it works in production**: the iframe is a *normal web page* (worker
origin), so its CSP is the worker's, not the extension's — ClerkJS loads fine.
ClerkJS sets its session cookies on the Clerk frontend-API domain during FAPI
calls; those cookies persist across reloads. The extension only ever sees the
**JWT**, exactly as today.

**Changes needed**:

| Where | What |
|---|---|
| `worker/src/index.js` | Add a public `GET /auth` route serving `auth.html` (only route; keep everything else JWT-gated) |
| new file `worker/auth.html` | ~100 lines: load ClerkJS, render `<SignIn>`/`<SignUp>` (sign-up toggle), `postMessage` the JWT up, listen for a `signOut` command down |
| `js-src/auth.js` | Replace the raw-FAPI network layer (`fetchDbJwt`/`ensureDbJwt`/`apiFetch`) with an iframe bridge: create iframe on `openOverlay()`, forward `{type:'session', jwt}` → `chrome.storage`; `signOut()` postMessages down and clears local state |
| `js/auth.js` | regenerate via `scripts/gen-auth.mjs` |
| `manifest.json` | no CSP change needed (iframe content isn't the extension page) — verify `frame-src` isn't blocked; if it is, extend `extension_pages` CSP with `frame-src https://glisters.jigar1155.workers.dev` |
| Clerk Dashboard | switch instance Development → **Production**; add `https://glisters.jigar1155.workers.dev` to allowed origins |

**Effort**: ~1 focused session. Biggest risk: ClerkJS behaviors we can't predict
without live testing (see §3 spike).

### Path B — raw REST + production cookie handling (fallback, risky)

Keep the raw-FAPI approach and make production FAPI accept us by carrying the
real cookies:

- `fetch(..., { credentials: 'include' })` on every FAPI call — the extension
  already has host permission for `*.clerk.accounts.dev`, so Chrome attaches
  `__client`/`__session` cookies automatically.
- First call `POST /v1/client` (cookieless) creates the anonymous client and
  Clerk sets the `__client` cookie in the response.
- Session JWT still read from `client.sessions[0].last_active_token` in the
  response body (no cookie reading needed for the core flow).
- Re-add the `cookies` permission *only if* a later step needs to read the
  `__session` cookie directly (e.g. token refresh edge cases).

**Unknowns that could kill this path**: whether production FAPI accepts a
cookieless `POST /v1/client`, whether it requires the publishable key or a
client context, and whether the sign-in endpoints enforce cookie presence.
Fetch in extension pages cannot read `Set-Cookie` headers, so if FAPI demands
an explicit client id in the request, we're stuck — Path B collapses into
Path A. **Treat Path B as the fallback only, don't build on it first.**

## 3. Spike first (30 min, before writing any code)

Flipping the real instance to production is irreversible-ish for the dev flow,
so do this on a **throwaway production instance**:

1. Create a second Clerk instance → set it to **Production** (free tier allows
   it; it's a separate project).
2. With the current extension pointed at it (temporarily swap `publishableKey`
   in `js/config.js`):
   - Try the current raw flow: does `POST /v1/client/sign_ins` answer without
     `__clerk_db_jwt`? What errors come back? (Answers Path B's viability.)
   - Serve a 10-line `auth.html` from the worker and load it in a plain
     browser tab: does ClerkJS render and return `session.getToken()`? (Answers
     Path A's viability — if it works in a tab, it works in an iframe.)
3. Kill the throwaway instance, keep notes.

Both answers are cheap to get and remove all guesswork.

## 4. Production instance setup checklist (after the spike)

- [ ] New Clerk instance → **Production** (do NOT flip the dev one while
      testing).
- [ ] Confirm `[development]` email prefix is gone on the first test
      verification email.
- [ ] Sender name/address: set a real from-address (production unlocks
      custom SMTP too, if ever needed).
- [ ] Add worker origin to Clerk allowed origins (for the iframe).
- [ ] Re-enable OAuth (Google) if wanted — Path A's ClerkJS makes this free;
      Path B can't do OAuth at all.
- [ ] Extend Clerk Dashboard → allowed origins with
      `chrome-extension://<id>` (unchanged from today).
- [ ] Update the worker's `CLERK_SECRET_KEY` secret (`wrangler secret put`)
      with the new instance's secret key.
- [ ] Update `js/config.js` `publishableKey` → new instance's pk (public
      value, still safe to commit).

## 5. What does NOT change

- Worker `/save` auth (still `Authorization: Bearer <jwt>` — just a different
  instance's JWT now, verified by the updated `CLERK_SECRET_KEY`).
- The doc, sync, LWW, seed-guard, backup logic — untouched.
- The `sign in to sync` pill, drawer, account row UI — mostly untouched
  (auth.js internals change, its public surface stays).
- Dev-mode convenience: keep the current dev instance + dev-browser-token flow
  for local development; production auth only when `config.js` points at the
  production pk.

## 6. Recommendation

**Path A** (iframe ClerkJS) — it is the only path that works for OAuth, is the
least fragile (ClerkJS handles session/cookies correctly), and reuses the
already-deployed worker. Estimate **one focused session** after the 30-minute
spike. Path B is a research dead-end risk; don't start there.

Do the spike first. If the throwaway production instance answers both
questions positively, commit to Path A.
