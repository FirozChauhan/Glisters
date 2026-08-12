/* ---------------------------------------------------------------------------
   GLISTERS — bookmarks sidebar
   A full bookmark manager on the left edge of the new tab page.

   - drill-down folders: opening a folder fills the panel, back (h / ←) and
     breadcrumbs return home; drag & drop reorder / move
   - keyboard-first:  b toggle · j/k move · enter or l open folder/link ·
     h or ← back · a add link · A add folder · e edit · d delete (arm) ·
     g/G first/last · esc close
   - import/export Netscape bookmark HTML (Chrome/Firefox compatible)
   - persists to its own localStorage + chrome.storage.local key, AND rides
     inside the shared save file (app.js doc()) so it syncs to Cloudflare R2

   Design note: this file is deliberately self-contained — it talks to app.js
   only through three guarded hooks (window.BOOKMARKS.bind / forDoc / restore),
   so it can't collide with other work on the grid.
--------------------------------------------------------------------------- */

(function () {
  'use strict';

  var LS_KEY = 'glisters-bk';       /* sidebar data  */
  var UI_KEY = 'glisters-bk-ui';    /* panel open state (local only) */

  /* ------------------------------------------------------------------ state */

  var STORE = {
    v: 1,
    updatedAt: 0,
    folders: [],   /* { id, name, parent, index } */
    items: [],     /* { id, name, url, parent, index } */
    deletedChromeIds: []  /* chrome bookmarks the user deleted locally — never re-import */
  };

  var ui = {
    open: false,
    folder: null,           /* currently open folder id; null = home (root) */
    focusedId: null,
    armedId: null,
    armTimer: null,
    editor: null,   /* { parent, type: 'link'|'folder', node } — null when closed */
    visible: []     /* cached flat list for the current view from last render() */
  };

  var appCommit = null;     /* app.js commit() — writes the shared doc + cloud */
  var faviconCache = Object.create(null);
  var ignoreOutsideClick = false; /* set while the link-open fallback synthesizes a click */

  /* ------------------------------------------------------------------ utils */

  function $(s) { return document.querySelector(s); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function isTyping(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' || t.isContentEditable);
  }
  function isVisible(sel) {
    var n = $(sel);
    return !!n && !n.hidden && n.getAttribute('aria-hidden') !== 'true' &&
      getComputedStyle(n).display !== 'none';
  }

  /* ------------------------------------------------------------------ dom refs */

  var root = $('#bk'), tree = $('#bkTree'),
      closeBtn = $('#bkClose'), toggleBtn = $('#bkToggle'), chromeBtn = $('#bkChrome'),
      backBtn = $('#bkBack'), crumbsEl = $('#bkCrumbs'),
      emptyEl = $('#bkEmpty'),
      emptyAddBtn = emptyEl ? emptyEl.querySelector('.bk-empty-add') : null;

  if (!root || !tree) return; /* markup missing — never break the page */

  /* ------------------------------------------------------- persistence */

  function dataDoc() {
    return {
      v: STORE.v,
      updatedAt: STORE.updatedAt,
      folders: STORE.folders,
      items: STORE.items,
      deletedChromeIds: STORE.deletedChromeIds
    };
  }
  function readLS(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
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
  function saveUI() {
    try { localStorage.setItem(UI_KEY, JSON.stringify({ open: ui.open })); } catch (e) {}
  }
  function touch() {
    STORE.updatedAt = Date.now();
    persistData();
    saveUI();
    if (appCommit) appCommit();
  }

  /* sanitize a node so a corrupt cloud copy can't crash the renderer */
  function cleanFolder(f, i) {
    return {
      id: f && f.id ? String(f.id) : uid(),
      chromeId: f && f.chromeId ? String(f.chromeId) : undefined,
      name: String((f && f.name) != null ? f.name : ''),
      parent: f && f.parent != null ? String(f.parent) : null,
      index: f && typeof f.index === 'number' ? f.index : i
    };
  }
  function cleanItem(it, i) {
    return {
      id: it && it.id ? String(it.id) : uid(),
      chromeId: it && it.chromeId ? String(it.chromeId) : undefined,
      name: String((it && it.name) != null ? it.name : ''),
      url: String((it && it.url) != null ? it.url : ''),
      parent: it && it.parent != null ? String(it.parent) : null,
      index: it && typeof it.index === 'number' ? it.index : i
    };
  }
  function setData(bm) {
    STORE.v = bm && bm.v || 1;
    STORE.updatedAt = bm && typeof bm.updatedAt === 'number' ? bm.updatedAt : 0;
    /* tombstones are monotonic: once a chrome node is deleted here it must
       stay deleted forever, no matter which copy of the doc wins. Union the
       incoming set with what we already have — a stale/empty mirror can
       never resurrect something that was deleted. */
    var inc = (bm && Array.isArray(bm.deletedChromeIds) ? bm.deletedChromeIds : [])
      .filter(function (x) { return x != null && String(x); })
      .map(function (x) { return String(x); });
    inc.forEach(function (id) {
      if (STORE.deletedChromeIds.indexOf(id) === -1) STORE.deletedChromeIds.push(id);
    });
    STORE.folders = (bm && Array.isArray(bm.folders) ? bm.folders : [])
      .filter(function (f) { return f && typeof f === 'object'; })
      .map(cleanFolder);
    STORE.items = (bm && Array.isArray(bm.items) ? bm.items : [])
      .filter(function (it) { return it && typeof it === 'object' && it.url; })
      .map(cleanItem);
  }
  /* drop any nodes whose chrome id is tombstoned. Heals zombie imports a
     buggy/older boot persisted before the durable tombstones were known —
     deletions made here must stick forever, no matter which copy won. */
  function purgeTombstoned() {
    var doomed = {};
    STORE.folders.forEach(function (f) {
      if (f.chromeId && STORE.deletedChromeIds.indexOf(f.chromeId) !== -1) {
        collectIds(f.id).forEach(function (id) { doomed[id] = true; });
      }
    });
    STORE.items.forEach(function (it) {
      if (it.chromeId && STORE.deletedChromeIds.indexOf(it.chromeId) !== -1) doomed[it.id] = true;
    });
    if (!Object.keys(doomed).length) return false;
    STORE.folders = STORE.folders.filter(function (f) { return !doomed[f.id]; });
    STORE.items = STORE.items.filter(function (it) { return !doomed[it.id]; });
    return true;
  }
  function adopt(bm) {
    /* the sidebar's own persisted store is authoritative when it is newer
       than the incoming mirror (the shared app doc can lag behind — e.g. a
       commit that ran before this page's edits flushed, or a stale cloud
       copy). Never let a stale/empty slice wipe out local deletions: keep
       the local state and union the incoming tombstones so nothing deleted
       here can ever be resurrected by an older mirror. */
    var incomingAt = bm && typeof bm.updatedAt === 'number' ? bm.updatedAt : 0;
    var changed = false;
    if (STORE.updatedAt > incomingAt) {
      /* local copy is newer — keep it, but never lose the incoming deletions */
      var before = STORE.deletedChromeIds.length;
      if (bm && Array.isArray(bm.deletedChromeIds)) {
        bm.deletedChromeIds.forEach(function (id) {
          id = String(id);
          if (STORE.deletedChromeIds.indexOf(id) === -1) STORE.deletedChromeIds.push(id);
        });
      }
      if (STORE.deletedChromeIds.length !== before) changed = true;
    } else {
      setData(bm);
      changed = true;
    }
    /* once the tombstones are known, remove any zombie nodes they cover */
    if (purgeTombstoned()) changed = true;
    if (changed) {
      persistData();
      render();
    }
    /* after adopting (boot restore / cloud pull) re-pull chrome bookmarks so
       they always reconcile with the doc, whatever order boot settled in */
    mergeChromeTree();
  }

  /* --- public API used by app.js (all guarded there) --- */

  window.BOOKMARKS = {
    bind: function (cb) { appCommit = cb; },
    forDoc: function () { return dataDoc(); },
    restore: function (bm) {
      if (!bm || typeof bm !== 'object' || !Array.isArray(bm.folders) || !Array.isArray(bm.items)) return;
      adopt(bm);
    },
    /* also exposed so tests / other code can trigger a pull */
    refreshFromChrome: function () { return mergeChromeTree(); }
  };

  /* ------------------------------------------------------- tree helpers */

  function parentKey(p) { return p == null ? '__root__' : p; }
  function findFolder(id) {
    for (var i = 0; i < STORE.folders.length; i++) if (STORE.folders[i].id === id) return STORE.folders[i];
    return null;
  }
  function findItem(id) {
    for (var i = 0; i < STORE.items.length; i++) if (STORE.items[i].id === id) return STORE.items[i];
    return null;
  }
  function findNode(id) {
    var f = findFolder(id);
    if (f) return { type: 'folder', node: f };
    var it = findItem(id);
    if (it) return { type: 'link', node: it };
    return null;
  }
  function childrenOf(parent) {
    var p = parentKey(parent);
    var out = [];
    for (var i = 0; i < STORE.folders.length; i++) {
      if (parentKey(STORE.folders[i].parent) === p) out.push({ type: 'folder', node: STORE.folders[i] });
    }
    for (var j = 0; j < STORE.items.length; j++) {
      if (parentKey(STORE.items[j].parent) === p) out.push({ type: 'link', node: STORE.items[j] });
    }
    out.sort(function (a, b) { return a.node.index - b.node.index; });
    return out;
  }
  function reindex(parent) {
    var kids = childrenOf(parent);
    for (var i = 0; i < kids.length; i++) kids[i].node.index = i;
  }
  function folderPath(parent) {
    var names = [], cur = parent, guard = 0;
    while (cur && guard++ < 50) {
      var f = findFolder(cur);
      if (!f) break;
      names.unshift(f.name);
      cur = f.parent;
    }
    return names;
  }
  function isDescendant(maybeChild, ancestor) {
    var cur = maybeChild, guard = 0;
    while (cur && guard++ < 100) {
      if (cur === ancestor) return true;
      var n = findNode(cur);
      cur = n ? n.node.parent : null;
    }
    return false;
  }
  function collectIds(folderId) {
    var ids = [folderId];
    childrenOf(folderId).forEach(function (c) {
      if (c.type === 'folder') ids = ids.concat(collectIds(c.node.id));
      else ids.push(c.node.id);
    });
    return ids;
  }

  function visibleNodes() {
    var out = [];
    /* drill-down: the open folder's direct children fill the panel */
    childrenOf(ui.folder).forEach(function (c) {
      out.push({ type: c.type, node: c.node, depth: 0 });
    });
    return out;
  }

  /* ------------------------------------------------------- favicons */

  function initials(name) {
    var w = String(name).trim().split(/\s+/).filter(Boolean);
    return (w.slice(0, 2).map(function (x) { return x[0]; }).join('') || '?').toUpperCase();
  }
  /* same official-icon resolution as the grid (app.js): Google products
     share hosts (google.com/maps, docs.google.com/spreadsheets…) whose
     own favicon.ico is the generic search "G", so map host + path to the
     product icon directly. 2x gstatic logos are 128px — sharp at any size.
     Kept here so this file stays self-contained. */
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
  function faviconCands(url) {
    var h;
    try { h = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return []; }
    var cands = [];
    var first = officialIcon(url);
    if (first) cands.push(first);
    /* site's own hi-res icon first, then the small authoritative favicon,
       then the re-render services (which cap at native size) */
    cands.push(
      'https://' + h + '/apple-touch-icon.png',
      'https://' + h + '/favicon.ico',
      'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(h) + '&sz=64',
      'https://icons.duckduckgo.com/ip3/' + encodeURIComponent(h) + '.ico'
    );
    return cands;
  }
  /* winning favicon src per url, persisted across sessions (same map and key
     as the grid — localStorage for instant boots + chrome.storage for
     durability). Repeat opens resolve icons with one cache-hit request
     instead of the 4-candidate blast; stale entries self-heal. */
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

  function loadFavicon(ic, node) {
    var letter = ic.querySelector('.bk-letter');
    var cached = faviconCache[node.url];
    if (cached) { setImg(ic, cached, letter); return; }
    var cands = faviconCands(node.url);
    if (persistedIcons[node.url]) cands.unshift(persistedIcons[node.url]);
    var done = false;
    for (var i = 0; i < cands.length; i++) {
      (function (src) {
        var img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';
        img.addEventListener('load', function () {
          if (done || img.naturalWidth < 16 || img.naturalHeight < 16) return;
          done = true;
          faviconCache[node.url] = src;
          persistIcon(node.url, src);
          var olds = ic.querySelectorAll('img');
          for (var k = 0; k < olds.length; k++) ic.removeChild(olds[k]);
          if (letter) letter.style.display = 'none';
          ic.appendChild(img);
        });
        ic.appendChild(img);
      })(cands[i]);
    }
  }
  function setImg(ic, src, letter) {
    var img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    if (letter) letter.style.display = 'none';
    ic.appendChild(img);
  }

  /* ------------------------------------------------------- render */

  var FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  var EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>';
  var DEL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';

  function rowEl(v, depth) {
    var node = v.node;
    var isFolder = v.type === 'folder';
    var r = el('div', 'bk-row ' + (isFolder ? 'folder' : 'link'));
    r.dataset.id = node.id;
    r.dataset.type = v.type;
    r.draggable = true;
    r.style.paddingLeft = (10 + depth * 16) + 'px';
    r.setAttribute('role', 'treeitem');
    r.setAttribute('aria-level', String(depth + 1));

    if (isFolder) {
      var tw = el('span', 'bk-twist', '\u25b8');
      tw.setAttribute('aria-hidden', 'true');
      r.appendChild(tw);
      var fic = el('span', 'bk-icon bk-folder');
      fic.innerHTML = FOLDER_SVG;
      r.appendChild(fic);
    } else {
      r.appendChild(el('span', 'bk-twist', ''));
      var ic = el('span', 'bk-icon');
      ic.appendChild(el('span', 'bk-letter', initials(node.name)));
      r.appendChild(ic);
      loadFavicon(ic, node);
    }

    r.appendChild(el('span', 'bk-name', node.name));

    var ctx = el('span', 'bk-ctx');
    var eb = el('button', 'bk-ctx-btn bk-ctx-edit');
    eb.type = 'button';
    eb.title = 'edit';
    eb.setAttribute('aria-label', 'edit ' + node.name);
    eb.innerHTML = EDIT_SVG;
    eb.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openEditor(node.parent, v.type, node);
    });
    var db = el('button', 'bk-ctx-btn bk-ctx-del');
    db.type = 'button';
    db.title = 'delete';
    db.setAttribute('aria-label', 'delete ' + node.name);
    db.innerHTML = DEL_SVG;
    db.addEventListener('click', function (ev) {
      ev.stopPropagation();
      armOrDelete(node.id);
    });
    ctx.appendChild(eb);
    ctx.appendChild(db);
    r.appendChild(ctx);
    return r;
  }

  /* breadcrumb navigation: home / folder / subfolder */
  function crumbEl(label, folderId, current) {
    var c = el('button', 'bk-crumb' + (current ? ' current' : ''));
    c.type = 'button';
    c.textContent = label;
    if (!current) {
      c.addEventListener('click', function () { openFolder(folderId); });
    }
    return c;
  }
  function renderCrumbs(ids) {
    crumbsEl.innerHTML = '';
    crumbsEl.appendChild(crumbEl('home', null, ids.length === 0));
    for (var i = 0; i < ids.length; i++) {
      var f = findFolder(ids[i]);
      if (!f) continue;
      crumbsEl.appendChild(el('span', 'bk-crumb-sep', '/'));
      crumbsEl.appendChild(crumbEl(f.name, f.id, i === ids.length - 1));
    }
  }

  function editorEl() {
    var ed = ui.editor;
    var form = el('form', 'bk-editor');
    var nf = el('label', 'bk-field');
    nf.appendChild(el('span', '', 'name'));
    var ni = el('input', 'bk-en');
    ni.type = 'text';
    ni.autocomplete = 'off';
    ni.spellcheck = false;
    ni.placeholder = ed.type === 'folder' ? 'folder name' : 'name';
    ni.value = ed.node ? ed.node.name : '';
    nf.appendChild(ni);
    form.appendChild(nf);

    if (ed.type === 'link') {
      var uf = el('label', 'bk-field');
      uf.appendChild(el('span', '', 'url'));
      var uin = el('input', 'bk-ur');
      uin.type = 'text';
      uin.autocomplete = 'off';
      uin.spellcheck = false;
      uin.placeholder = 'example.com';
      uin.value = ed.node ? ed.node.url : '';
      uf.appendChild(uin);
      form.appendChild(uf);
    }

    var acts = el('div', 'bk-editor-actions');
    var cancel = el('button', 'bk-btn', 'cancel');
    cancel.type = 'button';
    var save = el('button', 'bk-btn', 'save');
    save.type = 'submit';
    acts.appendChild(cancel);
    acts.appendChild(save);
    form.appendChild(acts);

    cancel.addEventListener('click', cancelEditor);
    form.addEventListener('submit', function (e) { e.preventDefault(); saveEditor(form); });
    return form;
  }

  function render() {
    ui.visible = visibleNodes();

    var focusId = ui.focusedId, hasFocus = false;
    for (var i = 0; i < ui.visible.length; i++) {
      if (ui.visible[i].node.id === focusId) { hasFocus = true; break; }
    }
    if (!hasFocus) focusId = ui.visible.length ? ui.visible[0].node.id : null;
    ui.focusedId = focusId;

    tree.innerHTML = '';
    if (ui.editor) tree.appendChild(editorEl());
    for (i = 0; i < ui.visible.length; i++) {
      var v = ui.visible[i];
      var r = rowEl(v, v.depth);
      if (v.node.id === focusId) r.classList.add('focused');
      if (v.node.id === ui.armedId) r.classList.add('armed');
      tree.appendChild(r);
    }

    var hasRows = ui.visible.length > 0;
    if (emptyEl) {
      emptyEl.style.display = (!hasRows && !ui.editor) ? 'flex' : 'none';
      var t1 = emptyEl.querySelector('.bk-empty-title');
      var t2 = emptyEl.querySelector('.bk-empty-sub');
      if (t1) t1.textContent = ui.folder ? 'no bookmarks here' : 'no bookmarks yet';
      if (t2) t2.textContent = 'press a to add your first link';
    }
    if (backBtn) backBtn.classList.toggle('disabled', ui.folder == null);
    if (crumbsEl) renderCrumbs(folderPathIds(ui.folder));

    if (ui.editor) {
      var nameInp = tree.querySelector('.bk-en');
      if (nameInp) nameInp.focus();
    }
  }

  /* ------------------------------------------------------- focus */

  function updateArmed() {
    var rows = tree.querySelectorAll('.bk-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('armed', rows[i].dataset.id === ui.armedId);
    }
  }
  function disarm() {
    if (ui.armedId == null && ui.armTimer == null) return;
    ui.armedId = null;
    clearTimeout(ui.armTimer);
    ui.armTimer = null;
    updateArmed();
  }
  function setFocused(id) {
    ui.focusedId = id;
    disarm();
    var rows = tree.querySelectorAll('.bk-row');
    for (var i = 0; i < rows.length; i++) {
      var f = rows[i].dataset.id === id;
      rows[i].classList.toggle('focused', f);
      if (f) { try { rows[i].scrollIntoView({ block: 'nearest' }); } catch (e) {} }
    }
  }
  function moveFocus(d) {
    var n = ui.visible.length;
    if (!n) return;
    var cur = -1;
    for (var i = 0; i < n; i++) if (ui.visible[i].node.id === ui.focusedId) { cur = i; break; }
    var ni = cur < 0 ? (d > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, cur + d));
    setFocused(ui.visible[ni].node.id);
  }
  function visibleFocused() {
    if (!ui.focusedId) return null;
    for (var i = 0; i < ui.visible.length; i++) {
      if (ui.visible[i].node.id === ui.focusedId) return ui.visible[i];
    }
    return null;
  }
  function focusFirst() {
    if (ui.visible.length) setFocused(ui.visible[0].node.id);
  }
  function focusLast() {
    if (ui.visible.length) setFocused(ui.visible[ui.visible.length - 1].node.id);
  }

  /* ------------------------------------------------------- actions */

  function normUrl(url) {
    var u = String(url).trim();
    if (!u) return '';
    /* only web / mail links are ever opened (blocks javascript:/data:/file:…
       from a tampered save file or malicious bookmark title) */
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return 'https://' + u;
    var scheme = u.slice(0, u.indexOf(':')).toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return u;
    return '';
  }
  function openInNewTab(url) {
    if (!url) return;
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      /* active:false opens the tab in the background so the new-tab page
         stays in view and keeps focus */
      try { chrome.tabs.create({ url: url, active: false }); return; } catch (e) { /* fall through */ }
    }
    /* never navigate the newtab page itself — the link opens elsewhere and
       this page stays in view. NB: window.open with 'noopener' returns null
       per spec, so the old location.assign fallback always fired. */
    try {
      var w = window.open(url, '_blank');
      if (w) return;
    } catch (e) { /* fall through */ }
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    (document.body || document.documentElement).appendChild(a);
    /* the synthetic click bubbles from document.body; ignore it so the
       outside-click-to-close handler doesn't treat it as an outside click */
    ignoreOutsideClick = true;
    try { a.click(); } finally { ignoreOutsideClick = false; }
    a.remove();
  }

  /* ---- drill-down navigation ---- */

  function folderPathIds(folderId) {
    var ids = [], cur = folderId, guard = 0;
    while (cur && guard++ < 50) {
      var f = findFolder(cur);
      if (!f) break;
      ids.unshift(f.id);
      cur = f.parent;
    }
    return ids;
  }
  function openFolder(id) {
    if (id != null && !findFolder(id)) return;
    ui.folder = id;
    ui.focusedId = null;
    render();
  }
  function goBack() {
    if (ui.folder == null) return;
    var prev = ui.folder;
    var f = findFolder(prev);
    ui.folder = f ? f.parent : null;
    ui.focusedId = prev; /* land focus on the folder we came out of */
    render();
  }
  function openFocused() {
    var v = visibleFocused();
    if (!v) return;
    if (v.type === 'link') { openInNewTab(normUrl(v.node.url)); return; }
    openFolder(v.node.id);
  }
  function rightKey() {
    var v = visibleFocused();
    if (!v) return;
    if (v.type === 'folder') openFolder(v.node.id);
  }
  function leftKey() { goBack(); }

  /* ---- add / edit ---- */

  function addParent() {
    var v = visibleFocused();
    if (!v) return ui.folder;
    return v.type === 'folder' ? v.node.id : v.node.parent;
  }
  function nextIndex(parent) { return childrenOf(parent).length; }

  /* ------------------------------------------------- chrome write-through
     The sidebar is a real editor for Chrome's bookmarks: every add / edit /
     delete / move is mirrored straight into chrome.bookmarks, so changes
     persist in Chrome itself (and survive the auto-merge — deleting a folder
     here really deletes it in Chrome). The local mirror stays optimistic:
     it updates instantly and the real chromeId is backfilled from the API
     result. Local-only nodes (created earlier, or while Chrome is
     unreachable) are materialized into Chrome on demand. Without the
     "bookmarks" permission everything degrades to the old local-only
     behavior. */

  function chromeBk() {
    return (typeof chrome !== 'undefined' && chrome.bookmarks) ? chrome.bookmarks : null;
  }
  /* Chrome parent id for a sidebar parent: root → the bookmarks bar ('1');
     a folder → its own chromeId (null while it's still local-only).
     Chrome's bar can be deleted in the sidebar (tombstoned) — then new
     root-level nodes must go to the next permanent folder (Other bookmarks
     '2', Mobile '3'), or they'd land in the deleted bar and silently never
     appear in the sidebar again. */
  function chromeParentId(localParent) {
    if (localParent == null) {
      if (STORE.deletedChromeIds.indexOf('1') === -1) return '1';
      if (STORE.deletedChromeIds.indexOf('2') === -1) return '2';
      if (STORE.deletedChromeIds.indexOf('3') === -1) return '3';
      return '1';
    }
    var f = findFolder(localParent);
    return f && f.chromeId ? f.chromeId : null;
  }
  /* push one local-only node into Chrome, backfilling its chromeId; folders
     bring their children along. cb(chromeId) when done. */
  function materializeNode(id, cb) {
    var bk = chromeBk();
    var n = findNode(id);
    if (!bk || !n) { cb && cb(null); return; }
    var node = n.node;
    if (node.chromeId) { cb && cb(node.chromeId); return; }
    var cParent = chromeParentId(node.parent);
    if (!cParent) { cb && cb(null); return; }
    bk.create({
      parentId: cParent,
      title: node.name,
      url: n.type === 'link' ? node.url : undefined,
      index: node.index
    }, function (created) {
      if (!created || !created.id) { cb && cb(null); return; }
      node.chromeId = created.id;
      touch(); /* persist the backfill */
      if (n.type !== 'folder') { cb && cb(created.id); return; }
      var kids = childrenOf(node.id);
      var left = kids.length;
      if (!left) { cb && cb(created.id); return; }
      var guard = false;
      kids.forEach(function (k) {
        materializeNode(k.node.id, function () {
          if (guard) return;
          if (--left <= 0) { guard = true; cb && cb(created.id); }
        });
      });
    });
  }
  /* the node's parent chain may itself be local-only — materialize upward
     first so a chrome parent id exists, then materialize the node. */
  function materializeParentChain(id, cb) {
    var n = findNode(id);
    if (!n) { cb(); return; }
    var p = n.node.parent;
    if (p == null) { cb(); return; }
    var pf = findFolder(p);
    if (!pf || pf.chromeId) { cb(); return; }
    materializeParentChain(pf.id, function () {
      materializeNode(pf.id, function () { cb(); });
    });
  }
  /* ensure a node exists in chrome (materializing its chain), then run op
     with its chromeId (null if it can't be materialized). */
  function withChromeNode(id, op) {
    var n = findNode(id);
    if (!n) { op(null); return; }
    if (n.node.chromeId) { op(n.node.chromeId); return; }
    materializeParentChain(id, function () {
      materializeNode(id, function (cid) { op(cid); });
    });
  }

  function openEditor(parent, type, node) {
    ui.editor = { parent: parent, type: type, node: node || null };
    render();
    var inp = tree.querySelector('.bk-en');
    if (inp) inp.focus();
  }
  function cancelEditor() {
    ui.editor = null;
    render();
  }
  function saveEditor(form) {
    var ed = ui.editor;
    if (!ed) return;
    var nameInp = form.querySelector('.bk-en');
    var urlInp = form.querySelector('.bk-ur');
    var name = nameInp.value.trim();
    var url = ed.type === 'link' ? normUrl(urlInp.value) : '';
    var ok = true;
    nameInp.classList.remove('err');
    if (!name) { nameInp.classList.add('err'); ok = false; }
    if (ed.type === 'link' && !url) {
      if (urlInp) urlInp.classList.add('err');
      ok = false;
    }
    if (!ok) return;

    var id, isEdit = !!ed.node;
    if (isEdit) {
      id = ed.node.id;
      ed.node.name = name;
      if (ed.type === 'link') {
        if (ed.node.url !== url) delete faviconCache[ed.node.url];
        ed.node.url = url;
      }
    } else {
      id = uid();
      if (ed.type === 'link') {
        STORE.items.push({ id: id, name: name, url: url, parent: ed.parent, index: nextIndex(ed.parent) });
      } else {
        STORE.folders.push({ id: id, name: name, parent: ed.parent, index: nextIndex(ed.parent) });
      }
    }
    ui.editor = null;
    ui.focusedId = id;
    /* drill into the folder the node landed in so it's visible */
    if (ed.parent) ui.folder = ed.parent;
    saveUI();
    touch();
    render();

    /* ---- write through to chrome.bookmarks ---- */
    var bk = chromeBk();
    if (!bk) return;
    var savedNode = findNode(id);
    if (!savedNode) return;
    var node = savedNode.node;
    if (isEdit && node.chromeId) {
      /* existing chrome bookmark — update it in place */
      var upd = { title: name };
      if (ed.type === 'link') upd.url = url;
      try { bk.update(node.chromeId, upd, function () {}); } catch (e) { /* chrome gone */ }
    } else {
      /* fresh add (or a local-only node being edited) — materialize it into
         chrome so it really lives there (fresh adds are created by
         materializeNode with the values above) */
      withChromeNode(id, function (cid) {
        if (!cid) return;
        if (isEdit) {
          var u2 = { title: name };
          if (ed.type === 'link') u2.url = url;
          try { bk.update(cid, u2, function () {}); } catch (e) { /* noop */ }
        }
      });
    }
  }

  /* ---- delete (armed like the grid's `d`) ---- */

  function armOrDelete(id) {
    var target = id || ui.focusedId;
    if (!findNode(target)) return;
    if (ui.armedId === target) { deleteNode(target); return; }
    ui.armedId = target;
    clearTimeout(ui.armTimer);
    ui.armTimer = setTimeout(function () { disarm(); }, 2500);
    updateArmed();
  }
  function deleteNode(id) {
    var n = findNode(id);
    if (!n) return;
    var parent = n.node.parent;
    var ids = n.type === 'folder' ? collectIds(id) : [id];
    var set = {};
    ids.forEach(function (x) { set[x] = true; });

    /* remove it from chrome directly — folders take the whole subtree with
       removeTree, so a sidebar deletion is a real deletion */
    var bk = chromeBk();
    if (bk && n.node.chromeId) {
      try {
        if (n.type === 'folder') bk.removeTree(n.node.chromeId, function () {});
        else bk.remove(n.node.chromeId, function () {});
      } catch (e) { /* chrome gone */ }
    }

    /* tombstone the chrome ids anyway — a safety net for the async window
       (a merge that already read the tree before the removal landed) */
    STORE.folders.concat(STORE.items).forEach(function (node) {
      if (set[node.id] && node.chromeId &&
          STORE.deletedChromeIds.indexOf(node.chromeId) === -1) {
        STORE.deletedChromeIds.push(node.chromeId);
      }
    });
    STORE.folders = STORE.folders.filter(function (f) { return !set[f.id]; });
    STORE.items = STORE.items.filter(function (it) { return !set[it.id]; });
    reindex(parent);
    ui.focusedId = parent;
    disarm();
    touch();
    render();
  }

  /* ------------------------------------------------------- drag & drop */

  function clearDrop() {
    tree.classList.remove('drop-root');
    var rows = tree.querySelectorAll('.bk-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.remove('drop-before', 'drop-into', 'dragging');
    }
  }
  function moveNode(id, newParent, newIndex) {
    var n = findNode(id);
    if (!n) return;
    if (n.type === 'folder' && (newParent === id || isDescendant(newParent, id))) return;
    var oldParent = n.node.parent;
    removeById(id);
    n.node.parent = newParent;
    n.node.index = newIndex; /* normalized by reindex below */
    if (n.type === 'folder') STORE.folders.push(n.node);
    else STORE.items.push(n.node);
    reindex(newParent);
    if (oldParent !== newParent) reindex(oldParent);
    ui.focusedId = id;
    saveUI();
    touch();
    render();

    /* ---- mirror the move in chrome.bookmarks ---- */
    var bk = chromeBk();
    if (!bk) return;
    if (n.node.chromeId) {
      /* destination may be a local-only folder — materialize it first */
      materializeParentChain(newParent, function () {
        if (!n.node.chromeId) return;
        var cP = chromeParentId(newParent);
        if (!cP) return;
        try { bk.move(n.node.chromeId, { parentId: cP, index: newIndex }, function () {}); } catch (e) { /* noop */ }
      });
    } else {
      /* local-only node being dragged — push it into chrome at its new spot */
      withChromeNode(id, function () {});
    }
  }
  function removeById(id) {
    STORE.folders = STORE.folders.filter(function (f) { return f.id !== id; });
    STORE.items = STORE.items.filter(function (it) { return it.id !== id; });
  }

  tree.addEventListener('dragstart', function (e) {
    var r = e.target.closest('.bk-row');
    if (!r) { e.preventDefault(); return; }
    ui.dragId = r.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ui.dragId);
    r.classList.add('dragging');
  });
  tree.addEventListener('dragend', function () {
    ui.dragId = null;
    clearDrop();
  });
  tree.addEventListener('dragover', function (e) {
    if (!ui.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var r = e.target.closest('.bk-row');
    clearDrop();
    if (r && r.dataset.type === 'folder') r.classList.add('drop-into');
    else if (r) r.classList.add('drop-before');
    else tree.classList.add('drop-root');
  });
  tree.addEventListener('drop', function (e) {
    if (!ui.dragId) return;
    e.preventDefault();
    var id = ui.dragId;
    var r = e.target.closest('.bk-row');
    var dest;
    if (r && r.dataset.type === 'folder') {
      dest = { parent: r.dataset.id, index: childrenOf(r.dataset.id).length };
    } else if (r) {
      var target = findNode(r.dataset.id);
      var idx = target ? target.node.index : 0;
      /* dropping before a sibling further down: the source's removal shifts
         the target up by one, so insert one earlier */
      var src = findNode(id);
      if (target && src && src.node.parent === target.node.parent && src.node.index < idx) idx -= 1;
      dest = { parent: target ? target.node.parent : null, index: idx };
    } else {
      dest = { parent: null, index: childrenOf(null).length };
    }
    ui.dragId = null;
    clearDrop();
    moveNode(id, dest.parent, dest.index);
  });

  /* ------------------------------------------------------- import / export */

  function parseNetscape(text) {
    var doc = new DOMParser().parseFromString(text, 'text/html');
    var rootDl = doc.querySelector('DL');
    if (!rootDl) throw new Error('no DL');
    var folders = [], items = [];
    walk(rootDl, null);
    function walk(dl, parent) {
      var dts = dl.children;
      for (var i = 0; i < dts.length; i++) {
        var dt = dts[i];
        if (dt.tagName !== 'DT') continue;
        var a = dt.querySelector(':scope > A');
        var h3 = dt.querySelector(':scope > H3');
        var sub = dt.querySelector(':scope > DL');
        if (a && a.getAttribute('href')) {
          items.push({ name: String(a.textContent).trim(), url: a.getAttribute('href'), parent: parent });
        } else if (h3) {
          var fid = uid();
          folders.push({ id: fid, name: String(h3.textContent).trim(), parent: parent, index: 0 });
          if (sub) walk(sub, fid);
        }
      }
    }
    return { folders: folders, items: items };
  }
  function mergeParsed(parsed, parent) {
    var idMap = {};
    parsed.folders.forEach(function (f) {
      var nid = uid();
      idMap[f.id] = nid;
      f.id = nid;
    });
    parsed.folders.forEach(function (f) { f.parent = idMap[f.parent] || parent || null; });
    parsed.items.forEach(function (it) { it.parent = idMap[it.parent] || parent || null; });
    var groups = {};
    parsed.folders.concat(parsed.items).forEach(function (n) {
      var k = parentKey(n.parent);
      (groups[k] = groups[k] || []).push(n);
    });
    Object.keys(groups).forEach(function (k) {
      var kids = groups[k];
      var base = childrenOf(k === '__root__' ? null : k).length;
      kids.forEach(function (n, i) {
        n.index = base + i;
        if (n.url) STORE.items.push(n);
        else STORE.folders.push(n);
      });
    });
  }
  function importTarget() {
    var v = visibleFocused();
    if (!v) return null;
    return v.type === 'folder' ? v.node.id : v.node.parent;
  }

  /* import / export UI was removed; the pure parse/build helpers above stay
     in case the feature is ever re-wired */

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function buildNetscape() {
    var lines = [];
    lines.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    lines.push('<!-- This is an automatically generated file.\n     It will be read and overwritten.\n     DO NOT EDIT! -->');
    lines.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    lines.push('<TITLE>Bookmarks</TITLE>');
    lines.push('<H1>Bookmarks</H1>');
    lines.push('<DL><p>');
    buildChildren(null, 1);
    lines.push('</DL><p>');
    return lines.join('\n');

    function buildChildren(parent, depth) {
      var pad = new Array(depth + 1).join('  ');
      childrenOf(parent).forEach(function (k) {
        if (k.type === 'folder') {
          lines.push(pad + '<DT><H3 ADD_DATE="' + stamp() + '">' + escHtml(k.node.name) + '</H3>');
          lines.push(pad + '<DL><p>');
          buildChildren(k.node.id, depth + 1);
          lines.push(pad + '</DL><p>');
        } else {
          lines.push(pad + '<DT><A HREF="' + escHtml(k.node.url) + '" ADD_DATE="' + stamp() + '">' + escHtml(k.node.name) + '</A>');
        }
      });
    }
    function stamp() { return String(Math.floor(Date.now() / 1000)); }
  }


  /* ------------------------------------------------------- chrome bookmarks
     With the "bookmarks" permission the sidebar mirrors Chrome's real
     bookmarks. mergeChromeTree() is safe to run any time:
     - nodes we already imported (matched by chromeId) get title/url updates
     - folders the user created by hand (no chromeId yet) are matched by name
       within the same parent so they don't get duplicated   - brand-new chrome nodes are appended into their mapped folder
   - hand-made nodes are never touched; deletions in chrome do NOT remove
       sidebar nodes (one-way mirror, so local edits always survive)
   - nodes the user deletes in the sidebar are tombstoned (deletedChromeIds)
       so the automatic mirror never brings them back on the next load */

  var chromeMerging = false;

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }
  function findByChromeId(type, chromeId) {
    var arr = type === 'folder' ? STORE.folders : STORE.items;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].chromeId === chromeId) return arr[i];
    }
    return null;
  }
  function matchByName(type, parent, name) {
    var arr = type === 'folder' ? STORE.folders : STORE.items;
    var want = String(name || '').trim().toLowerCase();
    if (!want) return null;
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (n.chromeId) continue;
      if (parentKey(n.parent) !== parentKey(parent)) continue;
      if (String(n.name || '').trim().toLowerCase() === want) return n;
    }
    return null;
  }
  function isTombstoned(chromeId) {
    return STORE.deletedChromeIds.indexOf(chromeId) !== -1;
  }
  function upsertChromeLink(ch, ourParent) {
    var ex = findByChromeId('link', ch.id) || matchByName('link', ourParent, ch.title);
    if (ex) {
      if (!ex.chromeId) ex.chromeId = ch.id;
      var name = ch.title || hostOf(ch.url) || ch.url;
      if (ex.name !== name) { ex.name = name; return true; }
      if (ex.url !== ch.url) { delete faviconCache[ex.url]; ex.url = ch.url; return true; }
      return false;
    }
    STORE.items.push({
      id: uid(),
      chromeId: ch.id,
      name: ch.title || hostOf(ch.url) || ch.url,
      url: ch.url,
      parent: ourParent,
      index: nextIndex(ourParent)
    });
    return true;
  }
  function upsertChromeFolder(ch, ourParent) {
    var ex = findByChromeId('folder', ch.id) || matchByName('folder', ourParent, ch.title);
    if (ex) {
      if (!ex.chromeId) ex.chromeId = ch.id;
      if (ex.name !== ch.title) { ex.name = ch.title; return { id: ex.id, changed: true }; }
      return { id: ex.id, changed: false };
    }
    var fid = uid();
    STORE.folders.push({ id: fid, chromeId: ch.id, name: ch.title || 'folder', parent: ourParent, index: nextIndex(ourParent) });
    return { id: fid, changed: true };
  }
  function mergeChromeNode(cn, ourParent) {
    var changed = false;
    var kids = cn.children || [];
    for (var i = 0; i < kids.length; i++) {
      var ch = kids[i];
      if (ch.id && isTombstoned(ch.id)) continue; /* user deleted this locally */
      if (ch.url) {
        if (upsertChromeLink(ch, ourParent)) changed = true;
      } else {
        var f = upsertChromeFolder(ch, ourParent);
        if (f.changed) changed = true;
        if (ch.children && ch.children.length) {
          if (mergeChromeNode(ch, f.id)) changed = true;
        }
      }
    }
    return changed;
  }
  function mergeChromeTree() {
    return new Promise(function (resolve) {
      if (chromeMerging) { resolve(false); return; }
      if (!(window.chrome && chrome.bookmarks && chrome.bookmarks.getTree)) { resolve(false); return; }
      chromeMerging = true;
      try {
        chrome.bookmarks.getTree(function (tree) {
          chromeMerging = false;
          var changed = false;
          try {
            if (tree && tree[0]) changed = mergeChromeNode(tree[0], null);
          } catch (e) { /* keep local state intact */ }
          if (changed) { saveUI(); touch(); render(); }
          resolve(changed);
        });
      } catch (e) { chromeMerging = false; resolve(false); }
    });
  }

  /* ------------------------------------------------------- panel open/close */

  function setOpen(open) {
    if (open === ui.open) return;
    ui.open = open;
    root.classList.toggle('open', open);
    root.setAttribute('aria-hidden', String(!open));
    saveUI();
    if (open) render();
  }
  function togglePanel() { setOpen(!ui.open); }

  toggleBtn.addEventListener('click', togglePanel);
  closeBtn.addEventListener('click', function () { setOpen(false); });
  if (chromeBtn) {
    chromeBtn.addEventListener('click', function () {
      if (chromeBtn.classList.contains('syncing')) return;
      chromeBtn.classList.add('syncing');
      mergeChromeTree().then(function () { chromeBtn.classList.remove('syncing'); });
    });
  }
  if (backBtn) backBtn.addEventListener('click', goBack);
  if (emptyAddBtn) emptyAddBtn.addEventListener('click', function () { openEditor(ui.folder, 'link', null); });
  /* the add toolbar is gone; adding stays keyboard-only (a / shift+a) */

  /* click a row: links open, folders drill in */
  tree.addEventListener('click', function (e) {
    var r = e.target.closest('.bk-row');
    if (!r || e.target.closest('.bk-ctx-btn')) return;
    var id = r.dataset.id;
    ui.focusedId = id;
    var v = null;
    for (var i = 0; i < ui.visible.length; i++) if (ui.visible[i].node.id === id) v = ui.visible[i];
    if (!v) return;
    if (v.type === 'link') openInNewTab(normUrl(v.node.url));
    else openFolder(id);
  });

  tree.addEventListener('contextmenu', function (e) {
    if (e.target.closest('.bk-row')) e.preventDefault();
  });

  /* clicking anywhere outside the panel closes it. Capture phase: the tree's
     bubble handlers re-render rows (detaching the click target), so containment
     must be decided before any handler mutates the DOM. */
  document.addEventListener('click', function (e) {
    if (!ui.open || ignoreOutsideClick) return;
    if (e.target && e.target.closest &&
        (e.target.closest('#bk') || e.target.closest('#bkToggle'))) return;
    setOpen(false);
  }, true);

  /* ------------------------------------------------------- keys
     capture phase + stopPropagation so the grid (app.js) never sees the
     keys we consume while the sidebar is open. */

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;

    var typing = isTyping(e.target);
    var modalOpen = isVisible('#modal');
    var drawerOpen = !!($('#drawer') && $('#drawer').classList.contains('open'));
    var barOpen = isVisible('#bar');

    /* app modal/drawer/bar on top: only let Esc close the sidebar */
    if (modalOpen || drawerOpen || barOpen) {
      if (ui.open && e.key === 'Escape') {
        setOpen(false);
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    /* editing inputs: escape cancels the editor */
    if (typing) {
      if (ui.editor && e.key === 'Escape') {
        cancelEditor();
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (!ui.open) {
      if (e.key === 'b' || e.key === 'B') {
        setOpen(true);
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    var handled = true;
    switch (e.key) {
      case 'b': case 'B': case 'Escape':
        if (ui.editor) cancelEditor();
        else if (ui.armedId) disarm();
        else setOpen(false);
        break;
      case 'j': case 'ArrowDown': moveFocus(1); break;
      case 'k': case 'ArrowUp': moveFocus(-1); break;
      case 'l': case 'ArrowRight': rightKey(); break;
      case 'h': case 'ArrowLeft': leftKey(); break;
      case 'Enter': case 'o': case 'O': openFocused(); break;
      case 'a': openEditor(addParent(), 'link', null); break;
      case 'A': openEditor(addParent(), 'folder', null); break;
      case 'e': case 'E': {
        var v = visibleFocused();
        if (v) openEditor(v.node.parent, v.type, v.node);
        break;
      }
      case 'd': case 'D': armOrDelete(); break;
      case 'g': case 'Home': focusFirst(); break;
      case 'G': case 'End': focusLast(); break;
      case 'Tab': break; /* consume so the grid doesn't paginate */
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  /* ------------------------------------------------------- init */

  var saved = readLS(LS_KEY);
  if (saved) setData(saved);

  var uiSaved = readLS(UI_KEY);
  if (uiSaved && uiSaved.open) ui.open = true;

  render();
  if (ui.open) {
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
  }

  loadPersistedIcons();

  /* chrome.storage is the durable mirror — extension reloads wipe page
     localStorage, so the tombstones must come from here when the fast local
     copy is gone. The first chrome merge MUST wait for this read: if it ran
     first it would re-import everything the user deleted (no tombstones in
     memory yet) and persist that, permanently resurrecting the deletions. */
  function bootFromStorage() {
    return new Promise(function (resolve) {
      if (!(window.chrome && chrome.storage && chrome.storage.local)) { resolve(); return; }
      try {
        chrome.storage.local.get(LS_KEY, function (o) {
          try {
            /* always reconcile with the durable copy — adopt() decides who
               wins by updatedAt and unions tombstones either way, so a
               missing/wiped localStorage can't lose deletions */
            if (o && o[LS_KEY]) adopt(o[LS_KEY]);
          } catch (e) { /* keep whatever loaded */ }
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  /* pull the user's real chrome bookmarks in automatically (no-op without
     the "bookmarks" permission) — only after the durable store is loaded */
  bootFromStorage().then(function () {
    mergeChromeTree();
  });
})();
