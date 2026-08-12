/* ---------------------------------------------------------------------------
   GLISTERS — wallpapers
   A pool of 10 wallpapers sourced from **Wallhaven's keyless public API**
   (wallhaven.cc/api/v1). It pulls the **monthly toplist**, picks a random
   page so the pool rotates through different top wallpapers, filters out
   non-wide shots (portrait/4:3/square), and dedupes by photo id. The
   **purity** (SFW / Sketchy / NSFW) and **category** (General / Anime /
   People) pickers in the settings drawer rebuild the search; changing one
   immediately pulls a matching set. NSFW is gated behind the optional
   wallhaven API key field. The 24-hour freshness check pulls a new pool
   and advances the background; the reload control (button or `r`) swaps in
   10 photos that aren't in the current pool; `w` cycles the pool manually;
   `f` saves the current wallpaper to the **favourites** list, which lives in
   the same doc (and save file) as the pool so it syncs and survives. A
   **safe** wallpaper — your personal default — is set with `space` (saves
   the current wallpaper) and applied with `space space`; it also survives in
   the doc and is always kept in the cache, even after it leaves the pool.

   Switching wallpapers is fast because the pool is warmed on load: every
   full-size shot is prefetched through plain `<img>` elements (which need no
   CORS) into the browser's HTTP cache, and best-effort into the extension's
   **Cache Storage** for offline/persistence. Applying a background is then
   served from cache — or from a local blob URL of the Cache Storage copy —
   so cycling/picking is instant. Only the old pool's entries are pruned to
   keep the cache bounded.

   - primary source: wallhaven.cc (covered by the https host permission)
   - fallbacks: a small curated unsplash set for the cold-start/offline case —
     whenever the catalog can't be reached the current pool is kept untouched
   - the pool + choice persist (localStorage + chrome.storage + shared save
     file), so reloads/cloud keep the last state
   - hand-added image URLs get a remove control; sourced photos don't

   Self-contained like bookmarks.js: talks to app.js only through guarded
   hooks (window.WALLS.bind / forDoc / restore).
--------------------------------------------------------------------------- */

