# Glisters — Developer / AI Guide

This document is the single source of truth for understanding the Glisters
codebase. It is written for both human developers and AI agents working on the
code. Read this before touching any file.

---

## 1. What this project is

**Glisters** is a minimal, keyboard-first Chrome extension that replaces the
new-tab page. It renders a vim-controlled grid of shortcut tiles, a right-edge
bookmarks sidebar that edits Chrome's real bookmarks directly, a left-edge
settings drawer, an optional wallpaper pool pulled from Wallhaven, and a
Cloudflare-Worker-backed sync layer so the whole save file mirrors to R2.

Key characteristics:

- **Manifest V3** extension; the new tab override is served *directly* (no
  redirect), so Chrome keeps the address bar focused by default — keys land in
  the page only after the user clicks or tabs into it (`js/app.js:1861`).
- **Plain ES5-style JavaScript** (IIFEs, `var`, closures). No bundler, no
  framework, no npm runtime deps for the extension itself. Node is used only
  for two tiny build scripts (`scripts/`).
- **Vanilla DOM APIs** for all rendering (each module builds its own DOM nodes).
  No HTML injection anywhere: user/cloud/Chrome-supplied strings are always
  rendered via `textContent`; `innerHTML` is used only for static inline SVG
  icons and container clears.
- **Three cooperating modules** in global namespace communicated through
  guarded hooks (`window.SYNC`, `window.BOOKMARKS`, `window.WALLS`,
  `window.CONFIG`) plus the core `js/app.js`.
- One **shared save document** ("the doc") that everything persists and syncs.

### Architecture at a glance

```
manifest.json  →  newtab.html  (Chrome newtab override)
                      │  loads in order:
                      ├─ js/config.js     (runtime constants; generated)
                      ├─ js/auth.js       (window.AUTH — Clerk session via
                      │                     raw REST API; generated,
                      │                     plain copy from js-src/auth.js)
                      │   └─ embeds captcha.html  (sandbox page, see §3.17)
                      ├─ js/sync.js       (window.SYNC — cloud push/pull, JWT)
                      ├─ js/walls.js      (window.WALLS — wallpapers)
                      ├─ js/bookmarks.js  (window.BOOKMARKS — bookmarks bar,
                      │                     the right-edge panel; the settings
                      │                     bar is the left-edge #drawer panel)
                      └─ js/app.js        (window.CONFIG consumer — grid/core)
css/main.css, css/bookmarks.css   (theme: tokens in :root)
captcha.html  (sandbox page — Turnstile captcha; loaded by auth.js)
icons/  (generated 16/48/128 PNGs)
scripts/gen-config.mjs / gen-auth.mjs / gen-icons.mjs  (Node build helpers)
js-src/auth.js  (auth SOURCE — raw Clerk REST API, no SDK; copied to js/auth.js)
worker/  (Cloudflare Worker → R2 bucket "SAVE")
default-save.json  (popular-websites seed template, one full save doc)
links.txt  (legacy first-run seed override, one URL per line)
```

---

## 2. Environment & runtime facts

| Thing | Value |
|---|---|
| Language | JavaScript (ES5-style), HTML, CSS |
| Runtime | Browser extension (Chrome MV3), plus Node ≥18 for scripts & the Worker |
| No package.json | correct — nothing to `npm install` for the extension |
| Git | local git repository (initialized; no remote configured yet) |
| Secrets | `.env` (gitignored). `js/config.js` is committed (public-scope values only — worker URL, publishable key; the wallhaven key is intentionally empty so each user supplies their own) |

`js/config.js` is **generated, never hand-edited** — it is re-written by
`node scripts/gen-config.mjs` from `.env`. It is **committed to git** because
it holds only public-scope values (worker URL, Clerk publishable key) —
shipping it means a GitHub clone works out of the box (sync + sign-in
enabled) instead of a blank "not configured" state. Same for `js/auth.js`
(a plain copy of `js-src/auth.js` with a generated banner; no secrets — the
frontend API is derived from the publishable key at runtime). The real
secret, `CLERK_SECRET_KEY`, stays in `wrangler secret` / `.dev.vars`
and must never appear in the repo. `.gitignore` excludes `.env`, `node_modules/`,
and `.freebuff/` (a local SQLite scratch dir, unrelated to the app).

---

## 3. File-by-file reference

### 3.1 `manifest.json`
- MV3; `chrome_url_overrides.newtab → newtab.html`.
- Permissions: `storage`, `bookmarks`; `host_permissions:
  https://*/*` (direct favicon/title fetches + any https source),
  `https://*.clerk.accounts.dev/*` (the Clerk frontend API: `/v1/me`,
  session revocation), `https://*.accounts.dev/*` (Clerk hosted pages),
  and `https://challenges.cloudflare.com/*` (Turnstile captcha, see
  §3.17). All are covered by the `https://*/*` wildcard today, but they
  stay explicit in case it is ever narrowed.
- CSP for extension pages: `script-src 'self'` (MV3 restriction — external
  scripts are loaded via a sandbox page, see `captcha.html` in §3.17);
  `connect-src 'self' https:`.
- A pinned `key` (line 6) keeps the extension id stable — churning ids orphan
  all `chrome.storage` data (the settings drawer's Storage chips exist to
  surface exactly this).

### 3.2 `newtab.html`
Static shell only. Notable pieces:
- Fonts load asynchronously via `media="print"` + `onload="this.media='all'"`
  so first paint never blocks on `fonts.googleapis.com`.
- `#grid` (shortcut tiles) starts `mouse-nav` so the focus ring stays hidden
  until first keyboard nav.
- Floating launchers: `#settingsBtn` (gear, top-left) and `#bkToggle`
  (bookmarks, top-right) — the mouse path to both panels. `s`/`b` hotkeys
  still work; the FABs are the visible affordance for pointer users.
- Command `#bar` (summoned with `/` or `:`); placeholder hints it also accepts
  pasted images for Google reverse image search.
