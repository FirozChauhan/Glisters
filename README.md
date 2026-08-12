# Glisters — new tab

Minimal, keyboard-first new tab page. Sharp corners, mono labels, faint textures,
a vim-driven shortcuts grid, and your save file synced through a Cloudflare Worker.

## Features

- 6x5 shortcut grid; extra links flow onto further pages that loop — `tab` /
  `shift+tab`, `pgdn`/`pgup`, or mouse wheel flips them (shows `n / total`)
- Favicons resolve hi-res-first: curated official icons → the site's own
  `apple-touch-icon.png` (120-192px) → `favicon-32x32.png`/`favicon.ico` →
  Google's `s2` re-render (host + parent-domain variants, so
  `web.whatsapp.com` resolves to `whatsapp.com`) → DuckDuckGo, with a 6s
  guard, lazy retries (5/10/15s, up to 3) and a letter monogram that hides
  once an icon loads. Google product icons use the 2x gstatic logos (128px)
  resolved by host *and* path (`www.google.com/maps/` → the Maps pin,
  `docs.google.com/…` differentiates Sheets/Slides/Docs/Forms), plus
  DeepSeek. Re-render services cap at the site's native favicon size, so a
  real hi-res icon always beats them (no race); a 16px globe fallback never
  settles.
- The add/edit modal **auto-detects the title** when you type a URL (og:title
  first, then `<title>`, fetched directly thanks to the host permission, with
  the sync worker's `/meta` route as a CORS-safe fallback; the name field
  fills optimistically from the hostname and never overwrites what you typed)
  and offers an **icon picker** — a row of circular choices built from the
  same candidate machinery the grid uses plus any icons the page declares,
  with an `auto` option that falls back to normal resolution. The picked icon
  is stored on the shortcut and pre-selected when you edit it.
- Settings persist to `localStorage` and sync with the cloud **last-write-wins
  by timestamp** — a stale copy (another tab, another device, an older
  boot) can never clobber a newer save: the worker rejects older `updatedAt`
  PUTs with 409, the client then re-pulls and adopts the newer doc, and the
  boot restore adopts a newer cloud save instead of pushing the older local
  copy over it (the old behavior could show `synced` while silently
  reverting changes made elsewhere)
- Vim keys: `h j k l` move · `enter`/`o` open · `a` add · `e` edit · `d` delete ·
  `g` first · `shift+g` last · `/` command bar · `s` settings · `esc` close
- The page is served directly as the newtab override, so Chrome keeps the
  address bar focused by default — type straight into the bar like a stock
  new tab. Click or tab into the page and the vim keys take over; the custom
  `/` bar opens URLs, site names, or a Google search (`Ctrl+L` returns to the
  bar)
- Mouse wheel scrolls the grid horizontally (grid can overflow past the viewport)
- Drag a tile to reorder
- Settings (top-right) organised into compact one-line rows across **layout**
  (icon size, column/row gap, grid columns/rows, labels, label opacity/color,
  monochrome icons, sidebar width 280–560px and drawer width 256–520px — all
  persisted and resized live), **wallpapers** (a pool of 10 sourced from
  **Wallhaven's keyless API** — the monthly **toplist**, deduped by photo id;
  a random page is picked each time so the pool rotates through different top
  wallpapers, portrait and non-wide shots are filtered out client-side, and a
  **Purity** (SFW / Sketchy / NSFW) + **Category** (General / Anime / People)
  picker rebuilds the search on the fly — NSFW is gated behind an optional
  wallhaven **API key** field, the 24-hour freshness check pulls a new set
  and advances the background, the **reload** button (or `r`) swaps in 10
  photos that aren't in the current pool, `w` cycles the pool, `f` saves the
  current wallpaper to a persistent **favourites** list (also via the drawer's
  "add current" button; favourite tiles keep working offline and sync like the
  pool), `space` saves the current wallpaper as your **safe** default and
  `space space` applies it (also via the drawer's "set current"/"apply"
  buttons; the safe pick keeps working even after it leaves the daily pool),
  an offline fallback keeps the last pool, and extra links can be
  pasted in from the settings drawer; the choice persists and syncs), **sync**
  (color-coded status pill: green synced, red
  offline/error, amber syncing; storage chips for extension id, localStorage,
  and chrome.storage), and **keys** (two-column cheat sheet) groups — a pinned
  chip bar under the drawer header jumps between sections and tracks where you
  are as you scroll