(function () {
  'use strict';

  var LS_KEY = 'glisters-walls';

  var POOL_SIZE = 10;
  var FAV_MAX = 60;
  var REFRESH_MS = 24 * 60 * 60 * 1000;   /* freshness check every 24 hours */

  /* wallhaven search: the monthly **toplist**, 24 results per page (the API
     max), filtered by the purity/category picked in the settings drawer.
     Bitmask strings match the wallhaven site/docs — categories:
     General=100, Anime=010, People=001; purity: SFW=100, Sketchy=110,
     NSFW=111 (each purity level includes everything tamer). NSFW content
     needs a wallhaven API key; the drawer's optional key field appends
     &apikey=. The API's ratio param only takes exact ratios, so "wide" is
     enforced client-side on the shots that come back. The toplist is
     deterministic, so a random page is picked each time to keep the pool
     rotating through the top wallpapers. */
  var WH_SEARCH = 'https://wallhaven.cc/api/v1/search?sorting=toplist&topRange=1M' +
    '&per_page=24';

  var PURE_OPTS = ['100', '110', '111'];
  var CAT_OPTS = ['100', '010', '001'];
  var KEY_RE = /^[A-Za-z0-9]{8,64}$/;

  function cleanKey(v) {
    var k = String(v == null ? '' : v).trim();
    return k ? (KEY_RE.test(k) ? k : '') : '';
  }

  /* a key baked into config.js (from .env via scripts/gen-config.mjs) seeds
     the drawer's API key field so the NSFW button is unlocked out of the box.
     The key is still editable in the drawer and saves like any other setting;
     a manually-entered key always wins over this built-in one. */
  var CFG_KEY = (window.CONFIG && typeof window.CONFIG.wallhavenKey === 'string')
    ? cleanKey(window.CONFIG.wallhavenKey) : '';

  function whUrl() {
    var u = WH_SEARCH + '&purity=' + state.purity + '&categories=' + state.category;
    if (state.apikey) u += '&apikey=' + state.apikey;
    return u;
  }

  function wallPage(page) {
    return fetch(whUrl() + '&page=' + page, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('wallhaven ' + r.status);
        return r.json();
      });
  }

  /* the shots of a page whose width:height ratio is wide enough for a browser
     tab background (>= 1.5 — cuts 4:3, 5:4, squares and anything portrait);
     the API's ratios param can't express "any wide", so we filter here */
  function wideShots(d) {
    return (d && Array.isArray(d.data) ? d.data : [])
      .filter(function (x) {
        if (!x || !x.path || !isUrl(x.path)) return false;
        var w = +x.dimension_x, h = +x.dimension_y;
        if (w > 0 && h > 0) return w / h >= 1.5;
        return false;
      })
      .map(function (x) { return x.path; });
  }

  /* fetch a random page of the toplist: page 1 first reports how many pages
     exist, then up to 3 random pages are tried until enough wide shots are
     collected (portrait-heavy pages like the sketchy toplist get skipped) */
  function fetchWallhavenPage() {
    return wallPage(1).then(function (d) {
      var lastPage = (d && d.meta && d.meta.last_page) || 1;
      var seen = {}, shots = [], tries = 0;
      var step = function () {
        if (tries >= 3 || shots.length >= POOL_SIZE) return shots;
        tries++;
        var page = 1 + Math.floor(Math.random() * lastPage);
        return wallPage(page).then(wideShots).then(function (s) {
          s.forEach(function (u) {
            if (!seen[photoKey(u)]) { seen[photoKey(u)] = true; shots.push(u); }
          });
          return step();
        });
      };
      return step();
    });
  }

  /* cold-start / offline fallback — a small curated unsplash set, only shown
     when wallhaven can't be reached and nothing is saved yet */
  var FALLBACK = [
    'photo-1506744038136-46273834b3fb',
    'photo-1470071459604-3b5ec3a7fe05',
    'photo-1441974231531-c6227db76b6e',
    'photo-1519681393784-d120267933ba',
    'photo-1497436072909-60f360e1d4b1',
    'photo-1506905925346-21bda4d32df4',
    'photo-1447752875215-b2761acb3c5d',
    'photo-1501785888041-af3ef285b470',
    'photo-1472214103451-9374bd1c798e',
    'photo-1469474968028-56623f02e42e'
  ].map(function (id) {
    return 'https://images.unsplash.com/' + id + '?auto=format&fit=crop&w=1920&q=80';
  });

  var state = { key: null, list: [], lastRefresh: 0, purity: '100', category: '100',
    apikey: '', favs: [], safe: '' };
  var appCommit = null;
  var refreshing = false;

  var wallEl = document.getElementById('wallLayer') || (function () {
    var d = document.createElement('div');
    d.id = 'wallLayer';
    document.body.insertBefore(d, document.body.firstChild);
    return d;
  })();

  var grid = document.getElementById('wallGrid');
  var favGrid = document.getElementById('favGrid');
  var favAddBtn = document.getElementById('favAdd');
  var favStatus = document.getElementById('favStatus');
  var safeSetBtn = document.getElementById('safeSet');
  var safeApplyBtn = document.getElementById('safeApply');
  var safeStatus = document.getElementById('safeStatus');
  var addInput = document.getElementById('wallAddInput');
  var addBtn = document.getElementById('wallAdd');
  var reloadBtn = document.getElementById('wallReload');
  var reloadStatus = document.getElementById('wallStatus');
  var loadingDots = document.getElementById('wallLoading');

  /* ------------------------------------------------------------------ utils */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function isUrl(v) { return /^https?:\/\/[^\s]+$/i.test(v); }
  function rnd(n) { return Math.floor(Math.random() * n); }
  function shuffle(a) {
    var b = a.slice();
    for (var i = b.length - 1; i > 0; i--) {
      var j = rnd(i + 1);
      var t = b[i]; b[i] = b[j]; b[j] = t;
    }
    return b;
  }
  /* animated loading dots in the settings drawer, shown while a wallpaper
     pool is being fetched (reload, purity/category change, daily refresh) */
  function setLoading(on) {
    if (!loadingDots) return;
    loadingDots.hidden = !on;
    if (reloadBtn) reloadBtn.disabled = on;
  }
  /* the photo a url shows — the dedup key, so one photo can only occupy one
     slot in the pool; unknown urls are unique by url */
  function photoKey(u) {
    var m = /wallhaven-([a-z0-9]+)\.(?:jpg|png)$/i.exec(u);
    if (m) return 'wh:' + m[1].toLowerCase();
    var um = /photo-\d+-[0-9a-f]+/i.exec(u);
    if (um) return 'up:' + um[0].toLowerCase();
    return u;
  }
  /* sourced pool members (wallhaven shots / the offline fallback) don't get a
     remove control — only hand-added urls do */
  function isBuiltin(u) {
    return /w\.wallhaven\.cc\/full\//.test(u) || FALLBACK.indexOf(u) !== -1;
  }

  /* ------------------------------------------------------------- persistence */

  function dataDoc() {
    return { v: 9, key: state.key, list: state.list, lastRefresh: state.lastRefresh,
      purity: state.purity, category: state.category, apikey: state.apikey,
      favs: state.favs, safe: state.safe };
  }

  function persistData() {
    var d = dataDoc();
    try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) { /* quota */ }
    if (window.chrome && chrome.storage && chrome.storage.local) {
      var o = {};
      o[LS_KEY] = d;
      try { chrome.storage.local.set(o); } catch (e) { /* noop */ }
    }
  }
  function touch() {
    persistData();
    if (appCommit) appCommit();
  }
  function setData(d) {
    /* pool is capped at 10; a missing lastRefresh means "stale", so the load
       refresh replaces the pool with a fresh set right away */
    var savedList = d && Array.isArray(d.list) ? d.list.filter(isUrl) : [];
    state.list = savedList.length ? savedList.slice(0, POOL_SIZE) : FALLBACK.slice();
    state.key = d && typeof d.key === 'string' && (d.key === '' || isUrl(d.key))
      ? d.key : null;
    state.lastRefresh = d && typeof d.lastRefresh === 'number' ? d.lastRefresh : 0;
    /* the purity/category pickers: unknown values fall back to SFW/general */
    state.purity = d && PURE_OPTS.indexOf(String(d.purity)) !== -1 ? String(d.purity) : '100';
    state.category = d && CAT_OPTS.indexOf(String(d.category)) !== -1 ? String(d.category) : '100';
    state.apikey = d && typeof d.apikey === 'string' ? cleanKey(d.apikey) : '';
    if (!state.apikey) state.apikey = CFG_KEY;
    /* favourite wallpapers ride in the same doc so they sync like everything
       else; unknown entries are dropped and the list is capped */
    state.favs = d && Array.isArray(d.favs)
      ? d.favs.filter(isUrl).slice(0, FAV_MAX) : [];
    /* the safe wallpaper is just a url — re-validated so a tampered save
       can't slip one in */
    state.safe = d && typeof d.safe === 'string' ? safeWallUrl(d.safe) : '';
    /* saves from before the wallhaven source (bing / unsplash) are dropped on
       the next load so the pool is rebuilt from wallhaven */
    if (d && d.v < 6) {
      state.list = [];
      state.key = null;
      state.lastRefresh = 0;
    }
  }
  function adopt(d) {
    var incoming = d && typeof d === 'object' ? d : {};
    var prevKey = state.key, prevList = state.list, prevFavs = state.favs;
    var prevPurity = state.purity, prevCategory = state.category, prevKeyOpt = state.apikey;
    var prevSafe = state.safe;
    var hasIncoming = !!incoming.key ||
      (Array.isArray(incoming.list) && incoming.list.length > 0);
    setData(d);
    /* a stale/empty mirror (fresh-seed app doc, cloud copy that missed the
       last pick) must not erase a wallpaper the user already chose or filters
       they picked */
    if (!hasIncoming && (prevKey || prevList.length)) {
      state.key = prevKey;
      state.list = prevList;
      state.favs = prevFavs;
      state.purity = prevPurity;
      state.category = prevCategory;
      state.apikey = prevKeyOpt;
      state.safe = prevSafe;
    }
    persistData();
    renderGrid();
    renderFavs();
    renderFilterButtons();
    applyBackground();
    pruneBlobs(state.list);
    prefetchPool();
  }

  /* ------------------------------------------------------------ refresh pool */

  function thumbUrl(u) {
    /* wallhaven bakes the id into the full path — derive the CDN thumbnail */
    var m = /wallhaven-([a-z0-9]+)\.(?:jpg|png)$/i.exec(u);
    if (m) {
      var id = m[1], sub = id.slice(0, 2);
      return 'https://th.wallhaven.cc/lg/' + sub + '/' + id + '.jpg';
    }
    /* downscale unsplash thumbs so the drawer loads small images */
    if (u.indexOf('images.unsplash.com') !== -1) {
      return u.replace(/w=\d+/, 'w=220').replace(/q=\d+/, 'q=60');
    }
    return u;
  }

  /* ---------------------------------------------- wallpaper blob cache */

  /* Full-size backgrounds are the slow part of switching wallpapers: every
     `w` cycle or tile click used to re-download the shot before it could
     show. Now the pool is warmed on load and applying a background is served
     from cache, so switching is instant.

     Two cooperating layers:
     1. **`<img>` preloading** — the universal, guaranteed one. Image elements
        need no CORS (a normal <img> just works for any https url) and their
        bytes land in the browser's ordinary HTTP cache. A background swap to
        the same url is then served from disk, not the network — in any
        context (installed extension, local dev server, file://).
     2. **Cache Storage** — a bonus persistence/offline layer. It fetches with
        `cache: 'force-cache'` so it reuses the entry the <img> just warmed
        (no second download) and stores it in Cache Storage, which survives
        restarts and works offline. Applying then resolves to a local blob URL
        from that cache. Everything here is best-effort and fails silently, so
        it can only help.

     The heavy full-size blobs live on disk, not in RAM; only small object
     URLs are held in memory, and anything that leaves the pool is pruned to
     keep the cache bounded. The pool is re-fetched every **24 hours**, so the
     cache naturally lives for that whole cycle — a day's wallpapers stay
     cached (and offline-available) until the next day's pool replaces them. */

  var CACHE_NAME = 'glisters-walls-v1';
  var cachePromise = null;
  var blobUrls = {};       /* url -> blob object URL, so applying is sync-fast */
  var blobPromises = {};   /* url -> in-flight materialize (dedupe) */
  var cachedUrls = {};     /* urls known to be in Cache Storage (for pruning) */

  function openCache() {
    if (typeof caches === 'undefined') return Promise.resolve(null);
    if (!cachePromise) cachePromise = caches.open(CACHE_NAME);
    return cachePromise;
  }

  /* fetch + store one full-size wallpaper into the cache (no-op if there).
     `force-cache` reuses the bytes the <img> preload already fetched, so this
     is a disk-to-disk copy most of the time, not a second download */
  function cacheImage(url) {
    return openCache().then(function (cache) {
      if (!cache) return false;
      return cache.match(url).then(function (hit) {
        if (hit) { cachedUrls[url] = true; return true; }
        return fetch(url, { cache: 'force-cache' }).then(function (r) {
          if (!r.ok) return false;
          return cache.put(url, r).then(function () {
            cachedUrls[url] = true;
            return true;
          });
        }).catch(function () { return false; });
      });
    }).catch(function () { return false; });
  }

  /* resolve a cached wallpaper to a blob object URL (remembered per url) */
  function materialize(url) {
    if (blobUrls[url]) return Promise.resolve(blobUrls[url]);
    if (blobPromises[url]) return blobPromises[url];
    blobPromises[url] = openCache().then(function (cache) {
      if (!cache) return null;
      return cache.match(url).then(function (resp) {
        return resp ? resp.blob() : null;
      });
    }).then(function (blob) {
      if (!blob) return null;
      if (state.list.indexOf(url) === -1 && url !== state.key) {
        /* a late resolve for an old pool url — don't keep it */
        try { URL.revokeObjectURL(URL.createObjectURL(blob)); } catch (e) {}
        return null;
      }
      if (blobUrls[url]) try { URL.revokeObjectURL(blobUrls[url]); } catch (e) {}
      blobUrls[url] = URL.createObjectURL(blob);
      return blobUrls[url];
    }).catch(function () { return null; });
    return blobPromises[url];
  }

  /* warm one full-size shot through a plain <img> element — the reliable path.
     The reference is dropped once loaded: the decoded bitmap is freed for GC
     while the encoded bytes stay in the browser HTTP cache */
  var preloading = {};
  function preloadImage(url) {
    if (preloading[url]) return;
    preloading[url] = true;
    var im = new Image();
    var done = false;
    im.referrerPolicy = 'no-referrer';
    im.onload = im.onerror = function () {
      if (done) return;
      done = true;
      im.src = '';
      im = null;
      delete preloading[url];
    };
    im.src = url;
  }

  /* warm the whole pool (3 at a time so a handful of huge bitmaps isn't
     decoded at once), then swap the current shot to its cached blob the
     moment it's ready; the <img> preload already makes later swaps fast */
  function prefetchPool() {
    var urls = state.list.slice();
    var i = 0, active = 0;
    var work = function (url) {
      active++;
      preloadImage(url);
      cacheImage(url).then(function () {
        active--;
        if (url === state.key) applyBackground();
        step();
      });
    };
    var step = function () {
      while (active < 3 && i < urls.length) work(urls[i++]);
    };
    step();
  }

  /* drop blobs + cache entries that left the pool so memory/disk stay
     bounded; the currently-shown shot and every favourite are always kept */
  function pruneBlobs(keep) {
    var keepSet = {};
    (keep || []).forEach(function (u) { keepSet[u] = true; });
    state.favs.forEach(function (u) { keepSet[u] = true; });
    if (state.safe) keepSet[state.safe] = true;
    var drop = [];
    Object.keys(blobUrls).forEach(function (u) {
      if (keepSet[u] || u === state.key) return;
      try { URL.revokeObjectURL(blobUrls[u]); } catch (e) { /* noop */ }
      delete blobUrls[u];
      drop.push(u);
    });
    Object.keys(cachedUrls).forEach(function (u) {
      if (keepSet[u] || u === state.key) return;
      delete cachedUrls[u];
      drop.push(u);
    });
    if (drop.length && typeof caches !== 'undefined') {
      openCache().then(function (cache) {
        if (!cache) return;
        drop.forEach(function (u) {
          try { cache.delete(u).catch(function () {}); } catch (e) { /* noop */ }
        });
      }).catch(function () { /* noop */ });
    }
  }

  /* pull a fresh set from wallhaven and replace the pool. With opts.different
     (the reload button) the current pool's photos are dropped first so the
     new 10 are as different as the catalog allows. On failure the current
     pool is kept untouched (offline / throttled); a truly empty start falls
     back to the curated unsplash set. */
  function refreshPool(advance, opts) {
    if (refreshing) return Promise.resolve(false);
    refreshing = true;
    setLoading(true);
    var different = !!(opts && opts.different);
    return fetchWallhavenPage().then(function (all) {
      var picked = all.slice(0, POOL_SIZE);
      if (different) {
        var cur = {};
        state.list.forEach(function (u) { cur[photoKey(u)] = true; });
        var fresh = all.filter(function (u) { return !cur[photoKey(u)]; });
        if (fresh.length >= POOL_SIZE) picked = fresh.slice(0, POOL_SIZE);
        else picked = fresh.concat(all.filter(function (u) { return cur[photoKey(u)]; }))
          .slice(0, POOL_SIZE);
      }
      if (!picked.length) throw new Error('no wallhaven images');
      var isNew = picked.some(function (u) { return state.list.indexOf(u) === -1; });
      var prevKey = state.key;
      state.list = picked;
      state.lastRefresh = Date.now();
      if (advance && (isNew || different)) {
        /* advance onto a shot that isn't the current one */
        state.key = picked[0] === prevKey && picked[1] ? picked[1] : picked[0];
      }
      pruneBlobs(state.list);
      touch();
      renderGrid();
      applyBackground();
      prefetchPool();
      return true;
    }).catch(function () {
      /* offline / wallhaven unreachable — keep the current pool untouched */
      if (!state.list.length) {
        state.list = shuffle(FALLBACK).slice(0, POOL_SIZE);
        if (advance) state.key = state.list[0];
        pruneBlobs(state.list);
        touch();
        renderGrid();
        applyBackground();
        prefetchPool();
        return true;
      }
      return false;
    }).then(function (ok) { refreshing = false; setLoading(false); return ok; });
  }

  /* ------------------------------------------------------------------ apply */

  /* the wallpaper url crosses the cloud-save boundary — never let it carry
     raw CSS. Parse + re-encode it as a plain http(s) URL, and escape any
     quotes that survive, so a tampered save can't inject styles. */
  function safeWallUrl(raw) {
    if (!raw) return '';
    try {
      var u = new URL(raw);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
      return u.href.replace(/"/g, '%22');
    } catch (e) { return ''; }
  }

  function applyBackground() {
    var safe = safeWallUrl(state.key);
    if (!safe) {
      wallEl.style.backgroundImage = 'none';
      highlightCurrent();
      return;
    }
    /* instant path: a blob URL from the prefetched cache */
    var blob = blobUrls[safe];
    wallEl.style.backgroundImage = 'url("' + (blob || safe) + '")';
    if (!blob) {
      /* not materialized yet — show the real url now and swap to the cached
         blob the instant it becomes available */
      materialize(safe).then(function (obj) {
        if (obj && state.key === safe) {
          wallEl.style.backgroundImage = 'url("' + obj + '")';
        }
      });
    }
    highlightCurrent();
  }

  function highlightCurrent() {
    var roots = [grid, favGrid];
    for (var g = 0; g < roots.length; g++) {
      var r = roots[g];
      if (!r) continue;
      var thumbs = r.querySelectorAll('.wall-thumb');
      for (var i = 0; i < thumbs.length; i++) {
        thumbs[i].classList.toggle('current', thumbs[i].dataset.url === state.key);
      }
    }
  }

  function pick(key) {
    if (key === state.key) return;
    state.key = key;
    applyBackground();
    touch();
  }

  /* cycle to the next wallpaper in the current pool (wraps around) */
  function nextWallpaper() {
    if (!state.list.length) return Promise.resolve(false);
    var i = state.key ? state.list.indexOf(state.key) : -1;
    pick(state.list[(i + 1) % state.list.length]);
    return Promise.resolve(true);
  }

  /* ------------------------------------------------------------------ safe */

  /* the safe wallpaper is a personal default: `space` saves the currently
     shown wallpaper here, `space space` applies it (even after it has left
     the daily pool — the shot stays in the cache). Both actions only work
     from the bare page, like the other wallpaper keys. */
  function setSafe() {
    var s = safeWallUrl(state.key);
    if (!s) { flashSafe('no wallpaper shown to save'); return false; }
    state.safe = s;
    touch();
    highlightSafe();
    flashSafe('safe wallpaper set — double space to apply');
    return true;
  }

  function applySafe() {
    if (!state.safe) {
      flashSafe('no safe wallpaper yet — press space to save this one');
      return false;
    }
    pick(state.safe);
    highlightSafe();
    flashSafe('safe wallpaper applied');
    return true;
  }

  /* badge the tile whose url is the safe wallpaper (in both grids) */
  function highlightSafe() {
    var roots = [grid, favGrid];
    for (var g = 0; g < roots.length; g++) {
      var r = roots[g];
      if (!r) continue;
      var items = r.querySelectorAll('.wall-item');
      for (var i = 0; i < items.length; i++) {
        var t = items[i].querySelector('.wall-thumb');
        items[i].classList.toggle('safe', !!t && t.dataset.url === state.safe);
      }
    }
  }

  /* every 24 hours: replace the pool with a fresh set and show a new one */
  setInterval(function () { refreshPool(true); }, REFRESH_MS);

  /* --------------------------------------------------------------- settings */

  function renderGrid() {
    if (!grid) return;
    grid.innerHTML = '';

    var none = el('button', 'wall-thumb wall-none');
    none.type = 'button';
    none.title = 'no wallpaper';
    none.dataset.url = '';
    none.textContent = 'none';
    none.addEventListener('click', function () { pick(''); });
    var wrap = el('div', 'wall-item');
    wrap.appendChild(none);
    wrap.appendChild(el('span', 'wall-label', 'none'));
    grid.appendChild(wrap);

    state.list.forEach(function (u) {
      var w = el('div', 'wall-item');
      var b = el('button', 'wall-thumb');
      b.type = 'button';
      b.dataset.url = u;
      b.title = u;
      /* lazy <img> instead of a css background — thumbs only load in view */
      var im = document.createElement('img');
      im.src = thumbUrl(u);
      im.alt = '';
      im.loading = 'lazy';
      im.decoding = 'async';
      im.referrerPolicy = 'no-referrer';
      im.addEventListener('error', function () { b.classList.add('failed'); });
      b.appendChild(im);
      b.addEventListener('click', function () { pick(u); });
      w.appendChild(b);
      var label = el('span', 'wall-label', shortLabel(u));
      w.appendChild(label);

      /* custom (non-builtin) links get a tiny remove control */
      if (!isBuiltin(u)) {
        var rm = el('span', 'wall-remove');
        rm.setAttribute('role', 'button');
        rm.setAttribute('aria-label', 'remove wallpaper');
        rm.textContent = '\u00d7';
        rm.addEventListener('click', function (e) {
          e.stopPropagation();
          removeImage(u);
        });
        w.appendChild(rm);
        w.classList.add('has-remove');
      }
      grid.appendChild(w);
    });

    highlightCurrent();
    highlightSafe();
  }

  function shortLabel(u) {
    try {
      var m = /wallhaven-([a-z0-9]+)\.(?:jpg|png)$/i.exec(u);
      if (m) return m[1];
      var p = new URL(u).pathname;
      var um = p.match(/photo-\d+-([0-9a-f]+)/i);
      if (um) return um[1].slice(0, 6);
      return new URL(u).hostname.replace(/^www\./, '').slice(0, 12);
    } catch (e) { return 'image'; }
  }

  function addImage() {
    if (!addInput || !addBtn) return;
    var u = addInput.value.trim();
    if (!isUrl(u)) { addInput.focus(); return; }
    if (state.list.indexOf(u) !== -1) { addInput.value = ''; return; }
    state.list.push(u);
    if (state.list.length > POOL_SIZE) state.list.shift(); /* pool stays at 10 */
    addInput.value = '';
    touch();
    pruneBlobs(state.list);
    renderGrid();
    pick(u);
  }

  function removeImage(u) {
    if (isBuiltin(u)) return;
    var i = state.list.indexOf(u);
    if (i < 0) return;
    state.list.splice(i, 1);
    if (state.key === u) state.key = null;
    touch();
    pruneBlobs(state.list);
    renderGrid();
    applyBackground();
  }

  /* -------------------------------------------------------------- favourites */

  /* Favourites are wallpapers the user wants to keep, saved in the same doc
     as the pool (and the app save file) so they sync to the cloud. The `f`
     key (or the button) saves the currently-shown wallpaper here; clicking a
     favourite tile makes it the background; hovering shows a remove control.
     Shift+`F` swaps the active pool for this list, so `w`/reload cycle
     through your saved favourites. */

  function renderFavs() {
    if (!favGrid) return;
    favGrid.innerHTML = '';

    if (!state.favs.length) {
      var hint = el('button', 'wall-thumb fav-empty');
      hint.type = 'button';
      hint.title = 'press f with a wallpaper to save it here';
      hint.textContent = 'press f';
      hint.addEventListener('click', function () { addFav(state.key); });
      var wrap = el('div', 'wall-item');
      wrap.appendChild(hint);
      wrap.appendChild(el('span', 'wall-label', 'favourites'));
      favGrid.appendChild(wrap);
    }

    state.favs.forEach(function (u) {
      var w = el('div', 'wall-item has-remove');
      var b = el('button', 'wall-thumb');
      b.type = 'button';
      b.dataset.url = u;
      b.title = u;
      var im = document.createElement('img');
      im.src = thumbUrl(u);
      im.alt = '';
      im.loading = 'lazy';
      im.decoding = 'async';
      im.referrerPolicy = 'no-referrer';
      im.addEventListener('error', function () { b.classList.add('failed'); });
      b.appendChild(im);
      b.addEventListener('click', function () { pick(u); });
      w.appendChild(b);
      w.appendChild(el('span', 'wall-label', shortLabel(u)));
      var rm = el('span', 'wall-remove');
      rm.setAttribute('role', 'button');
      rm.setAttribute('aria-label', 'remove favourite wallpaper');
      rm.textContent = '\u00d7';
      rm.addEventListener('click', function (e) {
        e.stopPropagation();
        removeFav(u);
      });
      w.appendChild(rm);
      favGrid.appendChild(w);
    });

    highlightCurrent();
    highlightSafe();
  }

  function addFav(u) {
    if (!u || !isUrl(u)) {
      flashFav('nothing to favourite');
      return false;
    }
    if (state.favs.indexOf(u) !== -1) {
      flashFav('already a favourite');
      return false;
    }
    state.favs.push(u);
    if (state.favs.length > FAV_MAX) state.favs.shift();
    touch();
    renderFavs();
    flashFav('favourited');
    return true;
  }

  function removeFav(u) {
    var i = state.favs.indexOf(u);
    if (i < 0) return;
    state.favs.splice(i, 1);
    touch();
    renderFavs();
    flashFav('removed favourite');
  }

  /* Shift+`F`: the favourites become the active wallpaper pool — the current
     set is swapped for them (capped at the pool size, like any other set) so
     `w` and reload cycle through your saved favourites. The shown wallpaper
     stays if it's one of them; otherwise the set jumps to the first
     favourite. Marked fresh so the 24-hour check doesn't immediately swap it
     back to a wallhaven pull. */
  function favPool() {
    if (!state.favs.length) {
      flashFav('no favourites yet — press f to save this one');
      return false;
    }
    var favs = state.favs.slice(0, POOL_SIZE);
    state.list = favs;
    state.lastRefresh = Date.now();
    if (!state.key || favs.indexOf(state.key) === -1) state.key = favs[0];
    pruneBlobs(state.list);
    touch();
    renderGrid();
    applyBackground();
    prefetchPool();
    flashFav('favourites now the pool — w to cycle');
    return true;
  }

  function flashFav(msg) {
    if (!favStatus) return;
    favStatus.textContent = msg;
    setTimeout(function () { if (favStatus) favStatus.textContent = ''; }, 2500);
  }

  function flashSafe(msg) {
    if (!safeStatus) return;
    safeStatus.textContent = msg;
    setTimeout(function () { if (safeStatus) safeStatus.textContent = ''; }, 2500);
  }

  if (favAddBtn) favAddBtn.addEventListener('click', function () { addFav(state.key); });
  if (safeSetBtn) safeSetBtn.addEventListener('click', setSafe);
  if (safeApplyBtn) safeApplyBtn.addEventListener('click', applySafe);

  if (addBtn) addBtn.addEventListener('click', addImage);
  if (addInput) addInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addImage(); }
  });

  /* ---- purity / category pickers: swap the source, pull a matching set ---- */

  var purityBtns = null, categoryBtns = null, keyInput = null;

  function renderFilterButtons() {
    if (purityBtns && categoryBtns) {
      purityBtns.forEach(function (b) {
        if (b.dataset.wallPurity === '111') {
          b.disabled = !state.apikey;
          b.title = state.apikey ? '' : 'requires a wallhaven API key';
        }
        b.classList.toggle('selected', b.dataset.wallPurity === state.purity);
      });
      categoryBtns.forEach(function (b) {
        b.classList.toggle('selected', b.dataset.wallCategory === state.category);
      });
    }
    if (keyInput && document.activeElement !== keyInput &&
        keyInput.value !== state.apikey) {
      keyInput.value = state.apikey || '';
    }
  }

  function setFilter(type, value) {
    var opts = type === 'purity' ? PURE_OPTS : CAT_OPTS;
    if (opts.indexOf(value) === -1) return Promise.resolve(false);
    if (type === 'purity' && value === '111' && !state.apikey) return Promise.resolve(false);
    var key = type === 'purity' ? 'purity' : 'category';
    if (state[key] === value) return Promise.resolve(true);
    state[key] = value;
    touch();
    renderFilterButtons();
    /* the current pool came from the old filter — pull a fresh set that
       matches, dropping the old photos so nothing from the wrong filter is
       left in */
    return refreshPool(true, { different: true });
  }

  /* the optional wallhaven API key: unlocks NSFW (the API won't serve it to
     guests). Adding a key while on NSFW re-fetches so NSFW actually appears;
     removing the key while on NSFW steps back to SFW+Sketchy and re-fetches. */
  function setKey(v) {
    var key = cleanKey(v);
    if (key === state.apikey) return Promise.resolve(true);
    state.apikey = key;
    touch();
    if (state.purity === '111') {
      if (!key) {
        state.purity = '110';
        touch();
      }
      renderFilterButtons();
      return refreshPool(true, { different: true });
    }
    renderFilterButtons();
    return Promise.resolve(true);
  }

  purityBtns = Array.prototype.slice.call(document.querySelectorAll('[data-wall-purity]'));
  categoryBtns = Array.prototype.slice.call(document.querySelectorAll('[data-wall-category]'));
  purityBtns.forEach(function (b) {
    b.addEventListener('click', function () { setFilter('purity', b.dataset.wallPurity); });
  });
  categoryBtns.forEach(function (b) {
    b.addEventListener('click', function () { setFilter('category', b.dataset.wallCategory); });
  });

  keyInput = document.getElementById('wallKey');
  if (keyInput) {
    var commitKey = function () {
      var key = cleanKey(keyInput.value);
      keyInput.value = key;
      setKey(key);
    };
    keyInput.addEventListener('change', commitKey);
    keyInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitKey(); }
    });
  }

  /* reload: swap the pool for a different 10 from wallhaven. The animated
     dots (setLoading) are the "fetching" indicator; the status text only
     reports the outcome. */
  function reload() {
    if (refreshing) return Promise.resolve(false);
    if (!reloadBtn) return refreshPool(true, { different: true });
    reloadBtn.disabled = true;
    return refreshPool(true, { different: true }).then(function (ok) {
      if (reloadStatus) reloadStatus.textContent = ok ? '10 new wallpapers' : 'wallhaven unreachable — kept pool';
      setTimeout(function () { if (reloadStatus) reloadStatus.textContent = ''; }, 2500);
      reloadBtn.disabled = false;
      return ok;
    }).catch(function () {
      if (reloadStatus) reloadStatus.textContent = 'reload failed';
      setTimeout(function () { if (reloadStatus) reloadStatus.textContent = ''; }, 2500);
      reloadBtn.disabled = false;
      return false;
    });
  }
  if (reloadBtn) reloadBtn.addEventListener('click', reload);

  /* ---- keys: w cycles to the next wallpaper, r reloads, f favourites the
        current wallpaper, space saves it as safe and double-space applies
        it (bare page only) ---- */

  function isVisible(sel) {
    var n = document.querySelector(sel);
    return !!n && !n.hidden && n.getAttribute('aria-hidden') !== 'true' &&
      getComputedStyle(n).display !== 'none';
  }
  /* single space = save the current wallpaper as safe; a second space within
     the window = apply the safe wallpaper. The single action is delayed so
     the double-decision can resolve without saving and applying twice. */
  var SPACE_WAIT_MS = 350;
  var spaceTimer = null;
  function spaceTap() {
    if (spaceTimer) {
      clearTimeout(spaceTimer);
      spaceTimer = null;
      applySafe();
    } else {
      spaceTimer = setTimeout(function () {
        spaceTimer = null;
        setSafe();
      }, SPACE_WAIT_MS);
    }
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (e.key !== 'w' && e.key !== 'W' && e.key !== 'r' && e.key !== 'R' &&
        e.key !== 'f' && e.key !== 'F' && e.key !== ' ') return;
    if (e.repeat) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (isVisible('#modal') || isVisible('#bar')) return;
    var drawer = document.querySelector('#drawer'), bk = document.querySelector('#bk');
    if (drawer && drawer.classList.contains('open')) return;
    if (bk && bk.classList.contains('open')) return;
    e.preventDefault();
    if (e.key === 'r' || e.key === 'R') reload();
    else if (e.key === 'F') favPool();
    else if (e.key === 'f') addFav(state.key);
    else if (e.key === ' ') spaceTap();
    else nextWallpaper();
  });

  /* ------------------------------------------------------------------ init */

  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) {}
  if (saved) setData(saved);
  renderGrid();
  renderFavs();
  renderFilterButtons();
  applyBackground();
  highlightSafe();
  pruneBlobs(state.list);
  prefetchPool();

  /* chrome.storage is the durable mirror; adopt it if localStorage was empty */
  if (window.chrome && chrome.storage && chrome.storage.local) {
    try {
      chrome.storage.local.get(LS_KEY, function (o) {
        if (o && o[LS_KEY] && !JSON.parse(localStorage.getItem(LS_KEY) || 'null')) adopt(o[LS_KEY]);
      });
    } catch (e) { /* noop */ }
  }

  /* after boot settles: if the pool is older than 24 hours, fetch a fresh
     set right away (so a new tab opened later already shows something new) */
  setTimeout(function () {
    if (Date.now() - state.lastRefresh >= REFRESH_MS) refreshPool(true);
  }, 1500);

  /* --- public API used by app.js (all guarded there) --- */

  window.WALLS = {
    bind: function (cb) { appCommit = cb; },
    forDoc: function () { return dataDoc(); },
    restore: function (d) {
      if (!d || typeof d !== 'object') return;
      adopt(d);
    },
    next: function () { return nextWallpaper(); },
    /* also exposed so tests / other code can trigger a refresh */
    refresh: function () { return refreshPool(true); },
    /* swap in a different set of 10 and drop the current pool */
    reload: function () { return reload(); },
    /* change the purity/category picker and pull a matching pool */
    filter: function (type, value) { return setFilter(type, value); },
    /* set/clear the optional wallhaven API key (unlocks NSFW) */
    key: function (v) { return setKey(v); },
    /* favourite the currently-shown wallpaper (returns true if saved) */
    fav: function () { return addFav(state.key); },
    /* swap the active pool for the favourites list (capped at the pool size) */
    favPool: function () { return favPool(); },
    /* save the current wallpaper as the safe/default wallpaper */
    setSafe: function () { return setSafe(); },
    /* apply the safe wallpaper as the background (if one is set) */
    applySafe: function () { return applySafe(); }
  };
})();