- `#bk` bookmarks aside, `#drawer` settings aside, `#modal` add/edit form.
- Settings drawer's sync group has the account row (`#acctEmail` +
  `#acctSignIn`/`#acctSignOut`) above the sync pill; sign-in opens the
  in-extension auth overlay (`#authOverlay`).
- Script order matters (listed in §1): config → **auth** → sync → walls →
  bookmarks → app.

### 3.3 `css/main.css`
Theme tokens in `:root` (`--page`, `--card`, `--surface`, `--fg`, `--line`,
fonts, `--radius: 0px` for the sharp-corner look). `#wallLayer` (managed by
walls.js) sits fixed behind content with `filter: blur(var(--wall-blur))`,
monochrome via `html.wall-mono`. Includes all grid/tile, page-flip animations
(`anim-next/prev/snapshot`), right-click ctx buttons, empty state, command bar,
drawer, sliders/switches/toggles, sync pill state colors, wallpaper grids,
buttons, modal, icon picker. Honors `prefers-reduced-motion`.

### 3.4 `css/bookmarks.css`
Self-contained styles for the right-edge sidebar (`.bk*`): slide-over, rows,
focus/armed states, breadcrumbs, inline editor, empty state, drag drop targets.

### 3.5 `js/app.js` (core, ~1864 lines)
The heart. Renders the grid, owns one shared `state` object, vim keys, modal,
drawer, drag-reorder, page flips, and orchestrates the other modules.

**Public surface exposed to others** (all guarded with existence checks):
- Reads `window.CONFIG` (`CF = window.CONFIG || {}`), `window.SYNC`,
  `window.BOOKMARKS`, `window.WALLS`.

**Module state** (top of the IIFE):
- `STORE_KEY = 'glisters'` — localStorage + chrome.storage key for the main
  doc. `SEED_VERSION = 2` — bump to force re-seeding of existing installs.
- `DEFAULT_SITES` — the baked-in default save: the user's 46 links with
  clean names. `DEFAULTS.sites` starts from it, so a fresh/wiped install
  renders the links on first paint with zero fetches (offline-safe).
- `state` — live in-memory doc (`version`, `updatedAt`, `sites[]`, `settings`,
  plus the `walls` slice added by `doc()`; bookmarks live in Chrome, not
  here).
- `focused` / `armed` (indices), `page`, `mode`
  (`'none' | 'drawer' | 'modal' | 'bar'`), various timers.

**State lifecycle**
- `readLocal()` → parse `localStorage['glisters']`.
- `normalize(o)` — the cloud-safety gate. Clamps site name ≤300, url ≤4096,
  only accepts `https?://` icons, validates every numeric setting, defaults
  booleans, keeps `bookmarks`/`walls` slices only if objects (the bookmarks
  slice is tolerated from old saves but never written again). `restoreFromStorage()`
  reads the durable `chrome.storage.local` copy if localStorage misses.