- Bookmark sidebar slides in from the **right** (`b` or the right-edge
  button); the settings drawer lives on the **left** (`s` or the left-edge
  gear). The sidebar defaults to 360px wide with a roomier type scale; the
  drawer defaults to 320px; both share the same theme and can be resized from
  the settings drawer's **layout** group. Clicking anywhere outside the
  sidebar closes it; clicking a bookmark opens the link in a new tab **in the
  background** (`chrome.tabs.create` with `active: false`) so the new-tab page
  stays in view and keeps focus — it never navigates away
- Bookmark sidebar: **drill-down folders** — opening a folder fills the whole
  panel; a back arrow and `home / folder / subfolder` breadcrumbs return
  anywhere up the chain (`h`/`←` steps back, focus lands on the folder you
  came out of). The sidebar is deliberately bare — no toolbar and no footer;
  adding is keyboard-only (`a` link / `shift+a` folder) or via the empty-state
  button. Search with breadcrumb paths, drag & drop reorder/move (drop
  before/after rows or into folders), add/edit/delete (delete arms like the
  grid), favicons, and its own keyboard map: `j/k` move · `enter` or `l` open
  folder/link · `h`/`←` back · `a` add link · `shift+a` add folder · `e` edit
  · `d` delete · `g/G` first/last · `esc` close. Bookmarks ride inside the same
  save file, so they sync to the cloud alongside the grid
- **Chrome bookmarks auto-import**: with the `bookmarks` permission the sidebar
  mirrors your real Chrome bookmarks — fetched automatically on load and after
  every restore/cloud pull (and on demand via the refresh button in the sidebar
  header). It's a one-way merge: nodes you've already imported get title/url
  updates, hand-made folders with the same name are adopted instead of
  duplicated, new Chrome bookmarks are appended, and anything you added or
  rearranged in the sidebar is never overwritten (deletions in Chrome don't
  remove sidebar entries). The sidebar is a **real editor for Chrome's
  bookmarks**: with the `bookmarks` permission every add / edit / delete /
  drag-and-drop move is written straight through to `chrome.bookmarks`
  (create/update/remove/removeTree/move), so changes persist in Chrome itself
  — deleting a folder here really deletes it in Chrome, and new links show up
  in chrome://bookmarks and sync to your other devices. The local mirror
  updates optimistically and backfills the real chrome id from the API
  result; legacy local-only nodes (created before write-through, or while
  Chrome was unreachable) are materialized into Chrome on demand — including
  their parent chain — the first time you touch them. Tombstones remain as a
  safety net for the async window and stay monotonic: they're always unioned
  in (never replaced) and any already-imported zombie node they cover is
  purged, so no stale slice — local, cloud, or the shared save file — can
  resurrect something you deleted. Boot is also ordered: the first Chrome
  merge waits for the durable chrome.storage copy (extension reloads can wipe
  page localStorage), so tombstones are always in memory before anything is
  imported. Without the permission, everything degrades to the old
  local-only behavior
- Data persisted to `localStorage` instantly + synced through a Cloudflare
  Worker (which owns the R2 bucket server-side, so no credentials ship with the
  extension); while offline it stays local and auto-pushes on reconnect
  (`online`, tab-focus, page unload) and retries every 20s
- First run seeds shortcuts from `links.txt` (one URL per line, name derived from
  the host). Bump `SEED_VERSION` in `js/app.js` to re-seed existing installs
- Signature footer, Geist / Geist Mono / Aref Ruqaa Ink fonts

## Install

1. `node scripts/gen-icons.mjs`
2. chrome://extensions → enable Developer mode → **Load unpacked** → this folder
3. Open a new tab.

## Cloudflare sync

The extension PUTs/GETs your whole save file through a Cloudflare **Worker**
(`worker/`), which holds the R2 binding and the bucket key server-side — the
extension never sees an R2 credential. Load order: instant local → remote merge
(newer wins).

