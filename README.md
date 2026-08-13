<p align="center">
  <img src="icons/icon.svg" width="88" height="88" alt="Glisters logo">
</p>

<h1 align="center">Glisters</h1>

<p align="center">
  A minimal, keyboard-first new tab for Chrome.<br>
  Sharp corners · mono labels · vim keys · no dependencies · no build step
</p>

---

## Features

- **Shortcut grid** — a 6×5 grid that paginates into more pages (`tab`, `shift+tab`, wheel), with drag-reorder and hi-res favicons that resolve favicon → apple-touch-icon → Google s2 → DDG, falling back to a letter monogram
- **Vim control** — `h j k l` to move, `enter`/`o` to open, `/` command bar, `a e d` add/edit/delete — everything, no mouse required
- **Bookmarks sidebar** — a right-edge panel that edits Chrome's real bookmarks directly (add, delete, move, drag-and-drop, folders, breadcrumbs) — no copy, no local store
- **Wallpapers** — a rotating 10-shot pool from Wallhaven's monthly toplist, purity/category filters, favourites, and a persistent "safe" wallpaper; 24-hour rotation with offline fallback
- **Cloud sync** — the whole save file mirrors to a Cloudflare Worker + R2, last-write-wins by timestamp (a stale copy can never clobber a newer one)
- **Settings drawer** — live sliders for grid layout, icon size, gaps, label styling, sidebar/drawer widths, monochrome icons
- **Privacy-minded** — no HTML injection (`textContent` everywhere), no remote code, no analytics, no telemetry

The page is served directly as the new-tab override, so Chrome keeps the address bar focused — type straight into the bar like a stock new tab. Keys take over once you click or tab into the page.

## Keys

| Key | Action | Where |
|---|---|---|
| `h j k l` / arrows | move | grid · bookmarks |
| `enter` / `o` | open (ctrl/meta = new tab) | grid · bookmarks |
| `tab` / `shift+tab` | next / previous page | grid |
| `/` | command bar (url, name, or Google search) | grid |
| `a` / `a` + `shift` | add shortcut / add bookmark link or folder | grid · bookmarks |
| `e` `d` | edit · delete (arm + confirm) | grid · bookmarks |
| `g` / `shift+g` | first / last | grid · bookmarks |
| `s` | settings drawer | grid |
| `b` / `shift+b` | open bookmarks | anywhere |
| `w` `r` | next wallpaper · reload pool | page |
| `f` / `shift+f` | favourite · favourites as pool | page |
| `space` / `space space` | save safe wallpaper · apply it | page |
| `esc` | close anything | everywhere |

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → this folder
2. Open a new tab.

First run seeds the grid from `links.txt` (one URL per line — edit or delete it to taste).

## Cloud sync (optional)

The extension works fully offline (`cloud off` in settings). To enable cross-device sync:

1. `cd worker && wrangler deploy` — the Worker fronts an R2 bucket; no credentials ever ship in the extension
2. `cp .env.example .env` and set `R2_WORKER_URL` to the deployed Worker's URL
3. `node scripts/gen-config.mjs` — writes `js/config.js` (the URL only)
4. Reload the extension → the settings sync pill reads `synced`

## Structure

```
manifest.json   MV3 manifest (newtab override)
newtab.html     the new tab page itself
js/app.js       grid, vim keys, settings, modal, sync orchestration
js/bookmarks.js bookmarks sidebar (Chrome write-through)
js/walls.js     wallhaven wallpapers + cache
js/sync.js      Cloudflare Worker client
css/            theme tokens + page styles
worker/         Cloudflare Worker (R2 binding), deploy with wrangler
scripts/        gen-icons + gen-config build helpers
```

## Security

- Every user/cloud/Chrome-supplied string renders via `textContent`; no `eval`, no dynamic HTML, no inline scripts (CSP)
- Values crossing the cloud boundary are clamped and validated on restore; wallpaper URLs are re-parsed before they touch `background-image`
- The worker's `/meta` route (server-side title/icon fetch) has an SSRF guard: public http(s) only, private ranges and local hostnames rejected, redirects re-validated per hop
- **Known limitation:** the worker's `PUT /save` is unauthenticated by design — treat the bucket as public scratch storage (safe for personal use; per-user auth is future work)

## License

MIT © 2026 Firoz Chauhan
