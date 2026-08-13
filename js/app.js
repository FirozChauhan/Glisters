(function () {
  'use strict';

  var CF = window.CONFIG || {};
  var SYNC_ENABLED = !!(CF.worker || CF.endpoint);

  var STORE_KEY = 'glisters';
  var SEED_FLAG_KEY = 'glisters-seed'; /* persists that local state came from links.txt */
  var SEED_VERSION = 2; /* bump when links.txt should re-seed existing installs */

  /* the default save: a fresh/wiped install renders THESE links on first
     paint — no fetch, no cloud, no blank grid. links.txt still overrides
     (edit it to change what a future fresh install seeds). */
  var DEFAULT_SITES = [
    { name: 'Youtube', url: 'https://youtube.com' },
    { name: 'BlackFlag', url: 'https://docs.google.com/spreadsheets/d/177cnuV9QlHmO6bAGdO1xgN04xnQJCAuLOcj0ckmy4Yk/edit?gid=1167406126#gid=1167406126' },
    { name: 'Google Maps', url: 'https://maps.google.com/' },
    { name: 'Google Images', url: 'https://images.google.com/' },
    { name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
    { name: 'Google Drive', url: 'https://drive.google.com/drive/home' },
    { name: 'Tuta Mail', url: 'https://app.tuta.com/mail/Ohr3gNy--F-9' },
    { name: 'GitHub', url: 'https://github.com/FirozChauhan' },
    { name: 'Javascript Compiler', url: 'https://nextleap.app/online-compiler/javascript-programming' },
    { name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
    { name: 'x.com', url: 'https://x.com/' },
    { name: 'ImageKit Dashboard', url: 'https://imagekit.io/dashboard/media-library/L0hBWkVM' },
    { name: 'Instagram', url: 'https://www.instagram.com/' },
    { name: 'Cloudflare R2', url: 'https://dash.cloudflare.com/a30112ac3e6966496265c81adcab8fcf/r2/default/buckets/jigar' },
    { name: 'FitGirl', url: 'https://fitgirl-repacks.site/' },
    { name: 'Pinterest', url: 'https://www.pinterest.com/' },
    { name: 'Wallhaven', url: 'https://wallhaven.cc/' },
    { name: 'Fast.com', url: 'https://fast.com/' },
    { name: 'Pirate Bay', url: 'https://thepiratebay.org' },
    { name: 'Amazon', url: 'http://amazon.in' },
    { name: 'Google Translate', url: 'https://translate.google.co.in/?sl=auto&tl=en&op=translate' },
    { name: 'Google Docs', url: 'http://docs.google.com' },
    { name: 'WordCounter', url: 'https://wordcounter.net/' },
    { name: 'AnkerGames', url: 'https://ankergames.net/' },
    { name: 'Render', url: 'https://dashboard.render.com/' },
    { name: 'Neon', url: 'https://console.neon.tech/app' },
    { name: 'Paletton', url: 'https://paletton.com/' },
    { name: 'GroqCloud', url: 'https://console.groq.com/home' },
    { name: 'Cloudinary', url: 'https://console.cloudinary.com/app' },
    { name: 'Gmail', url: 'https://mail.google.com/mail/u/3/#inbox' },
    { name: 'XXXClub', url: 'https://xxxclub.to/' },
    { name: 'RARBG', url: 'https://rargb.to/' },
    { name: 'NSFW - Google Drive', url: 'https://drive.google.com/drive/u/1/folders/14MIlVL7UX7k7pPItT6c0ovUzZai_oO15' },
    { name: 'DropMMS', url: 'https://dropmms.co/forum/2-desi-new-videos-hd-sd/' },
    { name: 'Masti Raja', url: 'https://mastiraja.com/' },
    { name: 'Reddit', url: 'http://www.reddit.com' },
    { name: 'PornPics', url: 'https://www.pornpics.com/' },
    { name: 'Emochi', url: 'https://emochi.com/' },
    { name: 'AI Character Editor', url: 'https://avakson.github.io/character-editor/' },
    { name: 'Elite Babes', url: 'https://www.elitebabes.com/' },
    { name: 'ViperGirls', url: 'https://viper.to/forum.php' },
    { name: 'character.ai', url: 'https://character.ai/' },
    { name: 'Chub AI', url: 'https://chub.ai/' },
    { name: 'Streamtape', url: 'https://streamtape.com/accpanel' },
    { name: 'EXT', url: 'https://ext.to/' },
    { name: 'cookii.ai', url: 'https://cookii.ai/' }
  ];

  var DEFAULTS = {
    version: SEED_VERSION,
    updatedAt: 0,
    sites: DEFAULT_SITES.slice(),
    settings: { iconSize: 72, colGap: 24, rowGap: 22, cols: 6, rows: 5, labels: true, labelOp: 100, labelColor: '#f5f5f5', bkWidth: 360, drWidth: 320, mono: false, wallMono: false, blur: 0 }
  };

  var saved = readLocal();
  var needSeed = !saved || !saved.version || saved.version < SEED_VERSION;
  var state;
  if (needSeed) {
    state = Object.assign({}, DEFAULTS);
    state.settings = Object.assign({}, DEFAULTS.settings);
    state.sites = DEFAULT_SITES.slice(); /* own copy — never share the array */
  } else {
    state = normalize(saved) || Object.assign({}, DEFAULTS, { settings: Object.assign({}, DEFAULTS.settings), sites: DEFAULT_SITES.slice() });
  }
  var focused = -1; /* index into sites; sites.length === the add tile */
  var armed = -1;
  var page = 0;
  var armTimer = null;
  var cloudTimer = null;
  var retryTimer = null;
  var settingTimer = null;
  var dirty = false;
  /* true only when state was seeded from links.txt (fresh install). Persisted
     (localStorage + chrome.storage) so a reload can't forget it: if a seeded
     doc were ever mistaken for real local data, a fresh timestamp from a boot
     commit would let LWW push it over the cloud save. The flag drops only on
     a successful push or adoption. */
  var seededFromLinks = readSeedFlag();
  var mode = 'none'; /* 'none' | 'drawer' | 'modal' | 'bar' */

  function $(s) { return document.querySelector(s); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  var grid = $('#grid'), empty = $('#empty'), scrollArea = $('#scroll'),
      bar = $('#bar'), barInput = $('#barInput'),
      drawer = $('#drawer'), scrim = $('#scrim'),
      modalEl = $('#modal'), form = $('#siteForm'),
      nameIn = $('#siteName'), urlIn = $('#siteUrl'), modalTitle = $('#modalTitle'),
      settingsBtn = $('#settingsBtn'), drawerClose = $('#drawerClose'),
      drawerBody = $('#drawerBody'),
      iconPicker = $('#iconPicker'), metaStatus = $('#metaStatus'),
      syncNow = $('#syncNow'), resetSettings = $('#resetSettings'),
      emptyAdd = $('#emptyAdd');

  /* ------------------------------------------------------------------ state */

  function readLocal() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* ---- links.txt seeding (one url per line) ---- */

  var TITLE_CASE = {
    'chat.deepseek.com': 'DeepSeek',
    'web.whatsapp.com': 'WhatsApp',
    'imagekit.io': 'ImageKit',
    'app.tuta.com': 'Tuta Mail',
    'console.groq.com': 'Groq',
    'console.neon.tech': 'Neon',
    'dashboard.render.com': 'Render',
    'ankergames.net': 'Anker Games',
    'paletton.com': 'Paletton',
    'wallhaven.cc': 'Wallhaven',
    'thepiratebay.org': 'Pirate Bay',
    'x.com': 'X',
    'mail.google.com': 'Gmail',
    'drive.google.com': 'Drive',
    'youtube.com': 'YouTube',
    'github.com': 'GitHub',
    'translate.google.co.in': 'Translate',
    'amazon.in': 'Amazon'
  };

  function prettyBase(hostname) {
    var parts = hostname.split('.');
    var base = parts.length > 2 ? parts[parts.length - 2] : parts[0];
    return (base.charAt(0).toUpperCase() + base.slice(1)).replace(/-/g, ' ');
  }

  function nameForUrl(raw) {
    var u;
    try { u = new URL(raw); } catch (e) { return raw; }
    var h = u.hostname.replace(/^www\./, '');
    var path = u.pathname || '';

    if (h === 'docs.google.com') {
      return path.indexOf('/spreadsheets') !== -1 ? 'Sheets' : 'Docs';
    }
    if (h === 'google.com') {
      if (path.indexOf('/maps') !== -1) return 'Maps';
      return 'Google';
    }
    return TITLE_CASE[h] || prettyBase(h);
  }

  function parseLinks(text) {
    var seen = {};
    var out = [];
    String(text).split(/\r?\n/).forEach(function (line) {
      var url = line.trim();
      if (!url) return;
      var name = nameForUrl(url);
      var key = name.toLowerCase();
      if (seen[key]) {
        seen[key]++;
        name = name + ' ' + seen[key];
      } else {
        seen[key] = 1;
      }
      out.push({ id: uid(), name: name, url: url });
    });
    return out;
  }

  function loadLinks() {
    return fetch('links.txt', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('links.txt: ' + r.status);
        return r.text();
      })
      .then(parseLinks);
  }

  function normalize(o) {
    if (!o || typeof o !== 'object') return null;
    var d = DEFAULTS.settings;
    var s = {};
    if (o.settings && typeof o.settings === 'object') {
      ['iconSize', 'colGap', 'rowGap', 'cols', 'rows', 'bkWidth', 'drWidth', 'blur', 'labelOp'].forEach(function (k) {
        var v = o.settings[k];
        s[k] = typeof v === 'number' && isFinite(v) ? v : d[k];
      });
      s.labels = o.settings.labels !== false;
      s.labelColor = typeof o.settings.labelColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(o.settings.labelColor)
        ? o.settings.labelColor : d.labelColor;
      s.mono = o.settings.mono === true;
      s.wallMono = o.settings.wallMono === true;
    } else {
      s = Object.assign({}, d);
    }
    var sites = Array.isArray(o.sites)
      ? o.sites.filter(function (t) {
          return t && typeof t.name === 'string' && typeof t.url === 'string';
        }).map(function (t) {
          return {
            id: t.id || uid(),
            /* the save file crosses the cloud boundary — clamp sizes and
               only ever accept plain http(s) icons so a tampered copy can't
               inject data:/javascript: URLs or giant strings */
            name: String(t.name).slice(0, 300),
            url: String(t.url).slice(0, 4096),
            icon: typeof t.icon === 'string' && /^https?:\/\//i.test(t.icon)
              ? t.icon.slice(0, 4096) : undefined
          };
        })
      : [];
    return {
      version: SEED_VERSION,
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
      sites: sites,
      settings: s,
      /* bookmarks slice is validated by js/bookmarks.js; null = keep sidebar-local */
      bookmarks: (o.bookmarks && typeof o.bookmarks === 'object') ? o.bookmarks : null,
      /* wallpaper slice is validated by js/walls.js */
      walls: (o.walls && typeof o.walls === 'object') ? o.walls : null
    };
  }

  function doc() {
    var d = { version: SEED_VERSION, updatedAt: state.updatedAt, sites: state.sites, settings: state.settings };
    /* the bookmarks sidebar + wallpaper feature contribute their slices (guarded) */
    if (window.BOOKMARKS) d.bookmarks = window.BOOKMARKS.forDoc();
    if (window.WALLS) d.walls = window.WALLS.forDoc();
    return d;
  }

  function persistLocal() {
    var d = doc();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch (e) { /* quota */ }
    if (window.chrome && chrome.storage && chrome.storage.local) {
      var o = {};
      o[STORE_KEY] = d;
      try { chrome.storage.local.set(o); } catch (e) { /* noop */ }
    }
  }

  /* chrome.storage.local is the durable copy (survives page localStorage
     eviction and extension reloads). localStorage is the fast synchronous
     read at boot; if that's empty we try chrome.storage before seeding. */
  function restoreFromStorage() {
    return new Promise(function (resolve) {
      if (!(window.chrome && chrome.storage && chrome.storage.local)) { resolve(null); return; }
      try {
        chrome.storage.local.get(STORE_KEY, function (o) {
          try { resolve(o && o[STORE_KEY] || null); } catch (e) { resolve(null); }
        });
      } catch (e) { resolve(null); }
    });
  }

  function commit(opts) {
    state.updatedAt = Date.now();
    /* NOTE: the seed flag is NOT cleared here on purpose. commit() also
       fires from module hooks (bookmarks merge / walls refresh) during the
       boot window, before syncStart's pull has settled — clearing it then
       would let an unflagged seed push clobber real cloud data. The flag is
       only dropped once a push succeeds or the cloud is adopted, which is
       the moment the local doc is provably legit. */
    /* callers that already applied the change live (slider drags) skip the
       full grid rebuild — only the capacity-affecting ones re-render */
    if (!opts || !opts.noRender) renderAll();
    persistLocal();
    if (!opts || !opts.noCloud) scheduleCloud();
  }

  function mutateSite(fn) {
    fn();
    state.updatedAt = Date.now();
    commit();
  }

  /* ------------------------------------------------------------------ render */

  function applyCssVars() {
    var s = state.settings;
    grid.style.setProperty('--ts', s.iconSize + 'px');
    grid.style.setProperty('--colgap', s.colGap + 'px');
    grid.style.setProperty('--rowgap', s.rowGap + 'px');
    /* panel widths ride on the root so the side panels (outside grid) read them */
    document.documentElement.style.setProperty('--bk-width', (s.bkWidth || 360) + 'px');
    document.documentElement.style.setProperty('--dr-width', (s.drWidth || 320) + 'px');
    grid.style.setProperty('--cols', String(s.cols));
    grid.style.gridAutoRows = (s.iconSize + (s.labels ? 24 : 0)) + 'px';
    if (s.labels) grid.classList.remove('tile-label-off');
    else grid.classList.add('tile-label-off');
    grid.style.setProperty('--label-op', ((s.labelOp == null ? 100 : s.labelOp) / 100).toFixed(2));
    grid.style.setProperty('--label-color', s.labelColor || '#f5f5f5');
    grid.classList.toggle('tile-mono', s.mono === true);
    document.documentElement.style.setProperty('--wall-blur', (s.blur || 0) + 'px');
    document.documentElement.classList.toggle('wall-mono', s.wallMono === true);
  }

  function initials(name) {
    var w = String(name).trim().split(/\s+/).filter(Boolean);
    return (w.slice(0, 2).map(function (x) { return x[0]; }).join('') || '?').toUpperCase();
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  /* favicon candidates, tried in order until one loads:
     0. a known-good official icon (google apps, deepseek), when applicable
     1. the site's own /favicon.ico (authoritative)
     2. google s2 (high-res re-render)
     3. duckduckgo icon service
     if all fail, the letter monogram is shown. */
  /* 2x gstatic product logos are 128px — crisp at tile size (the 1x are
     only 32dp and look soft once upscaled). Everything else goes through
     s2, which caps at the site's native favicon size. */
  var GSTATIC = 'https://ssl.gstatic.com/images/branding/product/2x/';
  var OFFICIAL_ICONS = {
    'mail.google.com': GSTATIC + 'gmail_2020q4_64dp.png',
    'drive.google.com': GSTATIC + 'drive_2020q4_64dp.png',
    'docs.google.com': GSTATIC + 'docs_2020q4_64dp.png',
    'sheets.google.com': GSTATIC + 'sheets_2020q4_64dp.png',
    'slides.google.com': GSTATIC + 'slides_2020q4_64dp.png',
    'calendar.google.com': GSTATIC + 'calendar_2020q4_64dp.png',
    'keep.google.com': GSTATIC + 'keep_2020q4_64dp.png',
    'meet.google.com': GSTATIC + 'meet_2020q4_64dp.png',
    'translate.google.co.in': 'https://www.google.com/s2/favicons?domain=translate.google.com&sz=128',
    'translate.google.com': 'https://www.google.com/s2/favicons?domain=translate.google.com&sz=128',
    'maps.google.com': 'https://www.google.com/s2/favicons?domain=maps.google.com&sz=128',
    'youtube.com': 'https://www.google.com/s2/favicons?domain=youtube.com&sz=128',
    'photos.google.com': 'https://www.google.com/s2/favicons?domain=photos.google.com&sz=128',
    'forms.google.com': 'https://www.google.com/s2/favicons?domain=forms.google.com&sz=128',
    'google.com': 'https://www.google.com/s2/favicons?domain=google.com&sz=128',
    'chat.deepseek.com': 'https://fe-static.deepseek.com/chat/icon-180.png',
    'deepseek.com': 'https://fe-static.deepseek.com/chat/icon-180.png'
  };
  var faviconCache = Object.create(null);
  var iconLoading = Object.create(null);

  /* Google serves every product off shared hosts (google.com/maps,
     docs.google.com/spreadsheets…), and s2's icon for those hosts is the
     generic search "G". Map host + path to the actual product icon so e.g.
     https://www.google.com/maps/ gets the Maps pin, not the G. */
  function officialIcon(url) {
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    var h = u.hostname.replace(/^www\./, '').toLowerCase();
    var p = u.pathname || '';
    /* path-based product detection must run first: google.com and
       docs.google.com each serve several products under one host */
    if (h === 'google.com') {
      if (p.indexOf('/maps') === 0) return OFFICIAL_ICONS['maps.google.com'];
      if (p.indexOf('/translate') === 0) return OFFICIAL_ICONS['translate.google.com'];
      if (p.indexOf('/calendar') === 0) return OFFICIAL_ICONS['calendar.google.com'];
      if (p.indexOf('/drive') === 0) return OFFICIAL_ICONS['drive.google.com'];
      if (p.indexOf('/photos') === 0) return OFFICIAL_ICONS['photos.google.com'];
      if (p.indexOf('/gmail') === 0 || p.indexOf('/mail') === 0) return OFFICIAL_ICONS['mail.google.com'];
      if (p.indexOf('/keep') === 0) return OFFICIAL_ICONS['keep.google.com'];
      if (p.indexOf('/meet') === 0) return OFFICIAL_ICONS['meet.google.com'];
      if (p.indexOf('/forms') === 0) return OFFICIAL_ICONS['forms.google.com'];
      if (p.indexOf('/sheets') === 0) return OFFICIAL_ICONS['sheets.google.com'];
      if (p.indexOf('/slides') === 0) return OFFICIAL_ICONS['slides.google.com'];
      if (p.indexOf('/docs') === 0) return OFFICIAL_ICONS['docs.google.com'];
      return OFFICIAL_ICONS['google.com'];
    }
    if (h === 'docs.google.com') {
      if (p.indexOf('/spreadsheets') === 0) return OFFICIAL_ICONS['sheets.google.com'];
      if (p.indexOf('/presentation') === 0) return OFFICIAL_ICONS['slides.google.com'];
      if (p.indexOf('/forms') === 0) return OFFICIAL_ICONS['forms.google.com'];
    }
    return OFFICIAL_ICONS[h] || null;
  }

  function iconCandidates(site) {
    var h = hostOf(site.url);
    var cands = [];
    if (site.icon) cands.push({ src: site.icon, preferred: true });
    if (!h) return cands;
    var first = officialIcon(site.url);
    if (first) cands.push({ src: first, preferred: true });
    /* the site's OWN icons first — they're the authoritative source and
       usually the biggest (apple-touch-icon is 120-192px). s2/ddg re-render
       services cap at the native favicon size (GitHub is 32px even at
       sz=256), so they must never beat a real hi-res icon. */
    cands.push({ src: 'https://' + h + '/apple-touch-icon.png', preferred: true });
    cands.push({ src: 'https://' + h + '/favicon-32x32.png', preferred: false });
    cands.push({ src: 'https://' + h + '/favicon.ico', preferred: false });
    /* then the re-render services as fallbacks. Google's 16px 404-default
       (a generic globe) is filtered in loadIcon so it never settles. */
    var s2url = function (d) {
      return 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(d) + '&sz=256';
    };
    /* try the host, then its parent domains — subdomains (web.whatsapp.com,
       console.neon.tech, dashboard.render.com) usually only have a real icon
       on the root */
    var variants = [h];
    var parts = h.split('.');
    while (parts.length > 2) {
      parts.shift();
      variants.push(parts.join('.'));
    }
    for (var i = 0; i < variants.length; i++) {
      cands.push({ src: s2url(variants[i]), preferred: false, chip: true });
    }
    cands.push({ src: 'https://icons.duckduckgo.com/ip3/' + encodeURIComponent(h) + '.ico', preferred: false });
    return cands;
  }

  /* failed icons are remembered (monogram) but retried a few times with
     backoff, and again whenever connectivity returns — a slow network or CDN
     hiccup is not a permanent failure. */
  /* winning favicon src per url, persisted across sessions (localStorage for
     instant new-tab boots + chrome.storage for durability across reloads). A
     new-tab page is opened constantly — re-resolving every icon from scratch
     (4-6 candidate requests per tile) on every boot is the biggest repeated
     cost, so the saved winner is tried first: one request, usually an HTTP
     cache hit. Stale entries self-heal — a 404 falls through to the full
     candidate list and re-persists the new winner. */
  var ICON_CACHE_KEY = 'glisters-icons';
  var persistedIcons = Object.create(null);
  var iconPersistTimer = 0;
  function loadPersistedIcons() {
    try {
      var raw = localStorage.getItem(ICON_CACHE_KEY);
      if (raw) {
        var m = JSON.parse(raw);
        for (var k in m) if (typeof m[k] === 'string') persistedIcons[k] = m[k];
      }
    } catch (e) { /* fresh profile */ }
    if (window.chrome && chrome.storage && chrome.storage.local) {
      try {
        chrome.storage.local.get(ICON_CACHE_KEY, function (o) {
          var m = o && o[ICON_CACHE_KEY];
          if (m && typeof m === 'object') {
            for (var k2 in m) if (typeof m[k2] === 'string') persistedIcons[k2] = m[k2];
          }
        });
      } catch (e) { /* noop */ }
    }
  }
  function persistIcon(key, src) {
    if (!key || !src) return;
    persistedIcons[key] = src;
    clearTimeout(iconPersistTimer);
    iconPersistTimer = setTimeout(function () {
      try { localStorage.setItem(ICON_CACHE_KEY, JSON.stringify(persistedIcons)); } catch (e) { /* quota */ }
      if (window.chrome && chrome.storage && chrome.storage.local) {
        try {
          var o = {};
          o[ICON_CACHE_KEY] = persistedIcons;
          chrome.storage.local.set(o);
        } catch (e) { /* noop */ }
      }
    }, 400);
  }

  var iconRetries = Object.create(null);

  function scheduleIconRetry(key) {
    if (!key || mode !== 'none' || dragUi) return;
    var n = (iconRetries[key] || 0) + 1;
    iconRetries[key] = n;
    if (n > 3) return; /* give up — monogram is the stable fallback */
    setTimeout(function () { retryIcon(key); }, n * 5000);
  }

  function retryIcon(key) {
    if (faviconCache[key] !== false || mode !== 'none' || dragUi) return;
    delete faviconCache[key]; /* forget the failure so the next build retries */
    for (var i = pageStart(); i <= pageEnd(); i++) {
      if (state.sites[i] && state.sites[i].url === key) {
        replaceTile(i);
        break;
      }
    }
  }

  function replaceTile(idx) {
    var b = grid.querySelector('[data-idx="' + idx + '"]');
    if (!b) return;
    var nb = tileEl(state.sites[idx], idx);
    b.parentNode.replaceChild(nb, b);
    renderTileStates();
  }

  function retryAllFailed() {
    if (mode !== 'none' || dragUi) return;
    var any = false;
    for (var k in faviconCache) {
      if (faviconCache[k] === false) { delete faviconCache[k]; any = true; }
    }
    if (any) renderGrid();
  }

  /* loads candidates in parallel. a "preferred" candidate settles the icon as
     soon as it decodes; the rest keep the largest-wins fallback. The guard is
     a backstop only — slow loads get every chance to finish. */
  function loadIcon(ic, letter, cands, key, onFail) {
    var bestImg = null, bestW = 0, settled = false;
    var guard = cands.length ? setTimeout(finalize, 6000) : 0;
    /* if a hi-res candidate (official icon / apple-touch-icon) is present,
       the s2 re-renders must never beat it in a race — only preferred
       candidates settle early; everything else waits for allDone/guard. */
    var hasPreferred = false;
    for (var p = 0; p < cands.length; p++) { if (cands[p].preferred) { hasPreferred = true; break; } }

    for (var i = 0; i < cands.length; i++) trySrc(cands[i].src, cands[i].preferred, cands[i].chip);

    function finalize() {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      if (key) iconLoading[key] = false;
      if (bestImg) {
        /* only drop the losing favicon candidates — never the letter
           monogram or the right-click action buttons (which are also
           children of the icon box) */
        var kids = Array.prototype.slice.call(ic.children);
        for (var k = 0; k < kids.length; k++) {
          if (kids[k].tagName === 'IMG' && kids[k] !== bestImg) ic.removeChild(kids[k]);
        }
        if (letter) letter.style.display = 'none';
        /* small favicons get an integer upscale (2x, 3x…) via nearest-
           neighbor (.sharp) so they're bigger yet stay razor-sharp. Only
           whole multiples are used — a fractional scale (e.g. 32px → 39px)
           makes image-rendering: pixelated glitch into blocky artifacts. */
        var nw = bestImg.naturalWidth, nh = bestImg.naturalHeight;
        if (nw > 0 && nw < 40) {
          var cap = Math.floor(ic.offsetWidth * 0.55);
          var scale = 1;
          while (nw * (scale + 1) <= cap && nh * (scale + 1) <= cap) scale++;
          if (scale > 1) bestImg.classList.add('sharp');
          bestImg.style.width = (nw * scale) + 'px';
          bestImg.style.height = (nh * scale) + 'px';
        }
        /* cache the decoded element, not just the src, so page flips reuse
           it from the image cache instead of refetching; also remember the
           winner across sessions so future boots resolve instantly */
        if (key) {
          faviconCache[key] = bestImg;
          if (bestImg.src) persistIcon(key, bestImg.src);
        }
      } else if (key) {
        /* remember the failure, but retry it a few times later in case the
           network was just slow or the CDN hiccuped */
        faviconCache[key] = false;
        scheduleIconRetry(key);
        if (onFail) onFail();
      }
    }

    function allDone() {
      var kids = ic.children;
      for (var k = 0; k < kids.length; k++) {
        if (kids[k].tagName === 'IMG' && !kids[k]._done) return;
      }
      finalize();
    }

    function trySrc(src, preferred, chip) {
      var img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      var done = false;
      var idle = setTimeout(function () {
        if (done || settled) return;
        done = true;
        img._done = true;
        if (img.parentNode) img.remove();
        allDone();
      }, 4000);
      img.addEventListener('load', function () {
        if (done || settled) return;
        done = true;
        img._done = true;
        clearTimeout(idle);
        var w = img.naturalWidth, h = img.naturalHeight;
        /* too tiny (favicon services' 404-default is a 16px generic globe) —
           never settle on it, it's not a real icon */
        if (w < 16 || h < 16 || (chip && w <= 16)) {
          if (img.parentNode) img.remove();
          allDone();
          return;
        }
        if (preferred) {
          /* the curated/official/hi-res icon decoded — settle on it now */
          bestW = w; bestImg = img;
          finalize();
          return;
        }
        if (w > bestW) { bestW = w; bestImg = img; }
        if (w >= 128 && !hasPreferred) finalize();
        else allDone();
      });
      img.addEventListener('error', function () {
        if (done || settled) return;
        done = true;
        img._done = true;
        clearTimeout(idle);
        if (img.parentNode) img.remove();
        allDone();
      });
      ic.appendChild(img);
    }
  }

  function tileEl(site, i) {
    var b = el('button', 'tile');
    b.type = 'button';
    b.dataset.idx = i;
    b.title = site.name + ' — ' + site.url;
    b.draggable = false;

    var ic = el('span', 'icon');
    var letter = el('span', 'letter', initials(site.name));
    ic.appendChild(letter);

    var key = site.url;
    var cached = faviconCache[key];
    if (cached) {
      /* reuse the decoded image from the memory cache — no refetch, no flicker */
      var img = cached.cloneNode(false);
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      ic.appendChild(img);
      if (letter) letter.style.display = 'none';
    } else if (cached === undefined && !iconLoading[key]) {
      iconLoading[key] = true;
      /* a custom icon the user picked is always authoritative — never let
         the persisted winner bypass it */
      if (persistedIcons[key] && !site.icon) {
        /* the saved winner is the only candidate on repeat boots — one
           (usually HTTP cache-hit) request per tile instead of the 4-6
           candidate blast. If it's stale (site changed its icon, src 404s)
           forget it and fall back to the full resolution. */
        loadIcon(ic, letter, [{ src: persistedIcons[key], preferred: true }], key, function () {
          delete persistedIcons[key];
          delete faviconCache[key];
          for (var i = pageStart(); i <= pageEnd(); i++) {
            if (state.sites[i] && state.sites[i].url === key) { replaceTile(i); break; }
          }
        });
      } else {
        var cands = iconCandidates(site);
        if (cands.length) loadIcon(ic, letter, cands, key);
      }
    }
    /* cached === false → icon known-failed; keep the letter monogram */

    /* right-click actions — two buttons natively overlaid on the icon circle */
    var editBtn = el('span', 'ctx-btn ctx-edit');
    editBtn.setAttribute('role', 'button');
    editBtn.setAttribute('aria-label', 'edit ' + site.name);
    editBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>';
    editBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var idx = state.sites.indexOf(site);
      closeCtx();
      /* keep the icon dimmed behind the edit modal — restore on close */
      if (idx >= 0) {
        var t = grid.querySelector('[data-idx="' + idx + '"]');
        if (t) t.classList.add('ctx-dim');
      }
      openModal(site);
    });
    var delBtn = el('span', 'ctx-btn ctx-delete');
    delBtn.setAttribute('role', 'button');
    delBtn.setAttribute('aria-label', 'delete ' + site.name);
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    delBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      closeCtx();
      var idx = state.sites.indexOf(site);
      if (idx >= 0) removeSite(idx);
    });
    ic.appendChild(editBtn);
    ic.appendChild(delBtn);

    b.appendChild(ic);
    b.appendChild(el('span', 'label', site.name));
    return b;
  }

  function renderGrid() {
    grid.innerHTML = '';
    if (state.sites.length === 0) return;
    var start = pageStart();
    var end = pageEnd();
    var cap = cellCapacity();
    for (var i = start; i <= end; i++) {
      grid.appendChild(tileEl(state.sites[i], i));
    }
    /* fill the page's remaining cells with empty placeholders so a partial
       last page still shows its full rows (pure visual — no links added) */
    for (var j = end - start + 1; j < cap; j++) {
      grid.appendChild(el('div', 'cell-empty'));
    }
  }

  function renderTileStates() {
    var kids = grid.children;
    for (var i = 0; i < kids.length; i++) {
      var t = kids[i];
      var ix = parseInt(t.dataset.idx, 10);
      t.classList.toggle('focused', ix === focused);
      t.classList.toggle('armed', ix === armed);
    }
  }

  function updateEmpty() {
    var has = state.sites.length > 0;
    empty.hidden = has;
    grid.style.display = has ? '' : 'none';
  }

  /* ---- pagination ---- */

  function cellCapacity() {
    return Math.max(1, state.settings.cols * state.settings.rows);
  }

  function pageCount() {
    return Math.max(1, Math.ceil(state.sites.length / cellCapacity()));
  }

  function pageStart() {
    return page * cellCapacity();
  }

  function pageEnd() {
    var end = pageStart() + cellCapacity() - 1;
    return Math.min(end, state.sites.length - 1);
  }

  function clampPage() {
    if (state.sites.length === 0) page = 0;
    else page = Math.max(0, Math.min(page, pageCount() - 1));
  }

  function goPage(p) {
    if (state.sites.length === 0) return;
    var pc = pageCount();
    var np = ((p % pc) + pc) % pc; /* loop around */
    if (np === page) return;
    /* slide follows the direction of travel, not the wrapped index — scrolling
       forward past the last page wraps to page 0 but still slides in from the
       front, and scrolling back from page 0 wraps to the last page sliding in
       from behind */
    var dir = p > page ? 1 : -1;
    page = np;
    focused = pageStart();
    animatePage(dir);
    renderGrid();
    renderTileStates();
  }

  var pageGhost = null;

  function animatePage(dir) {
    grid.classList.remove('anim-next', 'anim-prev', 'anim-reorder');
    if (pageGhost) { pageGhost.remove(); pageGhost = null; }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    /* snapshot the outgoing page so it can slide away while the new page
       (re-rendered underneath) slides in — a real two-layer transition. */
    var ghost = grid.cloneNode(true);
    ghost.classList.remove('anim-next', 'anim-prev', 'anim-reorder', 'dragging-active');
    ghost.classList.add('page-snapshot', dir > 0 ? 'page-out-next' : 'page-out-prev');
    var r = grid.getBoundingClientRect();
    var sr = scrollArea.getBoundingClientRect();
    ghost.style.position = 'absolute';
    ghost.style.left = (r.left - sr.left + scrollArea.scrollLeft) + 'px';
    ghost.style.top = (r.top - sr.top + scrollArea.scrollTop) + 'px';
    ghost.style.width = r.width + 'px';
    ghost.style.margin = '0';
    scrollArea.appendChild(ghost);
    pageGhost = ghost;

    function drop() {
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
      if (pageGhost === ghost) pageGhost = null;
    }
    ghost.addEventListener('animationend', drop, { once: true });
    setTimeout(drop, 600); /* safety net if animationend never fires */

    void grid.offsetWidth; /* reflow so the enter animation restarts */
    grid.classList.add(dir > 0 ? 'anim-next' : 'anim-prev');
  }

  function renderAll() {
    clampPage();
    if (state.sites.length === 0) {
      focused = -1;
    } else {
      if (focused < pageStart()) focused = pageStart();
      if (focused > pageEnd()) focused = pageEnd();
    }
    applyCssVars();
    renderGrid();
    updateEmpty();
    renderTileStates();
    /* only touch the drawer's inputs while it's actually open */
    if (drawer && drawer.classList.contains('open')) syncDrawerDisplay();
  }

  function setFocused(i) {
    armed = -1;
    clearTimeout(armTimer);
    focused = i;
    renderTileStates();
  }

  /* ------------------------------------------------------------------ nav */

  function normUrl(url) {
    var u = String(url).trim();
    if (!u) return '';
    /* only web / mail links are ever navigable from this page — javascript:,
       data:, file: and friends are never opened (defense-in-depth against a
       tampered cloud save being able to execute code in the extension) */
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return 'https://' + u;
    var scheme = u.slice(0, u.indexOf(':')).toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return u;
    return '';
  }

  function openInNewTab(url) {
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
        /* active:false keeps the new-tab page in view and focused */
        chrome.tabs.create({ url: url, active: false });
        return;
      }
    } catch (e) { /* fall through to window.open */ }
    try {
      var w = window.open(url, '_blank', 'noopener');
      if (!w) location.assign(url);
    } catch (e) { location.assign(url); }
  }

  function openInSameTab(url) {
    try { location.assign(url); } catch (e) { /* noop */ }
  }

  function open(i, opts) {
    var n = state.sites.length;
    if (n === 0 || i >= n) { openModal(null); return; }
    var url = normUrl(state.sites[i].url);
    if (!url) return;
    if (opts && opts.newTab) openInNewTab(url);
    else openInSameTab(url);
  }

  function moveV(d, cols) {
    if (focused < 0) { focused = pageStart(); return; }
    var start = pageStart();
    var end = pageEnd();
    if (end < start) return;
    var i = focused + d * cols;
    focused = i < start ? start : i > end ? end : i;
  }

  function removeSite(i) {
    if (i < 0 || i >= state.sites.length) return;
    mutateSite(function () { state.sites.splice(i, 1); });
    armed = -1;
    if (focused >= state.sites.length) focused = state.sites.length - 1;
    if (focused < 0) focused = -1;
  }

  /* ------------------------------------------------------------------ keys */

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented) return;

    /* ctrl/meta + enter (or o) opens the focused tile in a new tab */
    if ((e.key === 'Enter' || e.key === 'o') && (e.ctrlKey || e.metaKey) &&
        mode === 'none' && focused >= 0) {
      var t0 = e.target;
      if (t0.tagName !== 'INPUT' && t0.tagName !== 'TEXTAREA' &&
          t0.tagName !== 'SELECT' && !t0.isContentEditable) {
        open(focused, { newTab: true });
        e.preventDefault();
        return;
      }
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (mode === 'modal') {
      if (e.key === 'Escape') { closeModal(); e.preventDefault(); }
      return;
    }

    if (mode === 'bar') {
      if (e.key === 'Escape') { closeBar(); e.preventDefault(); }
      return;
    }

    var t = e.target;
    var typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' || t.isContentEditable;
    if (typing) return;

    if (mode === 'drawer') {
      if (e.key === 'Escape' || e.key === 's') { closeDrawer(); e.preventDefault(); }
      return;
    }

    /* keyboard navigation — bring the focus ring back */
    grid.classList.remove('mouse-nav');

    var n = state.sites.length;
    var cols = state.settings.cols;
    var pStart = pageStart();
    var pEnd = pageEnd();
    var handled = true;

    switch (e.key) {
      case 'h': case 'ArrowLeft':
        if (focused < 0) focused = pStart;
        else if (focused % cols > 0 && focused > pStart) focused--;
        break;
      case 'l': case 'ArrowRight':
        if (focused < 0) focused = pStart;
        else if (focused % cols < cols - 1 && focused < pEnd) focused++;
        break;
      case 'j': case 'ArrowDown': moveV(1, cols); break;
      case 'k': case 'ArrowUp': moveV(-1, cols); break;
      case 'g': focused = pStart; break;
      case 'G': case 'End': focused = pEnd; break;
      case 'Home': focused = pStart; break;
      case 'Tab':
        e.preventDefault();
        goPage(e.shiftKey ? page - 1 : page + 1);
        break;
      case 'PageDown':
        e.preventDefault();
        goPage(page + 1);
        break;
      case 'PageUp':
        e.preventDefault();
        goPage(page - 1);
        break;
      case 'Enter': case 'o':
        if (focused < 0) focused = pStart;
        open(focused);
        break;
      case 'a': openModal(null); break;
      case 'e':
        if (focused >= 0 && focused < n) openModal(state.sites[focused]);
        break;
      case 'd':
        if (focused < 0 || focused >= n) break;
        if (armed === focused) { removeSite(focused); }
        else {
          armed = focused;
          clearTimeout(armTimer);
          armTimer = setTimeout(function () { armed = -1; renderTileStates(); }, 2500);
          renderTileStates();
        }
        break;
      case 's': toggleDrawer(); break;
      case '/': case ':': openBar(); break;
      case 'Escape':
        if (armed >= 0) armed = -1;
        closeCtx();
        handled = true;
        break;
      default: handled = false;
    }

    if (handled) e.preventDefault();
    /* any other handled key cancels a pending delete — but a second `d` is
       the confirmation, so it must see the armed state */
    if (handled && e.key !== 'Escape' && e.key !== 's' && e.key !== 'a' && e.key !== 'd') {
      clearTimeout(armTimer);
      armed = -1;
    }
    renderTileStates();
  });

  /* ------------------------------------------------------------------ mouse */

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (dirty) pushCloud();
    }
  });

  var wheelLock = false;
  scrollArea.addEventListener('wheel', function (e) {
    if (e.ctrlKey || mode !== 'none') return;
    e.preventDefault();
    if (wheelLock) return;
    var d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (d === 0) return;
    wheelLock = true;
    setTimeout(function () { wheelLock = false; }, 180);
    goPage(page + (d > 0 ? 1 : -1));
  }, { passive: false });

  grid.addEventListener('mouseover', function (e) {
    var b = e.target.closest && e.target.closest('.tile');
    if (b) {
      /* mouse-driven navigation — hide the focus ring until the keyboard is used */
      grid.classList.add('mouse-nav');
      setFocused(parseInt(b.dataset.idx, 10));
    }
  });

  grid.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }
    var b = e.target.closest && e.target.closest('.tile');
    if (!b) return;
    open(parseInt(b.dataset.idx, 10), { newTab: e.ctrlKey || e.metaKey });
  });

  /* right-click a tile: overlay edit/delete buttons on the icon box */
  /* ---- right-click actions: overlay the buttons on the icon circle ---- */

  function closeCtx() {
    var open = grid.querySelectorAll('.tile.ctx-open');
    for (var i = 0; i < open.length; i++) open[i].classList.remove('ctx-open');
  }

  grid.addEventListener('contextmenu', function (e) {
    var b = e.target.closest && e.target.closest('.tile');
    if (!b) return;
    var idx = parseInt(b.dataset.idx, 10);
    if (idx < 0 || idx >= state.sites.length) return;
    e.preventDefault();
    closeCtx();
    setFocused(idx);
    b.classList.add('ctx-open');
  });

  document.addEventListener('contextmenu', function (e) {
    if (e.target.closest && e.target.closest('.tile')) return;
    closeCtx();
  });

  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.ctx-btn')) return;
    closeCtx();
  });

  /* every drag is followed by one synthesized "ghost" click. The grid
     swallows it (suppressClick) when it lands on a tile — but when the drag
     ends outside the grid the click lands elsewhere and the flag would stay
     set, eating the user's NEXT real click. Clear it after any click; the
     deferred clear runs after the grid's bubble handler has already had its
     chance to suppress the ghost click. */
  document.addEventListener('click', function () {
    setTimeout(function () { suppressClick = false; }, 0);
  }, true);

  /* drag to reorder — custom pointer drag (HTML5 DnD cancels as soon as the
     drag fires). Butter-smooth: as the ghost crosses the grid the OTHER tiles
     FLIP-animate out of the way live (DOM reorder + transform transitions),
     the source tile becomes an invisible gap, and a lifted ghost follows the
     cursor. Cross-page support via edge auto-flip. */
  var dragFrom = null;
  var dragUi = null;
  var suppressClick = false;
  var autoFlipDir = 0;
  var autoFlipTimer = null;
  var flipTimer = null;

  function stopAutoFlip() {
    autoFlipDir = 0;
    if (autoFlipTimer) { clearInterval(autoFlipTimer); autoFlipTimer = null; }
  }

  function armAutoFlip(x, y) {
    var r = scrollArea.getBoundingClientRect();
    if (y < r.top || y > r.bottom) { stopAutoFlip(); return; }
    var dir = 0;
    if (x < r.left + 70) dir = -1;
    else if (x > r.right - 70) dir = 1;
    if (dir === autoFlipDir) return;
    autoFlipDir = dir;
    if (autoFlipTimer) { clearInterval(autoFlipTimer); autoFlipTimer = null; }
    if (dir) {
      autoFlipTimer = setInterval(function () {
        if (autoFlipDir) goPage(page + autoFlipDir);
      }, 480);
    }
  }

  /* FLIP — capture each child's rect KEYED BY ITS NODE so a later layout
     change can be animated node-by-node: each child is inverted to its own
     old position then transitioned back, so a DOM reorder reads as a smooth
     slide instead of a snap (position-keyed rects would animate tiles from
     the wrong cells). */
  function snapRects() {
    var kids = grid.children, out = [];
    for (var i = 0; i < kids.length; i++) {
      out.push({ node: kids[i], rect: kids[i].getBoundingClientRect() });
    }
    return out;
  }

  function flipFrom(captured) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var kids = grid.children;
    var moved = 0;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      var old = null;
      for (var k = 0; k < captured.length; k++) {
        if (captured[k].node === c) { old = captured[k].rect; break; }
      }
      if (!old) continue;
      var last = c.getBoundingClientRect();
      var dx = old.left - last.left;
      var dy = old.top - last.top;
      if (dx !== 0 || dy !== 0) {
        c.style.transition = 'none';
        c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        moved++;
      }
    }
    if (!moved) return;
    void grid.offsetWidth; /* reflow — apply the inversion before playing */
    for (var j = 0; j < kids.length; j++) {
      var t = kids[j];
      if (t.style.transform) {
        t.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.7, 0.3, 1)';
        t.style.transform = '';
      }
    }
    if (flipTimer) clearTimeout(flipTimer);
    flipTimer = setTimeout(function () {
      var k = grid.children;
      for (var n = 0; n < k.length; n++) {
        k[n].style.transition = '';
        k[n].style.transform = '';
      }
    }, 400);
  }

  function highlightDrop(b) {
    var tiles = grid.querySelectorAll('.tile.drop-target');
    for (var i = 0; i < tiles.length; i++) tiles[i].classList.remove('drop-target');
    if (dragUi && b) b.classList.add('drop-target');
  }

  function makeGhost(b) {
    var g = b.cloneNode(true);
    g.removeAttribute('id');
    g.className = 'tile drag-ghost';
    g.style.width = b.offsetWidth + 'px';
    /* the tile sizing vars (--ts, label styles) live as inline styles on the
       grid element — the ghost sits on <body>, so copy them or the icon box
       has no size and the favicon stretches to its natural dimensions */
    ['--ts', '--label-op', '--label-color'].forEach(function (v) {
      g.style.setProperty(v, grid.style.getPropertyValue(v));
    });
    document.body.appendChild(g);
    return g;
  }

  function cleanupDrag() {
    if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; }
    if (dragUi && dragUi.ghost) dragUi.ghost.remove();
    dragUi = null;
    dragFrom = null;
    grid.classList.remove('dragging-active');
    var d = grid.querySelectorAll('.tile.dragging');
    for (var i = 0; i < d.length; i++) d[i].classList.remove('dragging');
    highlightDrop(null);
    stopAutoFlip();
  }

  /* the dragged tile's node on the current page (null when it lives on
     another page) */
  function draggedNode() {
    return dragFrom == null ? null : grid.querySelector('[data-idx="' + dragFrom + '"]');
  }

  /* grid cell geometry, measured once at drag start (before any reorder) so
     the pointer → cell mapping stays stable while tiles FLIP around */
  function measureGrid() {
    var first = grid.querySelector('.tile');
    if (!first) return null;
    var r = first.getBoundingClientRect();
    var cs = getComputedStyle(grid);
    var cg = parseFloat(cs.columnGap) || 0;
    var rg = parseFloat(cs.rowGap) || 0;
    return {
      originX: r.left, originY: r.top,
      strideX: r.width + cg, strideY: r.height + rg,
      cols: Math.max(1, state.settings.cols), rows: Math.max(1, state.settings.rows)
    };
  }

  function slotAt(g, x, y) {
    var col = Math.round((x - g.originX) / g.strideX);
    var row = Math.round((y - g.originY) / g.strideY);
    col = Math.max(0, Math.min(col, g.cols - 1));
    row = Math.max(0, Math.min(row, g.rows - 1));
    return row * g.cols + col;
  }

  function inGridBounds(g, x, y) {
    var x0 = g.originX - g.strideX * 0.5;
    var x1 = g.originX + (g.cols - 1) * g.strideX + g.strideX * 0.5;
    var y0 = g.originY - g.strideY * 0.5;
    var y1 = g.originY + (g.rows - 1) * g.strideY + g.strideY * 0.5;
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }

  /* live reorder: move the dragged tile's DOM node into the cell under the
     pointer and FLIP the displaced tiles out of the way. Cell-based (not
     hit-testing) so the tile never 'runs away' from the cursor. The target
     is the child INDEX that src must occupy: moving right (cur < slot)
     inserts before the child that follows the slot, moving left before the
     child that is at the slot. */
  function reorderToSlot(slot) {
    var src = draggedNode();
    if (!src) return; /* dragged tile lives on another page — visual only */
    var kids = grid.children;
    var cap = Math.max(1, state.settings.cols * state.settings.rows);
    if (slot >= cap) slot = cap - 1;
    var cur = Array.prototype.indexOf.call(kids, src);
    if (cur === -1 || cur === slot) return; /* already in the target cell */
    var idx = cur < slot ? slot + 1 : slot;
    var anchor = idx < kids.length ? kids[idx] : null;
    var rects = snapRects();
    grid.insertBefore(src, anchor);
    flipFrom(rects);
  }

  /* slide the grid back to its original order (drag cancelled) */
  function undoLiveOrder() {
    if (!dragUi || !dragUi.orig || dragUi.orig.length < 2) return;
    var rects = snapRects();
    for (var i = 0; i < dragUi.orig.length; i++) {
      if (dragUi.orig[i].parentNode === grid) grid.appendChild(dragUi.orig[i]);
    }
    flipFrom(rects);
  }

  grid.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || mode !== 'none') return;
    var b = e.target.closest && e.target.closest('.tile');
    if (!b) return;
    dragFrom = parseInt(b.dataset.idx, 10);
    dragUi = {
      from: dragFrom,
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      moved: false, ghost: null, page: page,
      geom: null, orig: null, lastSlot: -1, lastInGrid: false, pageChangedAt: 0
    };
  });

  window.addEventListener('pointermove', function (e) {
    if (!dragUi) return;
    var dx = e.clientX - dragUi.startX, dy = e.clientY - dragUi.startY;
    if (!dragUi.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
    if (!dragUi.moved) {
      dragUi.moved = true;
      e.preventDefault();
      grid.classList.add('dragging-active');
      dragUi.geom = measureGrid();
      dragUi.orig = Array.prototype.slice.call(grid.children);
      var src = draggedNode();
      if (src) src.classList.add('dragging');
      dragUi.ghost = makeGhost(src || e.target.closest('.tile'));
      dragUi.ghost.style.transform = 'translate(' + (dragUi.startX + 12) + 'px,' + (dragUi.startY + 12) + 'px) scale(1.06)';
    }
    if (!dragUi.moved || !dragUi.geom) return;
    e.preventDefault();
    dragUi.lastX = e.clientX; dragUi.lastY = e.clientY;
    dragUi.ghost.style.transform = 'translate(' + (e.clientX + 12) + 'px,' + (e.clientY + 12) + 'px) scale(1.06)';
    armAutoFlip(e.clientX, e.clientY);
    /* after a page flip the grid was re-rendered — re-apply the dragged
       state to the fresh node, re-measure, and hold reorder until the page
       slide settles */
    if (dragUi.page !== page) {
      dragUi.page = page;
      dragUi.pageChangedAt = Date.now();
      dragUi.geom = measureGrid();
      dragUi.orig = Array.prototype.slice.call(grid.children);
      dragUi.lastSlot = -1;
      var fresh = draggedNode();
      if (fresh) fresh.classList.add('dragging');
    }
    var g = dragUi.geom;
    var inGrid = inGridBounds(g, e.clientX, e.clientY);
    dragUi.lastInGrid = inGrid;
    if (inGrid) {
      var slot = slotAt(g, e.clientX, e.clientY);
      dragUi.lastSlot = slot;
      var kids = grid.children;
      var b = kids[slot] && kids[slot].classList.contains('tile') ? kids[slot] : null;
      highlightDrop(b);
      if (Date.now() - dragUi.pageChangedAt > 380) reorderToSlot(slot);
    } else {
      highlightDrop(null);
    }
  });

  window.addEventListener('pointerup', function (e) {
    if (!dragUi) return;
    var moved = dragUi.moved;
    if (moved) {
      e.preventDefault();
      stopAutoFlip();
      suppressClick = true;
      /* commit uses the same cell-based mapping as the live reorder, so the
         released tile lands exactly where the drag left it — even if the
         FLIP animation was mid-flight under the pointer */
      var g = dragUi.geom;
      var inGrid = g && inGridBounds(g, e.clientX, e.clientY);
      if (g && inGrid) {
        var slot = slotAt(g, e.clientX, e.clientY);
        var to = pageStart() + slot;
        if (to > state.sites.length) to = state.sites.length;
        if (to !== dragFrom) {
          var arr = state.sites.slice();
          var movedSite = arr.splice(dragFrom, 1)[0];
          arr.splice(to, 0, movedSite);
          mutateSite(function () { state.sites = arr; });
          focused = to;
          renderTileStates();
        }
      } else {
        /* released outside the grid — cancel and slide the tiles back */
        undoLiveOrder();
      }
    }
    cleanupDrag();
  });

  window.addEventListener('pointercancel', function () {
    if (dragUi && dragUi.moved) undoLiveOrder();
    cleanupDrag();
  });

  /* ------------------------------------------------------------------ modal */

  var editingIdx = -1;
  /* '' = auto-detect the icon; otherwise the chosen src is stored on the tile */
  var pickedIcon = '';
  var lastAutoName = '';
  var metaTimer = 0;

  function openModal(site) {
    /* a pending delete must never survive the modal — arming `d` then
       changing your mind (`a` to add) shouldn't delete anything on a later
       stray `d` */
    armed = -1;
    clearTimeout(armTimer);
    editingIdx = site ? state.sites.indexOf(site) : -1;
    nameIn.value = site ? site.name : '';
    urlIn.value = site ? site.url : '';
    modalTitle.textContent = site ? 'edit shortcut' : 'add shortcut';
    pickedIcon = site && site.icon ? site.icon : '';
    lastAutoName = '';
    modalEl.hidden = false;
    mode = 'modal';
    renderIconPicker(urlIn.value, pickedIcon);
    /* detect the title for whatever's already in the url field */
    scheduleMetaDetect();
    if (site && site.name) urlIn.focus();
    else nameIn.focus();
  }

  function closeModal() {
    modalEl.hidden = true;
    mode = 'none';
    editingIdx = -1;
    pickedIcon = '';
    clearTimeout(metaTimer);
    iconPicker.innerHTML = '';
    metaStatus.hidden = true;
    /* the icon dimmed behind the modal is only a visual — restore it */
    var dim = grid.querySelectorAll('.tile.ctx-dim');
    for (var i = 0; i < dim.length; i++) dim[i].classList.remove('ctx-dim');
  }

  /* typing in the name means the user is done with auto-fill — don't overwrite */
  nameIn.addEventListener('input', function () { lastAutoName = ''; });
  urlIn.addEventListener('input', scheduleMetaDetect);

  function scheduleMetaDetect() {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(function () {
      renderIconPicker(urlIn.value, pickedIcon);
      detectMeta(urlIn.value);
    }, 400);
  }

  /* ---- icon picker: circular choices from the same candidate machinery the
     grid uses, plus any icons the page itself declares ---- */

  function renderIconPicker(rawUrl, selectedSrc) {
    iconPicker.innerHTML = '';
    var url = normUrl(rawUrl);
    iconPicker.appendChild(autoPickEl(selectedSrc === ''));
    if (!url) return;
    var seen = {};
    var cands = iconCandidates({ url: url, icon: '' });
    cands.forEach(function (c) { if (c.src) seen[c.src] = 1; });
    /* icons found in the page's own HTML get appended too */
    (metaIcons[url] || []).forEach(function (src) {
      if (!src || seen[src]) return;
      seen[src] = 1;
      cands.push({ src: src, preferred: false });
    });
    var shown = 0;
    for (var i = 0; i < cands.length && shown < 8; i++) {
      (function (src) {
        var b = el('button', 'pick-item');
        b.type = 'button';
        b.dataset.src = src;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', src === selectedSrc ? 'true' : 'false');
        b.title = src;
        var img = el('img');
        img.src = src;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';
        img.draggable = false;
        var failTimer = setTimeout(function () {
          if (b.parentNode) b.parentNode.removeChild(b);
        }, 6000);
        img.addEventListener('load', function () { clearTimeout(failTimer); });
        img.addEventListener('error', function () {
          clearTimeout(failTimer);
          if (b.parentNode) b.parentNode.removeChild(b);
        });
        b.appendChild(img);
        b.addEventListener('click', function () {
          selectPick(b, src);
        });
        if (src === selectedSrc) b.classList.add('selected');
        iconPicker.appendChild(b);
        shown++;
      })(cands[i].src);
    }
  }

  function autoPickEl(selected) {
    var b = el('button', 'pick-item pick-auto' + (selected ? ' selected' : ''));
    b.type = 'button';
    b.dataset.src = '';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', selected ? 'true' : 'false');
    b.title = 'auto-detect icon';
    b.appendChild(el('span', 'pick-letter', 'auto'));
    b.addEventListener('click', function () { selectPick(b, ''); });
    return b;
  }

  function selectPick(btn, src) {
    pickedIcon = src;
    var sels = iconPicker.querySelectorAll('.pick-item.selected');
    for (var i = 0; i < sels.length; i++) {
      sels[i].classList.remove('selected');
      sels[i].setAttribute('aria-checked', 'false');
    }
    btn.classList.add('selected');
    btn.setAttribute('aria-checked', 'true');
  }

  /* ---- title auto-detect: fill the name field from the page ---- */

  /* metadata (title + icons) cached per url so re-opening the modal for the
     same site never refetches; icons found in the page's HTML feed the picker */
  var metaCache = Object.create(null);
  var metaIcons = Object.create(null);
  var META_MAX = 4 * 1024 * 1024; /* 4 MB cap on the page we read */

  function detectMeta(raw) {
    var url = normUrl(raw);
    if (!url || !/^https?:/i.test(url)) { metaStatus.hidden = true; return; }
    metaStatus.hidden = false;
    metaStatus.textContent = 'detecting title…';
    /* optimistic name from the hostname while the fetch is in flight */
    if (!nameIn.value.trim()) {
      lastAutoName = nameForUrl(url);
      nameIn.value = lastAutoName;
    }
    if (metaCache[url]) {
      metaStatus.hidden = true;
      applyMeta(url, metaCache[url]);
      return;
    }
    fetchMeta(url).then(function (meta) {
      metaStatus.hidden = true;
      if (!meta) return;
      metaCache[url] = meta;
      applyMeta(url, meta);
    }).catch(function () { metaStatus.hidden = true; });
  }

  function applyMeta(url, meta) {
    if (meta.title && (!nameIn.value.trim() || nameIn.value === lastAutoName)) {
      lastAutoName = meta.title;
      nameIn.value = meta.title;
    }
    if (meta.icons && meta.icons.length) {
      metaIcons[url] = meta.icons;
      renderIconPicker(url, pickedIcon);
    }
  }

  function fetchMeta(url) {
    /* direct fetch first — the extension's host permission bypasses CORS */
    return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
      .then(function (r) {
        if (!r.ok) return Promise.reject(new Error(String(r.status)));
        /* bail out of giant pages before reading the body */
        var len = parseInt(r.headers.get('content-length') || '0', 10);
        if (len > META_MAX) return Promise.reject(new Error('too big'));
        return r.text();
      })
      .then(function (html) {
        if (html.length > META_MAX) return Promise.reject(new Error('too big'));
        return parseMetaHtml(url, html);
      })
      /* then the sync worker's /meta route as the CORS-safe fallback */
      .catch(function () {
        return fetch(String(CF.worker || CF.endpoint || '').replace(/\/+$/, '') + '/meta?url=' + encodeURIComponent(url), { signal: AbortSignal.timeout(8000) })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      });
  }

  function parseMetaHtml(baseUrl, html) {
    var clean = function (s) {
      return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    };
    var og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html);
    var tw = /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)/i.exec(html);
    var tl = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    var title = clean((og && og[1]) || (tw && tw[1]) || (tl && tl[1]));
    var icons = [];
    var seen = {};
    try {
      var base = new URL(baseUrl);
      var linkRe = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi;
      var m;
      while ((m = linkRe.exec(html)) && icons.length < 8) {
        var href = /href=["']([^"']+)["']/i.exec(m[0]);
        if (!href || !href[1]) continue;
        var abs;
        try { abs = new URL(href[1], base).href; } catch (e) { continue; }
        if (!/^https?:/i.test(abs) || seen[abs]) continue;
        seen[abs] = 1;
        icons.push(abs);
      }
    } catch (e) { /* keep whatever we have */ }
    return { title: title, icons: icons };
  }

  /* ---------------------------------------------------------------- command bar */

  function openBar() {
    mode = 'bar';
    bar.hidden = false;
    barInput.value = '';
    barInput.focus();
  }

  function closeBar() {
    bar.hidden = true;
    mode = 'none';
  }

  bar.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = barInput.value.trim();
    closeBar();
    if (q) openCommand(q);
  });

  /* paste an image (or image URL) into the bar to reverse-search it */
  barInput.addEventListener('paste', function (e) {
    var cd = e.clipboardData;
    if (!cd) return;
    var file = null;
    var items = cd.items;
    for (var i = 0; items && i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        file = items[i].getAsFile && items[i].getAsFile();
        break;
      }
    }
    if (file) {
      e.preventDefault();
      closeBar();
      searchImageFile(file);
      return;
    }
    var text = cd.getData('text') || '';
    if (/^https?:\/\/[^\s]+\.(jpe?g|png|gif|webp|avif|bmp|svg|ico)(\?[^\s]*)?$/i.test(text.trim())) {
      e.preventDefault();
      closeBar();
      searchImageUrl(text.trim());
    }
  });

  function searchImageUrl(url) {
    window.open('https://www.google.com/searchbyimage?image_url=' + encodeURIComponent(url), '_blank');
  }

  function searchImageFile(file) {
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = 'https://www.google.com/searchbyimage/upload';
    form.enctype = 'multipart/form-data';
    form.target = '_blank';
    form.style.display = 'none';
    var input = document.createElement('input');
    input.type = 'file';
    input.name = 'encoded_image';
    var dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }

  function openCommand(q) {
    var lower = q.toLowerCase();
    var i;
    for (i = 0; i < state.sites.length; i++) {
      if (state.sites[i].name.toLowerCase() === lower) { open(i); return; }
    }
    for (i = 0; i < state.sites.length; i++) {
      if (state.sites[i].name.toLowerCase().indexOf(lower) !== -1) { open(i); return; }
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(q) || /\.[a-z]{2,}/i.test(q)) {
      var u = normUrl(q);
      if (u) location.assign(u);
      return;
    }
    location.assign('https://www.google.com/search?q=' + encodeURIComponent(q));
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = nameIn.value.trim();
    var url = normUrl(urlIn.value);
    if (!url) return;
    /* never block on the async title fetch — fall back to the hostname */
    if (!name) name = nameForUrl(url);
    if (editingIdx >= 0) {
      var s = state.sites[editingIdx];
      var oldUrl = s.url;
      var oldIcon = s.icon || '';
      /* the favicon cache is keyed by url — a changed url or icon must
         invalidate all three layers (in-memory element cache, in-flight
         guard, and the persisted winner) so the tile re-resolves with the
         picked icon before the re-render */
      if (url !== oldUrl) { delete faviconCache[oldUrl]; delete iconLoading[oldUrl]; delete persistedIcons[oldUrl]; }
      if (pickedIcon !== oldIcon) { delete faviconCache[url]; delete iconLoading[url]; delete persistedIcons[url]; }
      mutateSite(function () {
        s.name = name;
        s.url = url;
        if (pickedIcon) s.icon = pickedIcon;
        else delete s.icon;
      });
      focused = editingIdx;
    } else {
      state.sites.push({ id: uid(), name: name, url: url, icon: pickedIcon || undefined });
      /* a re-added url must not inherit an old persisted icon */
      if (pickedIcon) { delete faviconCache[url]; delete iconLoading[url]; delete persistedIcons[url]; }
      focused = state.sites.length - 1;
      mutateSite(function () {});
    }
    closeModal();
    renderTileStates();
  });

  $('#modalCancel').addEventListener('click', closeModal);

  /* ------------------------------------------------------------------ drawer */

  function toggleDrawer() {
    var open = !drawer.classList.contains('open');
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    scrim.hidden = !open;
    mode = open ? 'drawer' : 'none';
    if (open) {
      drawerBody.scrollTop = 0;
      syncSetNav();
      syncDrawerDisplay();
    }
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    scrim.hidden = true;
    mode = 'none';
  }

  /* ---- settings section jump-nav: clicking a chip scrolls to its group,
        scrolling highlights the group currently in view ---- */

  var setNav = $('#setNav');
  var setGroups = Array.prototype.slice.call(document.querySelectorAll('.set-group'));

  function syncSetNav() {
    if (!setNav || !setGroups.length) return;
    var bodyTop = drawerBody.getBoundingClientRect().top;
    var current = setGroups[0].id.replace('grp-', '');
    for (var g = 0; g < setGroups.length; g++) {
      if (setGroups[g].getBoundingClientRect().top - bodyTop <= 24) current = setGroups[g].id.replace('grp-', '');
    }
    var btns = setNav.querySelectorAll('.set-nav-btn');
    for (var b = 0; b < btns.length; b++) {
      var on = btns[b].getAttribute('data-scroll') === current;
      btns[b].classList.toggle('active', on);
      if (on) btns[b].setAttribute('aria-current', 'true');
      else btns[b].removeAttribute('aria-current');
    }
  }
  if (setNav) setNav.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.set-nav-btn');
    if (!b) return;
    var t = document.getElementById('grp-' + b.getAttribute('data-scroll'));
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  drawerBody.addEventListener('scroll', syncSetNav);

  settingsBtn.addEventListener('click', toggleDrawer);
  drawerClose.addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);

  function syncDrawerDisplay() {
    var s = state.settings;
    setRangeVal('iconSize', s.iconSize);
    setRangeVal('colGap', s.colGap);
    setRangeVal('rowGap', s.rowGap);
    setRangeVal('cols', s.cols);
    setRangeVal('rows', s.rows);
    setRangeVal('bkWidth', s.bkWidth);
    setRangeVal('drWidth', s.drWidth);
    setRangeVal('blur', s.blur);
    setRangeVal('labelOp', s.labelOp);
    var lc = $('#set-labelColor');
    if (lc && lc.value !== s.labelColor) lc.value = s.labelColor;
    var lcv = $('#val-labelColor');
    if (lcv) lcv.textContent = s.labelColor;
    var lbl = $('#set-labels');
    if (lbl.checked !== s.labels) lbl.checked = s.labels;
    var mono = $('#set-mono');
    if (mono.checked !== s.mono) mono.checked = s.mono;
    var wallMono = $('#set-wallMono');
    if (wallMono && wallMono.checked !== s.wallMono) wallMono.checked = s.wallMono;
  }

  function setRangeVal(key, v) {
    var inp = $('#set-' + key), out = $('#val-' + key);
    if (inp) inp.value = v;
    if (out) out.textContent = v + (inp && inp.getAttribute('data-unit') ? inp.getAttribute('data-unit') : '');
  }

  /* live settings edits: apply cheap CSS-only updates on every input, then
     debounce the heavy full commit (re-render + JSON.stringify + cloud push)
     until the slider settles. Only cols/rows (grid capacity) rebuild the grid. */
  function applySetting(k, v) {
    var prevCap = cellCapacity();
    state.settings[k] = v;
    setRangeVal(k, v);
    applyCssVars();
    if (cellCapacity() !== prevCap) {
      clampPage();
      if (state.sites.length === 0) focused = -1;
      else {
        if (focused < pageStart()) focused = pageStart();
        if (focused > pageEnd()) focused = pageEnd();
      }
      renderGrid();
      renderTileStates();
    } else {
      renderTileStates();
    }
    clearTimeout(settingTimer);
    settingTimer = setTimeout(function () { commit({ noRender: true }); }, 250);
  }

  ['iconSize', 'colGap', 'rowGap', 'cols', 'rows', 'bkWidth', 'drWidth', 'blur', 'labelOp'].forEach(function (k) {
    var inp = $('#set-' + k);
    inp.addEventListener('input', function (e) {
      applySetting(k, parseInt(e.target.value, 10));
    });
    /* slider released — flush the pending commit immediately (the live
       updates already rendered, so skip the rebuild) */
    inp.addEventListener('change', function () {
      clearTimeout(settingTimer);
      commit({ noRender: true });
    });
  });

  drawerBody.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.step');
    if (!b) return;
    var key = b.getAttribute('data-target');
    var d = parseInt(b.getAttribute('data-step'), 10);
    var inp = $('#set-' + key);
    if (!inp) return;
    var v = Math.max(parseInt(inp.min, 10), Math.min(parseInt(inp.max, 10),
      parseInt(inp.value, 10) + d));
    applySetting(key, v);
  });

  $('#set-labels').addEventListener('change', function (e) {
    state.settings.labels = e.target.checked;
    commit();
  });

  $('#set-wallMono').addEventListener('change', function (e) {
    state.settings.wallMono = e.target.checked;
    commit();
  });

  $('#set-mono').addEventListener('change', function (e) {
    state.settings.mono = e.target.checked;
    commit();
  });

  $('#set-labelColor').addEventListener('input', function (e) {
    applySetting('labelColor', e.target.value);
  });

  $('#labelColorReset').addEventListener('click', function () {
    applySetting('labelColor', DEFAULTS.settings.labelColor);
  });

  resetSettings.addEventListener('click', function () {
    state.settings = Object.assign({}, DEFAULTS.settings);
    mutateSite(function () {});
    syncDrawerDisplay();
  });

  emptyAdd.addEventListener('click', function () { openModal(null); });

  syncNow.addEventListener('click', pushCloud);

  /* one-click JSON download of the whole save — the standing insurance
     against any future wipe/clobber. Keep a copy somewhere outside the
     browser (drive, repo, notes) and you can always rebuild. */
  $('#backupDownload').addEventListener('click', function () {
    var d = doc();
    var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'glisters-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 2000);
  });

  /* undo the last cloud adoption — restores the doc that was current before
     the previous adoptRemote(). */
  $('#restorePrevious').addEventListener('click', function () {
    readPrevious(function (raw) {
      if (!raw) { setSyncStatus('error', 'no previous save to restore'); return; }
      var obj = null;
      try { obj = JSON.parse(raw); } catch (e) { /* unreadable */ }
      if (!obj) { setSyncStatus('error', 'previous save unreadable'); return; }
      state = normalize(obj) || state;
      seededFromLinks = false;
      clearSeedFlag();
      renderAll();
      persistLocal();
      if (window.BOOKMARKS) window.BOOKMARKS.restore(state.bookmarks);
      if (window.WALLS) window.WALLS.restore(state.walls);
      /* scheduleCloud() overwrites the pill with 'syncing…', so show the
         confirmation first, then sync */
      scheduleCloud();
      setSyncStatus('synced', 'restored previous save');
    });
  });

  /* ------------------------------------------------------------------ sync */

  function setSyncStatus(kind, text) {
    var dot = $('#syncDot'), st = $('#syncStatus'), pill = $('#syncPill');
    if (dot) dot.className = 'sync-dot ' + kind;
    if (st) st.textContent = text || '';
    if (pill) pill.className = 'sync-pill ' + kind;
  }

  /* scheduleCloud marks changes as un-synced and tries to push shortly after
     the last edit. localStorage persists immediately either way — cloud is a
     mirror that re-syncs the moment connectivity returns. */
  function scheduleCloud() {
    if (!SYNC_ENABLED) return;
    dirty = true;
    clearTimeout(cloudTimer);
    clearTimeout(retryTimer);
    setSyncStatus('syncing', 'syncing…');
    cloudTimer = setTimeout(pushCloud, 1300);
  }

  /* every adoption replaces local state — keep the outgoing doc under its
     own key first so a wrong adoption is undoable (settings → backup →
     restore previous). Mirrored to chrome.storage so it survives reloads. */
  function stashPrevious(d) {
    try { localStorage.setItem(STORE_KEY + '-previous', JSON.stringify(d)); } catch (e) { /* quota */ }
    if (window.chrome && chrome.storage && chrome.storage.local) {
      try {
        var o = {};
        o[STORE_KEY + '-previous'] = d;
        chrome.storage.local.set(o);
      } catch (e) { /* noop */ }
    }
  }

  /* --- persisted seed flag: survives reloads so a wiped install that seeded
         from links.txt can never be mistaken for real local data again --- */

  function persistSeedFlag() {
    try { localStorage.setItem(SEED_FLAG_KEY, '1'); } catch (e) { /* quota */ }
    if (window.chrome && chrome.storage && chrome.storage.local) {
      try {
        var o = {};
        o[SEED_FLAG_KEY] = 1;
        chrome.storage.local.set(o);
      } catch (e) { /* noop */ }
    }
  }

  function clearSeedFlag() {
    try { localStorage.removeItem(SEED_FLAG_KEY); } catch (e) { /* noop */ }
    if (window.chrome && chrome.storage && chrome.storage.local) {
      try { chrome.storage.local.remove(SEED_FLAG_KEY); } catch (e) { /* noop */ }
    }
  }

  function readSeedFlag() {
    try { if (localStorage.getItem(SEED_FLAG_KEY) === '1') return true; } catch (e) { /* noop */ }
    return false;
  }

  function readPrevious(cb) {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY + '-previous'); } catch (e) { /* noop */ }
    if (raw) { cb(raw); return; }
    if (window.chrome && chrome.storage && chrome.storage.local) {
      try {
        chrome.storage.local.get(STORE_KEY + '-previous', function (o) {
          cb((o && o[STORE_KEY + '-previous']) || null);
        });
        return;
      } catch (e) { /* fall through */ }
    }
    cb(null);
  }

  /* adopt a cloud save: replace local state with the remote doc and hand the
     slices to the sidebar + wallpapers. Called when the cloud is newer
     (conflict / another tab or device wrote since). */
  function adoptRemote(remote) {
    stashPrevious(doc());
    state = normalize(remote);
    seededFromLinks = false;
    clearSeedFlag();
    dirty = false;
    renderAll();
    persistLocal();
    if (window.BOOKMARKS) window.BOOKMARKS.restore(state.bookmarks);
    if (window.WALLS) window.WALLS.restore(state.walls);
    setSyncStatus('synced', 'synced');
  }

  function pushCloud() {
    if (!SYNC_ENABLED) { setSyncStatus('off', 'cloud off'); return Promise.resolve(false); }
    setSyncStatus('syncing', 'syncing…');
    return window.SYNC.push(doc(), seededFromLinks).then(function (r) {
      if (r && r.conflict) {
        /* the worker rejected the push — a newer save exists. Pull it and
           adopt so the newer changes win instead of being clobbered (the
           pill would otherwise still claim 'synced' after overwriting). */
        return window.SYNC.pull().then(function (remote) {
          if (remote && remote.version === SEED_VERSION) adoptRemote(remote);
          else {
            dirty = false;
            clearTimeout(retryTimer);
            setSyncStatus('synced', 'synced');
          }
          return true;
        }).catch(function () {
          dirty = true;
          setSyncStatus('error', 'conflict — will retry');
          clearTimeout(retryTimer);
          retryTimer = setTimeout(pushCloud, 20000);
          return false;
        });
      }
      /* the doc made it to the cloud — it is no longer a tentative seed */
      seededFromLinks = false;
      clearSeedFlag();
      dirty = false;
      clearTimeout(retryTimer);
      setSyncStatus('synced', 'synced');
      return true;
    }).catch(function () {
      dirty = true;
      setSyncStatus('error', 'offline — will retry');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(pushCloud, 20000);
      return false;
    });
  }

  window.addEventListener('online', function () {
    if (seededFromLinks) syncStart(); /* retry the fresh-install restore */
    else if (dirty) pushCloud();
    retryAllFailed();
  });

  window.addEventListener('pagehide', function () {
    if (!SYNC_ENABLED || !dirty) return;
    window.SYNC.push(doc(), seededFromLinks).catch(function () { /* local copy survives regardless */ });
  });

  /* visible probe for the settings drawer: proves whether local + extension
     storage actually survive a reload, and shows the pinned extension id so a
     churning id (which orphans all storage) is obvious. */
  function storageProbe() {
    var idEl = $('#stId'), lsEl = $('#stLocal'), extEl = $('#stExt');
    if (!idEl || !lsEl || !extEl) return;
    var id = (window.chrome && chrome.runtime && chrome.runtime.id) || 'unknown';
    idEl.textContent = id.slice(0, 8) + '…';
    var ls = 'fail';
    try {
      localStorage.setItem('__probe__', '1');
      if (localStorage.getItem('__probe__') === '1') ls = 'ok';
      localStorage.removeItem('__probe__');
    } catch (e) { /* keep fail */ }
    lsEl.textContent = ls;
    lsEl.className = 'st-val ' + (ls === 'ok' ? 'ok' : 'bad');
    function setExt(ok, label) {
      extEl.textContent = label;
      extEl.className = 'st-val ' + (ok ? 'ok' : (label === 'n/a' ? 'na' : 'bad'));
    }
    if (window.chrome && chrome.storage && chrome.storage.local) {
      try {
        chrome.storage.local.set({ __probe__: 1 }, function () {
          chrome.storage.local.get('__probe__', function (o) {
            var ok = !!(o && o.__probe__ === 1);
            try { chrome.storage.local.remove('__probe__'); } catch (e) {}
            setExt(ok, ok ? 'ok' : 'fail');
          });
        });
      } catch (e) {
        setExt(false, 'fail');
      }
    } else {
      setExt(false, 'n/a');
    }
  }
  storageProbe();

  function syncStart() {
    if (!SYNC_ENABLED) { setSyncStatus('off', 'cloud off'); return; }
    setSyncStatus('syncing', 'fetching…');
    window.SYNC.pull().then(function (remote) {
      var hasRealLocal = !seededFromLinks && state.sites.length > 0;
      if (hasRealLocal) {
        if (!remote || remote.version !== SEED_VERSION) { pushCloud(); return; }
        /* the cloud is a mirror — but a NEWER save means someone else
           (another tab / device) changed it since our last sync. Adopt it
           instead of pushing our older copy over it (that was the silent
           data-loss path: 'synced' + reverted changes). */
        if (remote.updatedAt > state.updatedAt && !dirty) {
          adoptRemote(remote);
          return;
        }
        if (dirty || remote.updatedAt !== state.updatedAt) pushCloud();
        else setSyncStatus('synced', 'synced');
        return;
      }
      /* fresh install / wiped store — the cloud save is ALWAYS authoritative
         over the seed, even if it's empty (the user deliberately cleared it
         or a prior seed now lives there). A seed must never overwrite it. */
      if (remote && remote.version === SEED_VERSION) {
        adoptRemote(remote);
        setSyncStatus('synced', 'restored from cloud');
        return;
      }
      /* no cloud save at all — the seed becomes the first save. It is pushed
         flagged as a seed, so if anything appears on the cloud between the
         pull and the push, the worker refuses and we adopt instead. */
      setSyncStatus('ready', 'nothing on cloud yet');
      pushCloud();
    }).catch(function () {
      setSyncStatus('error', 'cloud unreachable');
      /* a fresh seed must never clobber the cloud copy on a failed pull */
      if (!seededFromLinks) pushCloud();
    });
  }

  /* ------------------------------------------------------------------ init */

  /* sync-read the persisted favicon winners before the first grid render so
     every tile starts from its saved icon instead of the candidate blast */
  loadPersistedIcons();

  renderAll();

  if (needSeed) {      restoreFromStorage().then(function (stored) {
        if (stored) {
          var proceed = function () {
            state = normalize(stored);
            renderAll();
            persistLocal();
            if (window.BOOKMARKS) window.BOOKMARKS.restore(state.bookmarks);
            if (window.WALLS) window.WALLS.restore(state.walls);
            syncStart();
          };
          /* localStorage may have been evicted while chrome.storage survived —
             pick the persisted seed flag up from there too before syncing. */
          if (window.chrome && chrome.storage && chrome.storage.local) {
            try {
              chrome.storage.local.get(SEED_FLAG_KEY, function (o) {
                seededFromLinks = seededFromLinks || !!(o && o[SEED_FLAG_KEY] === 1);
                proceed();
              });
              return;
            } catch (e) { /* fall through */ }
          }
          proceed();
          return;
        }
      loadLinks().then(function (links) {
        state.sites = links;
        state.updatedAt = Date.now();
        seededFromLinks = true;
        persistSeedFlag();
        renderAll();
        persistLocal();
        syncStart();
      }).catch(function () {
        state.updatedAt = Date.now();
        seededFromLinks = true;
        persistSeedFlag();
        renderAll();
        persistLocal();
        syncStart();
      });
    });
  } else {
    if (!readLocal()) persistLocal();
    syncStart();
  }

  /* hand the bookmarks sidebar our commit + its slice of the save file so
     bookmark edits hit the same doc and cloud sync as the grid. */
  if (window.BOOKMARKS) {
    window.BOOKMARKS.bind(commit);
    window.BOOKMARKS.restore(state.bookmarks);
  }
  if (window.WALLS) {
    window.WALLS.bind(commit);
    window.WALLS.restore(state.walls);
  }

  /* The page is served directly as the newtab override (no redirect), so
     Chrome keeps the address bar focused by default — the app never grabs
     focus; keys land in the page once the user clicks or tabs into it. */
})();