- `persistLocal()` writes BOTH localStorage and `chrome.storage.local`.
- `doc()` returns the full saveable doc — the `walls` slice from
  `window.WALLS.forDoc()`, and bookmarks only if a module still supplies one
  (it doesn't: `window.BOOKMARKS.forDoc()` is `null`).
- `commit(opts)` — stamps `updatedAt`, re-renders (unless `noRender`),
  persists, and schedules a cloud push (unless `noCloud`).

**default-save.json seeding**: On a fresh install (`needSeed`), `state` starts
from `DEFAULT_SITES` (the baked default save) so the grid is never blank. If a
stored doc is unrecoverable it then fetches `default-save.json`
(`loadSeed()`), a complete doc with a curated list of popular websites (48
sites + default settings) — edit it to change what a future fresh install
seeds. It is run through `normalize()` like any cloud doc. `loadSeed()` falls
back to `links.txt` (one URL per line, the legacy override), then to the
baked `DEFAULT_SITES`. Derives display names via `nameForUrl()` (title-case
map `TITLE_CASE`, `prettyBase`, Google-product detection), dedupes names.
Sets `seededFromLinks` **and persists it** (`glisters-seed` in localStorage +
chrome.storage) so a reload can never mistake the seed for real local data —
that was the clobber vector that let a wiped install's seed overwrite the
cloud save via LWW.

**Favicon resolution** (`iconCandidates`, `loadIcon`, caches) — critical
subsystem:
- Candidate order: user-picked `site.icon` → curated `OFFICIAL_ICONS` (host+
  path mapped, e.g. `google.com/maps → maps.google.com` pin via `officialIcon`)
  → site's own `apple-touch-icon.png` / `favicon-32x32.png` / `favicon.ico` →
  Google s2 re-render for host + parent-domain variants → DuckDuckGo.
- `preferred` candidates settle early; others compete largest-wins; a 6s guard
  finalizes; a `w<16` (or `w<=16` for chip/s2) result never settles (avoids
  the generic 16px Google globe 404-default).
- Small favicons get integer nearest-neighbour upscaling (`.sharp`) — never
  fractional, to avoid pixelated glitch.
- **Three layers of cache recognized by the code**:
  1. `faviconCache` (in-memory decoded elements) — page flips reuse instantly;
  2. `iconLoading` — in-flight guard to avoid double work;
  3. `persistedIcons` (`localStorage` + `chrome.storage`, key
     `'glisters-icons'`, debounced 400ms write) — cross-session winner, tried
     first so repeat boots are one cache-hit request per tile.
- Failures (`faviconCache[key] === false`) are retried with backoff (n*5000ms,
  up to 3) and again on `online`; a stale persisted winner 404s and provokes
  full re-resolution.

**Vim keyboard map** (`keydown`, `js/app.js:843`):
`h j k l`/arrows move · `g`/`G` first/last · `Home`/`End` ·
`tab`/`shift+tab` page next/prev · `enter`/`o` open (ctrl/meta+enter or o opens
new tab) · `a` add · `e` edit · `d` delete (arm once, confirm on second `d` in
2.5s) · `s` settings drawer · `/` or `:` command bar · `esc` close · `d`-arm is
cancelled by any other handled key. Keys ignored while typing in inputs.

**Mouse**: wheel→horizontal page flip (throttled 180ms) with ctrl exempt;
hover sets focus but keeps `mouse-nav` ring hidden; click opens (ctrl/meta =
new tab); right-click overlays edit/delete ctx buttons on the icon; custom
pointer-based **drag-reorder** that is butter-smooth: the source tile becomes
an invisible gap, a lifted ghost (scale + shadow) follows the cursor, and the
OTHER tiles **FLIP-animate out of the way live** — the target cell is computed
from pointer position against the grid geometry (measured once at drag start,
so tiles never 'run away' from the cursor), the dragged node is re-inserted at
that cell, and displaced tiles slide via inverted transform transitions
(`snapRects`/`flipFrom`). Drop commits the same cell mapping (land exactly
where the drag left it); releasing outside the grid slides the tiles back
(`undoLiveOrder`). Edge auto-flip across pages (480ms interval within 70px of
the edge) re-measures geometry and holds reorder ~380ms until the page slide
settles. Followed by a ghost-click suppression (`suppressClick`). Honors
`prefers-reduced-motion` (reorder still works, no animations).

**Pagination**: `pageCount()` = ceil(sites/capacity), capacity =
`cols×rows`. Pages loop; wrap direction tracks travel direction. Page flips use
a cloned `page-snapshot` ghost (two-layer slide) cleaned on `animationend` + a
600ms safety timer.

**Settings drawer**: `syncDrawerDisplay()` mirrors state into the inputs only
when open. Sliders apply **live CSS-only changes** and a 250ms-debounced heavy
commit; only `cols`/`rows` rebuild the grid (capacity change). Step buttons
(`−`/`+`) clamp to input min/max. Section jump-nav (`syncSetNav`) highlights
the group currently in view on scroll.

**Modal (add/edit)**:
- `openModal(site)` / `closeModal()`. Editing stores `editingIdx`.
- Title auto-detect (`detectMeta`/`fetchMeta`): direct `fetch` first (host
  permission bypasses CORS), falls back to the worker's `/meta` route. Optimistic
  name from hostname, never overwrites the user's typing.
- `parseMetaHtml` extracts og:title → twitter:title → `<title>` and up to 8
  `<link rel="icon">` URLs. `META_MAX = 4MB`, 8s abort, per-url cache.
- Icon picker (`renderIconPicker`): "auto" option (``) plus up to 8
  circular
  candidates from the same machinery as the grid, plus page-declared icons.
  Picked icon stored on the tile and re-selected on edit.
- On submit, editing clears url/icon caches when url or icon changed so the
  tile re-resolves.

**Command bar**: `/` or `:` opens `#bar`. Submit matches a site by exact name
→ substring → treats as URL/domain → Google search fallback. Paste-handler
reverse image searches: image file → POST to Google upload form (hidden,
`target=_blank`); image URL → `searchbyimage?image_url=`.

**Cloud sync orchestration** (uses `window.SYNC`):
- `scheduleCloud()` marks dirty, spawns `pushCloud` after 1300ms.
- `pushCloud()`: `SYNC.push(doc())`. On 409 conflict → `SYNC.pull()` and
  `adoptRemote` the newer doc. On network error → dirty, retry every 20s.
- `adoptRemote(remote)` — `normalize` + hand slices to BOOKMARKS/WALLS.
- `syncStart()` boot logic: real-local-edits vs fresh-install prefer cloud;
  the cloud wins only if `remote.updatedAt > state.updatedAt && !dirty`.
- Reconnect listeners: `online` (push or retry seed), `pagehide` (best-effort
  push), `visibilitychange`→visible (push if dirty).
- `storageProbe()` writes `__probe__` round-trips to verify localStorage &
  chrome.storage survive reloads; shows the extension id (first 8 chars).

### 3.6 `js/sync.js` (~42 lines)
Thin Cloudflare-Worker client. `base` from `window.CONFIG.worker ||
endpoint`. `req(method, body)`:
- `GET /save` → doc JSON; 404 → `null`; 409 → `{ conflict: true }`.
- `PUT /save` → `true` on success.
Exposes `window.SYNC = { cfg, push, pull }`. Disabled (rejects) when no worker
URL is configured.

### 3.7 `js/walls.js` (~1100 lines) — wallpapers
Sinks to `window.WALLS = { bind, forDoc, restore, next, refresh, reload,
filter, key, fav, favPool, setSafe, applySafe, download }`.

**Source**: Wallhaven keyless API `search?sorting=toplist&topRange=1M&per_page=24`,
purity/category bitmasks (`100/110/111`, `100/010/001`), optional `&apikey=`.
NSFW (`111`) is disabled without an API key. `CFG_KEY` (from config, from .env)
seeds the drawer key field. Picks random pages (up to 3 tries) to fill 10
wide shots (aspect ≥1.5, filtered client-side). Offline fallback: curated
Unsplash set (`FALLBACK`).

**State** (persists under `localStorage['glisters-walls']` + chrome.storage +
inside the app doc via `forDoc`/`restore`/`adopt`): `{v:9, key, list[10],
lastRefresh, purity, category, apikey, favs[≤60], safe}`. `KEY_RE` gates keys
(`[A-Za-z0-9]{8,64}`). Old saves (v<6) are dropped to rebuild from Wallhaven.

**Wallpaper blob cache** (performance core):
- `<img>` preloading warms the browser HTTP cache (needs no CORS — works even
  on a dev server / file://).
- Bonus Cache Storage layer (`caches.open('glisters-walls-v1')`) reuses those
  bytes with `cache:'force-cache'`; applying resolves to a **blob URL**
  (`materialize`) for near-instant, offline-capable swaps.
- `prefetchPool()` warms 3 at a time. `pruneBlobs()` revokes blob URLs and
  deletes cache entries that left the pool (always keeps current shot + all
  favourites + safe). 24h freshness: `setInterval(refreshPool(true), 24h)` and
  a delayed boot check.

**Security**: `safeWallUrl()` re-parses any incoming wallpaper url into a plain
http(s) URL with quotes escaped before it ever reaches `background-image`.

**Interactions**: drawer grid + favourites grid (lazy thumbs), purity/category
segmented pickers (swapping a filter pulls a matching pool with
`different:true`), API-key field, add-URL + per-item remove (only for hand-added
urls; `isBuiltin`), reload button (`different:true` — drops current pool first).

**Keys handled here** (bare page only, `keydown` guard at `js/walls.js:960`):
`w` next pool cycle · `r`/`R` reload · `f` favourite current · `F` favourites
become the pool · `D` download current · `space` single = save current as
safe, double-space (within 350ms window) = apply safe.

**Download current wallpaper**: the drawer's "Current wallpaper → download"
button (`WALLS.download()`), the key `D` (shift+d, works anywhere on the
page), or plain `d` while the settings drawer is open, saves the applied shot
to disk. It downloads the cached blob URL when the pool is materialized
(instant, offline-capable), otherwise fetches the bytes fresh; on failure it
opens the image in a new tab so it can still be saved by hand. The filename
is derived from the url (wallhaven/unsplash photo ids are preserved).

### 3.8 `js/bookmarks.js` (~966 lines) — bookmarks sidebar
Sinks to `window.BOOKMARKS = { bind, forDoc, restore, refreshFromChrome }`.

**Model**: the sidebar is a **direct editor for Chrome's real bookmarks** —
it renders `chrome.bookmarks.getTree()` live and refreshes on every chrome
bookmark event (`onCreated`/`onRemoved`/`onChanged`/`onMoved`/
`onChildrenReordered`/`onImportEnded`/`onImportBegan`), so changes made
anywhere (Chrome UI, another device, this sidebar) appear instantly. There is
**no local mirror, no `glisters-bk` storage key, and no slice in the app
save doc** — `bind`/`forDoc`/`restore` are inert stubs kept only so app.js's
guarded calls stay valid. `localStorage['glisters-bk-ui']` holds only the
panel open state.

Home view = the bookmarks bar ('1'); "Other bookmarks"/"Mobile bookmarks"
are trailing folder rows (large index sorts them last). `normalizeTree()`
walks the chrome tree into flat `TREE.folders` / `TREE.items` arrays with
`{id: chromeId, name, url?, parent, index}`; `parent === null` means home.

**Write-through (direct)**: add → `chrome.bookmarks.create`, edit →
`chrome.bookmarks.update`, delete → `chrome.bookmarks.remove`/`removeTree`,
move → `chrome.bookmarks.move` — all with the real chrome ids, no backfill.
Home maps to the bar via `homeIdOf()`. After the API callback the tree is
re-read (`refresh()`), and the freshly created/edited node is focused only
after the fresh tree lands (render() falls back to the first row while the
new id is still missing). Requires the `bookmarks` permission; without it
the panel shows nothing but degrades gracefully.

**Sidebar UI**: `b`/`B` toggles (capture-phase handler; `stopPropagation` so
the grid never sees consumed keys). Drill-down folders; back (`h`/`←`) lands
focus on the folder you left; breadcrumbs (`home / folder / …`). Keys: `j k`
move · `enter`/`o`/`l`/`→` open · `a` add link · `A` add folder · `e`/`E` edit
· `d`/`D` delete (arm+confirm) · `g`/`G` first/last · `esc`/`b` close ·
`tab` consumed (so grid doesn't paginate). Rows are `draggable` (HTML5 DnD):
drop-into folders / before siblings / onto root, moved directly in Chrome via
`moveNode`. Inline editor for add/edit. Links open in a **background** tab
(`chrome.tabs.create {active:false}`), never navigating the page itself;
synthetic-click fallback sets `ignoreOutsideClick` so the outside-click close
doesn't fire. Right-edge position; outside click (capture phase, decided before
row re-renders detach the target) closes it.

Favicon resolution duplicates app.js's official-icon map + candidates + the
shared `'glisters-icons'` persisted cache (self-contained by design).

### 3.9 `js/config.js` (generated) / `js/config.example.js`
`window.CONFIG = { worker, wallhavenKey?, publishableKey?, clerkProxyUrl?,
 generatedAt }`. `config.example.js` is a stub. Never hand-edit `config.js`.

**Dedicated Clerk instance — no morphica, no proxy**: the extension has its
OWN Clerk project (a test instance today: app "glisters", instance id
`ins_3IIf1c86bRb7ZBuC8Ucy9yDkZdC`). The publishable key's domain is real
(`tidy-marmoset-1299.clerk.accounts.dev`), so no proxy is needed —
`CLERK_PROXY_URL` is only an optional override for a dead/custom pk domain
and is empty in the current `.env`.

**In-extension auth (raw Clerk REST API — no ClerkJS, no hosted-page
redirects)**: the Clerk API refuses to start OAuth verification for
extension clients (the sign-in `create` always returns `needs_identifier`
without a verification URL, and `oauth/authorize` 401s — reproduced on both
instances), so no SDK ships in the extension and Google OAuth is unavailable
in-page. What DOES work from the extension origin is password sign-in and
email-code sign-up, via raw REST calls that carry a **dev browser token**
minted by `POST /v1/dev_browser` (a JWT, passed as the `__clerk_db_jwt`
query param on every request — exactly what ClerkJS does internally in dev
mode). `js-src/auth.js` derives the instance's frontend API from the
publishable key (the pk base64-decodes to
`<instance>.clerk.accounts.dev`). The settings drawer's account row opens an
**in-extension auth overlay** (`#authOverlay` — blurred backdrop, sharp
corners, tabs):

- **Sign in**: `POST /v1/client/sign_ins {identifier, password}` (ClerkJS's
  own single-shot password call — no `strategy` field). Unknown email →
  `needs_identifier` → "no account, try sign-up"; if the API ever asks for a
  factor, a follow-up `prepare_first_factor {strategy:'password'}` is made.
- **Sign up**: bot protection was ON for sign-ups (a Cloudflare Turnstile
  token was required — widget rendered in a sandboxed iframe `captcha.html`,
  see §3.17). **Turnstile cannot run in a null-origin sandbox** (its script
  reads `window.top.location`; Chrome throws "Blocked a frame with origin
  null…"), so captcha was turned OFF in the Clerk dashboard (Security → Bot
  protection; dev instance, no risk). The extension auto-detects this from
  `/v1/environment` — when `display_config.captcha_public_key` is null,
  sign-up skips the widget and sends no captcha fields. Flow: `POST
  /v1/client/sign_ups {strategy:'email_code', email_address}` →
  `prepare_verification {strategy:'email_code'}` sends the code →
  `attempt_verification {strategy:'email_code', code}` verifies → `PATCH
  /v1/client/sign_ups/{id} {strategy:'password', password}` — the sign-up
  then completes and returns the session.
- **FAPI form-encoding gotcha (critical)**: Clerk's FAPI parses request
  params from `application/x-www-form-urlencoded` bodies — JSON bodies
  silently fail field validation on some endpoints (e.g. `prepare_verification`
  returns 422 "strategy must be included" even when the JSON contains it;
  create/sign-in happen to accept JSON). `apiFetch` therefore sends every
  body as `URLSearchParams`, sends PATCH as `POST ?_method=PATCH` (form
  encoding can't PATCH), and appends `__clerk_api_version=2026-05-12` +
  `_clerk_js_version=6.29.2` — exactly what ClerkJS's FAPI client does.
  A 401 (`dev_browser_unauthenticated`, expired dev token) mints a fresh
  token and retries once.
- **Session**: the JWT from `client.sessions[0].last_active_token` is stored
  in chrome.storage (`glisters-auth`) and reused across reloads; expired
  tokens are refreshed via `POST /v1/client/sessions/{sid}/tokens` with the
  old JWT as Bearer. User info comes from `GET {frontend}/v1/me`. The dev
  browser token is cached in chrome.storage (`glisters-db-jwt`).
- **Sign out**: `DELETE /v1/client/sessions` with Bearer + local state
  cleared.

The extension never touches morphica's domain or cookies — the two Clerk
projects are fully separate.

### 3.10 `worker/src/index.js` (~270 lines) — Cloudflare Worker
- **Auth**: every `/save` and `/backup` request must carry
  `Authorization: Bearer <clerk-session-jwt>`; `@clerk/backend` verifies it
  against `env.CLERK_SECRET_KEY` (set via `wrangler secret put
  CLERK_SECRET_KEY` / `worker/.dev.vars` locally). Missing/forged/expired
  tokens → `401` — the worker is locked down even before the secret is set.
  `/meta` stays public (no user data involved).
- **Per-user keys**: R2 objects are namespaced `Glisters/users/<userId>/…`
  (`save.json`, `save.prev1.json`, `save.prev2.json`) — every user gets their
  own save, backups, and seed guard.
- Routes: `OPTIONS` preflight (CORS `*`, allows `Content-Type`,
  `X-Glisters-Seed`, `Authorization`); `GET/PUT /save`; `GET /backup`;
  `GET /meta?url=` (server-side title/icon scraping, CORS-free).
- **Last-write-wins**: PUT parses incoming `updatedAt`, compares with the
  stored doc; if stored is newer → `409` so the client pulls and adopts.
- **Never lose the previous save**: before every accepted overwrite the
  outgoing doc is rotated to `save.prev1.json` (then `save.prev2.json`) — a
  clobber (seed, bug, stale client, malicious PUT) is one `PUT /save` away
  from being undone via `GET /backup`. Backup is best-effort and never blocks
  the write.
- **Seed guard**: a PUT flagged `X-Glisters-Seed: 1` (the client's fresh
  install seeding from `links.txt`, before any real edits) is rejected with
  `409` when a save already exists — and for a brand-new user when the legacy
  save is still unclaimed — so a wiped local store can never overwrite real
  cloud data; the client pulls and adopts instead.
- **Legacy migration**: the pre-multi-user save at `Glisters/save.json` is
  claimed by the **first** signed-in user: copied into their key, then moved
  aside (deleted + `Glisters/legacy-claimed.json` marker). Later sign-ins
  start fresh. Covered by smoke tests (`worker/test/run.mjs`).
- **SSRF guard** (`isPrivateHost`) on `/meta`: only public http(s), ports
  80/443; rejects localhost/`.local`/`.internal`/metadata, all private IPv4
  ranges (0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24,
  192.168/16, 198.18/15, 224/4+), private IPv6 (::1, fc/fd, fe8-feb,
  ::ffff:127.). Redirects are followed manually (≤3 hops) with the guard
  **re-run per hop**. 4MB body cap, browser UA. Failures → empty `{title:'',
  icons:[]}` rather than an error.

### 3.11 `worker/wrangler.toml`
Worker name `glisters`; `main = "src/index.js"`; `compatibility_date
= "2024-11-01"`; `[[r2_buckets]]` binding `SAVE` → the R2 bucket named in
`wrangler.toml`. Deploy: `wrangler deploy`.

### 3.12 `scripts/gen-config.mjs`
Parses `.env` (simple `KEY=VALUE` lines), requires `R2_WORKER_URL`, optional
`WALLHAVEN_API_KEY`, writes `js/config.js` as JSON with `worker`,
`wallhavenKey`, `generatedAt`. **Run `node scripts/gen-config.mjs` after
editing `.env`.**

### 3.13 `scripts/gen-icons.mjs`
Generates `icons/icon{16,48,128}.png` with a hand-rolled PNG encoder (zlib
deflate + CRC32): dark square, thin light frame, hollow centre. Zero image
dependencies. Run `node scripts/gen-icons.mjs`.

### 3.14 `default-save.json` / `links.txt`
First-run seed, in priority order: `default-save.json` (a complete save doc
with ~48 popular websites + default settings — the primary template) →
`links.txt` (one URL per line, legacy override) → the baked-in
`DEFAULT_SITES` in app.js. A fresh install renders the baked defaults on
first paint, then `loadSeed()` fetches `default-save.json` (normalized) and
falls back down the chain. An absent/invalid file falls back to the baked
defaults (no more silent empty grid). Names are derived at seed time. Bump
`SEED_VERSION` in app.js to re-seed existing installs.

### 3.15 `icons/`
16/48/128 PNGs (generated). Referenced in manifest + visual only.

### 3.16 `.env` / `.env.example`
`.env` holds `R2_WORKER_URL` (deployed worker URL) and optional
`WALLHAVEN_API_KEY`. Committed keys in the live `.env` today: the deployed worker URL
and the Clerk publishable key — both are public-scope secrets by design (see
Security). **Never commit real secrets elsewhere.** `WALLHAVEN_API_KEY` is
intentionally empty by default: each user supplies their own key via the
drawer field (`wallhaven.cc/settings/account`) so NSFW only works with a
user-supplied key.

### 3.17 `captcha.html` (sandbox page) — Turnstile captcha
MV3's `extension_pages` CSP only permits `'self'` in `script-src`, so the
Cloudflare Turnstile widget (`challenges.cloudflare.com`) can never load in
`newtab.html` itself. `captcha.html` is therefore declared as a **sandbox
page** in the manifest (`sandbox.pages` with its own relaxed CSP that allows
`https://challenges.cloudflare.com` for script/frame/connect). `auth.js`
embeds it as an `<iframe sandbox="allow-scripts allow-forms allow-popups
allow-modals">` inside `#authCaptcha`; the widget's token is returned to the
parent via `postMessage` (`{source:'glisters-captcha', type:'token'|'ready'|
'expired'|'error'}`), and commands (reset) go the other way
(`{source:'glisters-parent', type:'reset'}`). The iframe is recreated on
demand (`ensureCaptchaFrame`/`destroyTurnstile`), so no widget is ever left
mounted on the sign-in tab or after the overlay closes.

---

## 4. The shared save document ("the doc")

Serialize me with `app.doc()`; the cloud worker stores one object at
`Glisters/save.json`.

```jsonc
{
  "version": 2,                // SEED_VERSION in app.js
  "updatedAt": 1723456789012,  // ms epoch; LWW arbiter
  "sites": [
    { "id": "…", "name": "GitHub", "url": "https://github.com",
      "icon": "https://…" /* optional */ }
  ],
  "settings": {
    "iconSize": 72, "colGap": 24, "rowGap": 22, "cols": 6, "rows": 5,
    "labels": true, "labelOp": 100, "labelColor": "#f5f5f5",
    "bkWidth": 360, "drWidth": 320, "mono": false, "wallMono": false,
    "blur": 0
  },
  // joined only when the module is present (guarded):
  "bookmarks": { "v": 1, "updatedAt": 0, "folders": [], "items": [], "deletedChromeIds": [] },
  "walls": { "v": 9, "key": "…url…", "list": ["…10 urls…"], "lastRefresh": 0,
             "purity": "100", "category": "100", "apikey": "", "favs": [], "safe": "" }
}
```

Slices are validated by their owners (`normalize` in app.js, `setData`/`adopt`
in the modules). A missing/stale slice must never erase what the user already
chose — that is why `adopt()` in walls.js restores the previous state when the
incoming doc is empty/stale, **unions** the favourites list in rather than ever
replacing it, and bookmarks `adopt()` keeps local state when it is newer while
still unioning tombstones.

**Favourites are never replaced — only ever unioned.** `adopt()` merges the
incoming doc's `favs` into the existing list (dedupe, capped at `FAV_MAX`);
the only way a favourite leaves the list is `removeFav()`. On boot
`reconcileFavs()` unions favourites across every surviving copy — the walls
doc and the app doc's walls slice, each in localStorage and chrome.storage —
so a stale/corrupt/missing single store can never erase one. A favourite only
disappears if it is gone from every copy at once (or the user removed it).
Trade-off, by design: removing a favourite on one device does not propagate
to other devices' copies until they remove it too — preservation wins over
removal propagation.

**Conflict semantics**: worker rejects PUTs whose `updatedAt` is older than the
stored one (409). The client then pulls and adopts the newer doc. This is the
"silent data loss" guard — never break it.

---

## 5. Storage layers (in priority order)

1. `state` — in-memory, canonical.
2. `localStorage` — fast synchronous read at boot; *not* durable across
   extension reloads.
3. `chrome.storage.local` — the durable mirror (survives reloads and local
   storage eviction). Each module keeps its own key(s):  - `glisters` (app doc), `glisters-previous` (pre-adoption stash, see §7),
  - `glisters-icons` (shared favicon winner map),
  - `glisters-walls` (wallpaper doc), `glisters-bk-ui` (sidebar panel open
    state only — the sidebar itself stores nothing; it edits Chrome's
    bookmarks directly).
4. Cloud (R2 via Worker) — mirror + per-user multi-device; each save lives at
  `Glisters/users/<userId>/save.json`, plus the automatic previous-save
  copies `save.prev1/prev2.json` kept by the worker before every overwrite
  (recoverable via `GET /backup`). The pre-multi-user legacy save at
  `Glisters/save.json` is claimed by the first sign-in.
Rule of thumb: **chrome.storage is authoritative for durability; localStorage
is the fast path; cloud is a mirror that newer-wins.** Boot always reconciles
chrome.storage into memory before doing destructive work (see bookmarks boot
ordering).

---

## 6. Module contract (hooks)

Modules are independent IIFEs that expose a guarded object; **app.js owns the
only `commit()` and calls module hooks; modules never call app.js directly.**

| Hook | Owner | Signature | Used by |
|---|---|---|---|
| `window.CONFIG` | config.js | `{ worker, wallhavenKey, publishableKey, generatedAt }` | app/sync/walls |
| `window.AUTH` | auth.js | `{ ready, enabled, isSignedIn, user, getToken(), signIn(), signOut(), onChange(fn) }` | app/sync |
| `window.SYNC` | sync.js | `{ cfg, push(doc, seed?)→Promise, pull()→Promise }` | app.js |
| `window.BOOKMARKS` | bookmarks.js | `{ bind(cb), forDoc(), restore(obj), refreshFromChrome() }` | app.js |
| `window.WALLS` | walls.js | `{ bind(cb), forDoc(), restore(obj), next, refresh, reload, filter, key, fav, favPool, setSafe, applySafe, download }` | app.js |

`bind(commit)` hands the app's `commit()` to a module so any module-side change
triggers `persistLocal` + cloud push on the whole doc. `forDoc()` supplies the
module's slice. `restore(obj)` adopts an incoming slice (validated). app.js
accessed these as `window.BOOKMARKS`/`window.WALLS` with existence checks
(`if (window.BOOKMARKS)`), so either module failing to load never breaks the
grid.

---

## 7. Key flows

### Boot (app.js init, `js/app.js:1813`)
1. `loadPersistedIcons()` sync-read into memory (before first render).
2. `renderAll()` on current (possibly seeded) state.
3. If `needSeed`: try `chrome.storage.local` restore → else `links.txt` → else
   empty. Marks `seededFromLinks`.
4. `AUTH.onChange` is subscribed up-front: it fires immediately (current state)
   and on every sign-in/sign-out/session-restore — the single entry that
   (re)runs `syncStart()` per user.
5. `syncStart()`: reconcile cloud (see §4/§5 rules) — only when signed in;
   otherwise the pill reads "sign in to sync" and the grid stays fully local.
6. `BOOKMARKS.bind(commit)` + `restore(state.bookmarks)` (both inert — the
   sidebar edits Chrome directly now); `WALLS.bind` + `restore` do real work.
Note the page never steals focus (address bar keeps it) — keys only live after
the user clicks/tabs in.

### Cloud sync decision (app.js)
- **Signed out**: the grid is fully local — edits persist to
  localStorage/chrome.storage and bump `updatedAt` + `dirty`, but nothing
  touches the cloud. The pill reads "sign in to sync"; the sync button opens
  the Clerk sign-in popup instead of pushing.
- **Signed in**: local edits → `commit()` → `scheduleCloud()` → push in 1.3s.
  The first real edit clears `seededFromLinks` so later pushes are never
  flagged as seeds. Edits made while signed out sync up on sign-in (their
  `updatedAt` is newer, so the normal LWW path pushes them).
- Push failure → dirty, retry 20s + on `online`/focus/unload.
- Push 409 → pull newer, `adoptRemote`. Push 401 (dead/expired session) →
  dirty stays, pill reads "sign in to sync", no retry loop.
- Boot pull → newer remote (and not locally dirty) wins via `adoptRemote`;
  otherwise push local. A fresh install / wiped store adopts ANY valid
  cloud doc (even an empty one — the user may have cleared it deliberately)
  rather than seeding over it; the seed is only pushed when the cloud has
  nothing at all, and even then flagged so the worker can refuse if a save
  appears in between.
- `adoptRemote` first stashes the outgoing local doc under
  `glisters-previous` (localStorage + chrome.storage) so a bad adoption is
  undoable via settings → backup → restore previous.
- Settings → backup → download saves the whole doc as a JSON file.
- Settings → backup → load… imports a local JSON file (normalized, confirmed,
  stashed, bumped `updatedAt` to now).
- Settings → backup → push local forces an immediate cloud push (bypasses
  the 1.3s debounce).

### Favicon for a tile
`tileEl` → cached decoded element? reuse. Else `persistedIcons[key]` (single
preferred candidate) → else `iconCandidates(site)` → `loadIcon` races
preferred-first, largest-wins-fallback with 6s guard → winner cached in
`faviconCache` + debounced-persisted; failures scheduled for 5/10/15s retries.

### Wallpaper apply
`state.key` url → `safeWallUrl` → blob URL if `materialize`d (instant), else
real url now and swap to blob when ready → background swapped, current badge
highlighted, doc touched (cloud push). Blobs/cache pruned to the pool + favs +
safe.

### Bookmark add (write-through)
Editor save → optimistic STORE push → `touch()` → render →
`withChromeNode` materializes parent chain + node into chrome → chromeId
backfilled. Deleting tombstones chromeIds (re-duplicated in Chrome and STORE,
so the async merge window can't resurrect them).

---

## 8. Keyboard reference (consolidated)

| Key | Grid | Bookmarks | Wallpapers (bare page) |
|---|---|---|---|
| `h j k l` / arrows | move | move / back | — |
| `enter`/`o` | open (ctrl/meta + enter/o = new tab) | open link/folder | — |
| `tab`/shift+tab | page | (consumed) | — |
| `/` `:` | command bar | — | — |
| `a` / `A` | add | add link / add folder | — |
| `e` | edit | edit | — |
| `d` | delete (arm) | delete (arm) | — |
| `g` / `G` | first / last | first / last | — |
| `s` | settings drawer (esc closes) | — | — |
| `b` / `B` | — | toggle sidebar | — |
| `w` | — | — | next wallpaper |
| `r` / `R` | — | — | reload pool |
| `f` / `F` | — | — | favourite / favourites-pool |
| `D` (or `d` in drawer) | — | — | download current wallpaper |
| `space` (×1/×2) | — | — | save safe / apply safe |
| `esc` | close anything | close | — |

---

## 9. Security model (already implemented — preserve it)

- **No HTML injection**: `textContent` for all dynamic strings; static SVG via
  `innerHTML` only.
- **CSP** in manifest: `extension_pages` CSP only allows `'self'` in
  `script-src` (MV3 restriction; external scripts are loaded via a sandbox
  page, see `captcha.html`). `connect-src 'self' https:`; images
  https/data/blob.
- **URL guarding**: `normUrl()` in app.js and bookmarks.js only ever navigate
  to `http(s)`/`mailto` — `javascript:`/`data:`/`file:` are dropped
  (cloud-save tamper defense).
- **Cloud-boundary sanitizing**: site name ≤300, url ≤4096, icons must be
  `https://`; `safeWallUrl()` re-parses wallpaper urls before
  `background-image`; bookmarks `setData` cleans each node.
- **Worker SSRF guard** on `/meta` with per-hop redirect re-validation and 4MB
  caps.
- **Worker JWT auth**: every `/save` and `/backup` request must carry a
  Clerk-session JWT; the worker verifies it with `@clerk/backend` and
  `env.CLERK_SECRET_KEY`. Missing/forged/expired tokens → `401`. The worker
  is locked down even before the secret is set (verification fails → `401`).
  `/meta` stays public (no user data).
- **Per-user namespacing**: each user's save lives at its own R2 key, so a
  compromised token is limited to one user's data. Old single-save legacy
  (`Glisters/save.json`) is claimed by the first sign-in, then moved aside.

---

## 10. Performance notes (things the code optimizes)

- Favicon winners persisted across sessions: repeat boots ≈ 1 cache-hit request
  per tile instead of a 4–6 candidate blast.
- `loadIcon` decodes async (`decoding='async'`, `referrerPolicy='no-referrer'`),
  upscales small favicons integer-only (`.sharp`).
- Page flips clone a snapshot + animate; ghosts removed on `animationend`
  + 600ms safety.
- Wallpapers: `<img>` warming → HTTP cache; Cache Storage → blob URLs; pruning
  bounds memory/disk; drawer thumbs lazy.
- Slider edits: live CSS via `applyCssVars()`, heavy `commit` debounced 250ms;
  only capacity changes rebuild the grid.
- Fonts async; preconnects to fonts/gstatic/wallhaven/DDG.
- Meta fetch capped at 4MB + 8s abort + per-url cache.

---

## 11. Conventions to follow

1. **ES5 style**: IIFEs, `'use strict'`, `var`, closures, no arrow functions in
   the extension (worker may use modern JS).
2. **Self-contained modules**: each feature file keeps its own DOM refs, state,
   keys, persistence keys, and public object. Communicate with app.js only via
   the guarded hooks in §6.
3. **Never mutate app doc in a module without `touch()`/`bind` commit**.
4. **Guard all cross-module access** (`if (window.X)`) — missing modules must
   never break the page.
5. **Always sanitize values that cross the cloud boundary** (see §9).
6. **`textContent` for data, `innerHTML` only for static SVG**.
7. **chrome.storage is the durable copy; boot must reconcile it before
   destructive work.**
8. **Never let a fresh seed overwrite a real save** — client prefers the
   cloud on boot; the worker refuses seed-flagged PUTs over an existing doc.
9. Bump `SEED_VERSION` (app.js) deliberately and document why; bump walls doc
   `v` only with a migration path.
10. Run `node scripts/gen-icons.mjs` (initial), `node scripts/gen-config.mjs`
    (after `.env` changes), and `node scripts/gen-auth.mjs` (after
    `js-src/auth.js` changes). No lint/typecheck/build pipeline exists — the
    app is plain script tags; validate by loading the extension.

---

## 12. Deployment & wiring

Frontend:
1. `node scripts/gen-config.mjs` (needs `.env`).
2. `chrome://extensions` → Developer mode → Load unpacked → this folder.
3. Reload the extension after config changes.

Cloud:
1. `cd worker && wrangler secret put CLERK_SECRET_KEY` (the Clerk secret key
   — never in .env; local dev uses `worker/.dev.vars`).
2. `cd worker && wrangler deploy` (requires the R2 bucket + `SAVE` binding
   declared in `wrangler.toml`).
3. Put the returned URL in `R2_WORKER_URL` inside `.env`, plus
   `CLERK_PUBLISHABLE_KEY` (the Clerk app's publishable key — public by
   design).
4. Re-run `node scripts/gen-config.mjs`, reload the extension; settings →
   account row: sign in; sync pill should read `synced`.
5. Clerk Dashboard → your app → allowed origins must include
   `chrome-extension://<your-extension-id>` (the pinned manifest key keeps
   this id stable).

---

## 13. Known quirks & gotchas (read before editing)

- `linka.txt` seeding failures are silent — a fresh install with no `links.txt`
  seeds an empty grid and shows the empty state.
- `window.open(url,'_blank','noopener')` returns `null` per spec, so
  bookmarks.js intentionally uses the synthetic-`<a>` fallback with
  `ignoreOutsideClick` to avoid the outside-click-to-close handler firing.
- `suppressClick` clear is deferred (`setTimeout 0`, capture-phase listener) so
  the grid's bubble click still gets its suppress chance after a drag ends
  outside the grid.
- Wallhaven: guests can't request NSFW; the NSFW purge button is disabled
  without a key; removing the key while on NSFW drops back to Sketchy (`110`).
- `isBuiltin()` decides which wall tiles show a remove control — sourced
  Wallhaven/Fallback items can't be removed, only hand-added URLs.
- Favourites + safe wallpaper are deliberately **kept** in the cache even after
  they leave the pool (`pruneBlobs` keepSet).
- The favicon cache key is the **url** — changing a url/icon on edit must clear
  `faviconCache`, `iconLoading`, and `persistedIcons` for the old url (and the
  new one when a picked icon differs) or stale icons persist.
- The bookmarks favicon `glisters-icons` cache is **shared** with the grid —
  same map, same key; don't diverge them.
- Modal Esc only closes the modal while `mode === 'modal'`; the grid's keystrobe
  handler early-returns while `mode` is modal/bar.