1. `cd worker && wrangler deploy` (the R2 binding is declared in
   `worker/wrangler.toml` — point `bucket_name` at the bucket holding your
   save file).
2. Copy `.env.example` to `.env` and set `R2_WORKER_URL` to the deployed
   Worker's public URL.
3. `node scripts/gen-config.mjs` → writes `js/config.js` (the worker URL only).
4. Reload the extension. Open settings → you should see the sync pill move from
   "cloud off" to "synced".

The Worker only exposes `GET/PUT /save` with permissive CORS (`*`), so it cannot
list or touch other objects in the bucket. Without a config, the extension runs
fully local (`cloud off` in settings).

## Wallpapers

No cloud storage involved — wallpapers are **public image URLs** fetched from
**Wallhaven's keyless API** (`wallhaven.cc/api/v1/search`): the **monthly
toplist** (`sorting=toplist&topRange=1M`). Because the toplist is
deterministic, every pull picks a **random page** of it to keep the pool
rotating through different top wallpapers, then filters the shots
**client-side** to wide ones (aspect ratio ≥ 1.5 — portrait, 4:3, 5:4 and
square shots are dropped; the API's `ratios` param only accepts exact ratios
like `16x9`, so it can't express "any wide"). Up to three random pages are
tried to fill the 10 slots on portrait-heavy feeds.

The settings drawer offers a **Purity** picker (SFW / Sketchy / NSFW — each
level includes everything tamer, so Sketchy = SFW+Sketchy and NSFW = all) and
a **Category** picker (General / Anime / People), matching the wallhaven
site's bitmasks (`100`/`010`/`001`). Picking a new filter immediately pulls a
fresh pool matching it. **NSFW requires a wallhaven API key** — the optional
**API key** field appends `&apikey=` to every request; without it the NSFW
button is disabled, and removing the key while on NSFW steps you back to
Sketchy. The key is saved with the pool (localStorage + chrome.storage + the
shared save file), same as every other setting.

The key can be set two ways: paste it in the drawer's **API key** field (saved
per user and wins over anything baked in), or ship it with the extension by
putting `WALLHAVEN_API_KEY=` in `.env` and running `node
scripts/gen-config.mjs` — that bakes it into `js/config.js` so NSFW is
unlocked out of the box.

Every **24 hours** the extension grabs a fresh 24 (the API per-page max),
keeps 10 deduped photos (one slot per photo id), and advances the background
to a new shot. The **reload** button in the settings drawer (or the `r` key)
re-fetches and drops the current pool's photos first, so the new 10 are
guaranteed different from what you had. `w` cycles through the pool manually. **Favourites** (`f`, or the "add
current" button) save the wallpaper that's on screen into a persistent
favourites list — it lives in the same doc and save file as the pool, so it
syncs to the cloud and survives forever, independent of the daily pool
rotation. Click a favourite tile to make it the background, hover to remove
it; favourites are kept in the image cache too, so they stay instant and
offline. Shift+`F` swaps the active pool for your favourites — `w`/reload
then cycle through the saved list instead of the wallhaven set. The **safe wallpaper** is your quick-return default: `space` saves
the wallpaper that's on screen (or the drawer's "set current" button), and
double `space` / "apply" snaps straight back to it — the shot stays in the
image cache even after it rotates out of the daily pool, so it applies from
disk, offline, whenever you want it. If Wallhaven is unreachable (offline/throttled) the last pool is kept
untouched; with nothing saved at all, a small curated Unsplash set fills in
until the next successful fetch. Thumbnails in the settings drawer load lazily
and are pulled from Wallhaven's `th.wallhaven.cc` CDN. Paste any image URL to
add your own, and hover a custom tile to remove it. The pool + choice are saved
in the sync doc like any other setting.

**Switching is instant**: as soon as a pool loads, every full-size shot is
warmed in the background — primarily through plain `<img>` preloading, which
needs no CORS and drops the bytes straight into the browser's ordinary HTTP
cache, so a `background-image` swap of the same URL is served from disk
instead of the network (this works in any context, even a local dev server or
`file://`). As a bonus layer, the shots are also copied into the extension's
**Cache Storage** (reusing the already-fetched bytes) for offline use and
persistence across restarts; applying a background prefers the local **blob
URL** of that copy. `w`, clicking a tile, and reload swaps are all
near-instant and keep working offline. Because the pool only rotates every
**24 hours**, the day's wallpapers stay cached for the whole cycle (and are
still there when you come back the next day, until the next pool replaces
them). Only small object URLs are held in memory — the heavy blobs live on
disk — and entries that leave the pool are pruned (the currently-shown shot is
always kept) so the cache stays bounded to roughly one pool's worth of images.

