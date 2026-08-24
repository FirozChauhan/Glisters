# Glisters — Privacy Policy

*Last updated: 2026-08-24*

This policy explains what data the **Glisters** browser extension
("Glisters", "we", "our") collects, stores, and shares, and the choices you
have. It applies to the Firefox and Chrome versions of the extension.

Glisters is a minimal new-tab page: a shortcut grid, a bookmarks sidebar, and
optional wallpapers. **It contains no analytics, no telemetry, no advertising,
and no third-party trackers.** Your data is never sold.

---

## 1. What stays on your device

Glisters stores its working data in your browser's own local storage
(`localStorage` and `chrome.storage.local` / `browser.storage.local`). This
data never leaves your device unless you sign in to sync (see §3):

- **Your save** — shortcut tiles (names, URLs, chosen icons), grid and
  appearance settings (tile size, columns/rows, gaps, labels, colours,
  wallpaper blur/monochrome, sidebar widths).
- **Wallpaper choices** — the current wallpaper pool, your favourites, and the
  "safe" wallpaper URL.
- **A favicon cache** — resolved icon URLs for your tiles, so repeat loads are
  fast.
- **A Wallhaven API key, if you enter one** — stored locally in your browser
  storage and used only to request wallpapers from Wallhaven.
- **Sidebar state** — whether the bookmarks panel was last open.

Your **bookmarks are never copied or mirrored by Glisters**. The bookmarks
sidebar is a direct editor for your browser's real bookmarks bar: changes you
make are written to the browser's own bookmarks system, and Glisters does not
maintain a separate copy or upload them.

Deleting the extension, or clearing the site's data, removes all of the above
from your device.

## 2. What the extension fetches (and from whom)

To resolve tile titles and icons, Glisters may fetch the websites you add and
public favicon services (Google's `s2` favicon service, DuckDuckGo's). These
requests come from your browser like any ordinary page visit; the visited
servers see a standard request from your IP address. Favicons for your
bookmarks sidebar are resolved the same way.

If you use the wallpaper feature, Glisters requests images from Wallhaven. If
you use the command bar's reverse-image search, your pasted image or image URL
is sent to Google Images, only when you explicitly trigger it.

## 3. Cloud sync (only when you sign in)

Sync is **optional and off by default**. If you do not sign in, nothing in §3
applies and the extension works fully offline.

When you sign in, the following happens:

- **Authentication — Clerk Inc.** Sign-in uses email + password and is handled
  by Clerk, our authentication provider. Clerk receives your email address
  and, during sign-in, your password (which it processes per Clerk's own
  security practices — see [clerk.com/privacy](https://clerk.com/privacy)).
  Glisters stores the resulting session token on your device to keep you
  signed in.
- **Your save is stored in the cloud — Cloudflare.** Your save document (tiles,
  settings, wallpaper favourites, and any Wallhaven API key you entered) is
  uploaded to a Cloudflare Workers + R2 bucket, namespaced to your account,
  so it can be restored on another device or after a local wipe. Automatic
  previous-version backups of your save are kept alongside it. Cloudflare
  processes this data per [cloudflare.com/privacypolicy](https://www.cloudflare.com/privacypolicy/).

What syncs is limited to your save document described above. **Bookmarks are
not synced.** Nothing else is collected.

### Stopping sync / deleting cloud data

- **Sign out** (settings drawer → account) immediately stops all sync activity.
- Local copies remain on your device until you remove them.
- Cloud copies of your save remain stored for your account and are deleted on
  request — email us (see §6) and we will remove your save and its backups from
  our storage. Deletion is completed within 30 days of a verified request.

## 4. Data security

- Cloud storage is per-user and requires a signed-in session; the server
  rejects requests without a valid session token.
- Communication with Clerk, Cloudflare, and all fetched resources is over
  HTTPS.
- Your Wallhaven API key is stored only in your browser's local storage and
  transmitted only to Wallhaven (or, if you sign in, to the sync storage so it
  can be restored). Treat it like a password; you can remove it at any time
  from the wallpaper settings.

## 5. Children

Glisters is not directed at children under 13 and does not knowingly collect
personal information from them.

## 6. Contact

For privacy questions or deletion requests, contact the developer:
**firozchauhan.dev** (email address listed in the add-on's listing / repository).

## 7. Changes to this policy

We may update this policy as the extension evolves. Material changes will be
reflected here and noted in the add-on's version release notes.
