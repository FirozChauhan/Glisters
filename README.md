# Glisters — New Tab

> Minimal new tab — shortcut grid, live Chrome bookmarks, Wallhaven wallpapers, Cloudflare sync.

![JavaScript](https://img.shields.io/badge/JavaScript-ES5--style-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?style=flat-square&logo=google-chrome&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![R2 Storage](https://img.shields.io/badge/R2-Storage-20232A?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white)
![Wallhaven -optional](https://img.shields.io/badge/Wallhaven--optional-3867d6?style=flat-square)

---

<img width="1879" height="961" alt="image" src="https://github.com/user-attachments/assets/f3d4262c-0c54-492b-8cbb-70891525b07a" />
<br><br>
<img width="1890" height="962" alt="image" src="https://github.com/user-attachments/assets/0375c0c8-ab6e-442b-88c6-fd1771e127a4" />

## Features

- **Shortcut grid** — vim-style keys (`h j k l`, `enter`, `a`, `e`, `d`) plus mouse drag-reorder with live flip animations and edge auto-flip across pages.
- **Live bookmarks sidebar** — a direct editor for Chrome's real bookmarks; changes from any device appear instantly.
- **Daily wallpaper pool** — 10 wide Wallhaven toplist shots cycled with `w`, favourites, a safe default, and optional NSFW (bring your own Wallhaven API key).
- **Cloud sync with a parachute** — per-user R2 mirror (Clerk sign-in); every write keeps the previous two saves recoverable via `/backup`, and a fresh install can never clobber real data.
- **Zero-config clone** — `js/config.js` + `js/auth.js` ship committed, so sync and sign-in work out of the box.
- **No bundler, no framework, no runtime deps** — plain ES5 script tags.

## Architecture

```mermaid
flowchart LR
  A[Chrome new tab] --> B[newtab.html shell]
  B --> C[app.js - grid, shortcuts, drag]
  C --> D[localStorage + chrome.storage.local]
  D --> E[Cloudflare Worker sync]
  E --> F[R2 save.json + prev backups]
  B --> G[bookmarks.js - chrome.bookmarks]
  B --> H[walls.js - Wallhaven pool]
```

Safety rails: every `/save` request carries a Clerk JWT verified by the worker; saves are last-write-wins with seed-guard and automatic previous-save rotation; the SSRF-proofed `/meta` proxy and client-side `normalize()` sanitize everything crossing the cloud boundary.

## Run Locally

Node ≥18 for the scripts/worker; the extension itself is zero npm dependencies.

```bash
# extension — load unpacked from chrome://extensions
chrome://extensions → Developer mode → Load unpacked → this folder

# cloud worker
cd worker
wrangler secret put CLERK_SECRET_KEY   # Clerk secret key — never in .env
wrangler deploy
```

## Configuration

| Env var | Required | Effect |
|---|---|---|
| `R2_WORKER_URL` | ✅ | Enables cloud sync |
| `CLERK_PUBLISHABLE_KEY` | — | Enables sign-in |
| `WALLHAVEN_API_KEY` | — | Unlocks NSFW (never shipped — users add their own) |

## Project Structure

```
js/app.js                 Grid, shortcuts, drag-reorder, sync orchestration
js/bookmarks.js           Bookmarks sidebar — direct chrome.bookmarks editor
js/walls.js               Wallhaven pool, favourites, safe wallpaper, blob cache
js/sync.js                Thin worker client (GET/PUT /save, Bearer JWT)
js/config.js              Generated runtime config (worker URL, publishable key)
worker/src/index.js       JWT auth, per-user LWW + seed guard, prev rotation, /backup, /meta
scripts/                  Build helpers (gen-config, gen-auth, gen-icons)
links.txt                 Optional first-run seed, one URL per line
```

---

Never lose a save, never lose a favourite.

---

<div align="left">
  <font face="Aref Ruqaa" size="5">فیروز خان چوہان</font>
</div>