## Files

```
manifest.json          MV3 manifest (newtab override -> newtab.html)
newtab.html            the new tab UI itself (served directly, no redirect —
                       so Chrome keeps the address bar focused by default)
css/main.css           theme system (tokens in :root)
js/app.js              grid, vim keys, settings, modal, drag, wheel, links.txt seed
js/bookmarks.js        bookmark sidebar (self-contained; hooks into app.js via
                       window.BOOKMARKS.bind/forDoc/restore; merges real
                       chrome bookmarks via chrome.bookmarks.getTree)
js/sync.js             sync through the Cloudflare Worker (GET/PUT /save)
js/walls.js            wallhaven wallpapers: pool, purity/category filters, API
                       key, favourites, prefetch/image cache (window.WALLS)
css/bookmarks.css      bookmark sidebar styles
links.txt              one URL per line — first-run shortcut seed
js/config.js           generated from .env (gitignored; holds the worker URL only)
scripts/gen-config.mjs reads .env → writes js/config.js
scripts/gen-icons.mjs  generates icons/ PNGs
worker/                Cloudflare Worker (R2 binding) — deploy with wrangler
```

> Note: the new tab page is served directly (no redirect), so the address bar
> keeps Chrome's default focus and shows `chrome-extension://…/newtab.html`
> while the page is open.

## Security & performance

- **No HTML injection anywhere**: every user/cloud/Chrome-supplied string (site
  names, bookmark titles, search paths) is rendered via
  `textContent`; `innerHTML` is only used for static SVG icons and container
  clears. No `eval`, `document.write`, or dynamic HTML.
- **CSP**: `script-src 'self'; object-src 'self'; img-src https: data: blob:;
  connect-src 'self' https:` — no inline scripts, no remote code.
- **Cloud-save hardening**: values crossing the cloud boundary are clamped and
  validated on restore — site names ≤300 chars, urls ≤4096, icons must be
  plain `https://` (data:/javascript: URLs are dropped), and the wallpaper
  url is re-parsed before it touches `background-image`, so a tampered save
  can't inject CSS.
- **Modal title-fetch**: capped at 4 MB (via `content-length` and body size),
  aborted after 8 s, and cached per URL so re-opening the editor for the same
  site never refetches.
- **Worker SSRF guard**: the `/meta` route only fetches public http(s)
  targets on ports 80/443 — private/link-local/loopback/metadata ranges
  (10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, CGNAT, IPv6 loopback, …),
  local hostnames (`localhost`, `.local`, `.internal`, `metadata.google.internal`),
  and non-standard ports are rejected, and redirects are re-validated per hop.
- **Privacy**: favicons load with `referrerpolicy="no-referrer"`; links open
  with `noopener`; the address bar keeps Chrome's default focus.
- **Performance**: favicon results are cached per URL (decoded elements, no
  refetch on page flips) **and the winning icon per site is persisted across
  sessions** (localStorage + chrome.storage) — a new tab usually opens with
  one cache-hit request per tile instead of the 4-6 candidate blast, and a
  stale saved icon self-heals by falling back to full resolution. Measured:
  repeat boots drop from ~147 image requests / ~32 s aggregate to ~34 /
  ~2.4 s with all icons settled. Wallpapers lazy-load in the drawer,
  settings re-renders are debounced, page-flip
  ghosts are cleaned up on `animationend` (+ a safety net), Google Fonts
  load asynchronously (`media="print"` swap, `display=swap`) so first paint
  never waits on fonts.googleapis.com, and preconnects warm the heavy hosts
  (fonts, gstatic icons, wallhaven, DDG).

> Known limitation: the worker's `PUT /save` is unauthenticated by design (no
> credentials ship in the extension). Anyone who knows the worker URL can
> overwrite the save file — treat it as public scratch storage.
