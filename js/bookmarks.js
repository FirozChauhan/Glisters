/* ---------------------------------------------------------------------------
   GLISTERS — bookmarks sidebar
   A direct editor for Chrome's real bookmarks on the left edge of the new
   tab page.

   - the sidebar is a LIVE view of chrome.bookmarks: it renders getTree()
     and refreshes on every chrome bookmark event (onCreated/onRemoved/
     onChanged/onMoved/…), so changes made anywhere (Chrome UI, sync,
     another device) appear instantly
   - every edit is written STRAIGHT through to chrome.bookmarks — add, edit,
     delete and move call the real API. Nothing is mirrored, nothing is
     stored locally, nothing rides the cloud save doc. "Bookmarks bar"
     contents fill the home view; "Other bookmarks" and "Mobile bookmarks"
     are reachable as the trailing folders
   - keyboard-first:  b toggle · j/k move · enter or l open folder/link ·
     h or ← back · a add link · A add folder · e edit · d delete (arm) ·
     g/G first/last · esc close
   - self-contained: talks to app.js only through guarded hooks
     (window.BOOKMARKS.bind / forDoc / restore — now inert, since the
     sidebar no longer contributes to the save doc)
--------------------------------------------------------------------------- */

(function () {
  'use strict';

  var UI_KEY = 'glisters-bk-ui';    /* panel open state (local only) */

  /* ------------------------------------------------------------------ state */

  /* the normalized chrome bookmark tree: every folder/link node is
     { id: chromeId, name, url?, parent, index }. Home (parent null) is the
     bookmarks bar; the "Other bookmarks" / "Mobile bookmarks" roots are
     folder nodes with parent null and a large index so they trail the bar
     contents at home. */
  var TREE = { folders: [], items: [] };

  var ui = {
    open: false,
    folder: null,           /* currently open folder chromeId; null = home */
    focusedId: null,
    armedId: null,
    armTimer: null,
    editor: null,   /* { parent, type: 'link'|'folder', node } — null when closed */
    visible: []     /* cached flat list for the current view from last render() */
  };

  var appCommit = null;     /* kept for API-shape compat — no longer used */
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

  function saveUI() {
    try { localStorage.setItem(UI_KEY, JSON.stringify({ open: ui.open })); } catch (e) {}
  }

  /* ------------------------------------------------------- chrome access */

  function chromeBk() {
    return (typeof chrome !== 'undefined' && chrome.bookmarks) ? chrome.bookmarks : null;
  }
  /* home (parent null) maps to the bookmarks bar for the API */
  function homeIdOf(p) { return p || '1'; }
  function homeOf(p) { return p === '1' ? null : p; }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\\./, ''); } catch (e) { return ''; }
  }

  /* pull the real chrome tree and normalize it for the renderer */
  function refresh() {
    return new Promise(function (resolve) {
      var bk = chromeBk();
      if (!bk || !bk.getTree) { resolve(false); return; }
      try {
        bk.getTree(function (tree) {
          try {
            normalizeTree(tree);
          } catch (e) { /* keep previous tree */ }
          /* the folder being viewed may have been deleted in chrome */
          if (ui.folder && !findFolder(ui.folder)) ui.folder = null;
          render();
          resolve(true);
        });
      } catch (e) { resolve(false); }
    });
  }

  function normalizeTree(tree) {
    var folders = [], items = [];
    var rootNode = tree && tree[0];
    (function walk(cn, parent) {
      var kids = cn.children || [];
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        if (!ch || !ch.id) continue;
        /* the bar's children ARE home; the other permanent roots become
           trailing folder rows at home (large index so they sort last) */
        var p = parent === '1' ? null : parent;
        if (ch.url) {
          items.push({ id: ch.id, name: ch.title || hostOf(ch.url) || ch.url, url: ch.url, parent: p, index: i });
        } else {
          if (ch.id === '1') { walk(ch, '1'); continue; } /* bar itself is not a row */
          var idx = parent == null ? 100000 + i : i;
          folders.push({ id: ch.id, name: ch.title || 'folder', parent: p, index: idx });
          walk(ch, ch.id);
        }
      }
    })(rootNode, null);
    TREE.folders = folders;
    TREE.items = items;
  }

  /* live: any chrome bookmark change re-renders the sidebar */
  var refreshTimer = 0;
  function armRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  }
  var BK_EVENTS = ['onCreated', 'onRemoved', 'onChanged', 'onMoved',
    'onChildrenReordered', 'onImportEnded', 'onImportBegan'];
  function bindChromeEvents() {
    var bk = chromeBk();
    if (!bk) return;
    for (var i = 0; i < BK_EVENTS.length; i++) {
      if (bk[BK_EVENTS[i]] && bk[BK_EVENTS[i]].addListener) {
        try { bk[BK_EVENTS[i]].addListener(armRefresh); } catch (e) { /* noop */ }
      }
    }
  }

  /* ------------------------------------------------------- tree helpers */

  function parentKey(p) { return p == null ? '__root__' : p; }
  function findFolder(id) {
    for (var i = 0; i < TREE.folders.length; i++) if (TREE.folders[i].id === id) return TREE.folders[i];
    return null;
  }
  function findItem(id) {
    for (var i = 0; i < TREE.items.length; i++) if (TREE.items[i].id === id) return TREE.items[i];
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
    for (var i = 0; i < TREE.folders.length; i++) {
      if (parentKey(TREE.folders[i].parent) === p) out.push({ type: 'folder', node: TREE.folders[i] });
    }
    for (var j = 0; j < TREE.items.length; j++) {
      if (parentKey(TREE.items[j].parent) === p) out.push({ type: 'link', node: TREE.items[j] });
    }
    out.sort(function (a, b) { return a.node.index - b.node.index; });
    return out;
  }
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
  function isDescendant(maybeChild, ancestor) {
    var cur = maybeChild, guard = 0;
    while (cur && guard++ < 100) {
      if (cur === ancestor) return true;
      var n = findNode(cur);
      cur = n ? n.node.parent : null;
    }
    return false;
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
       from a malicious bookmark title or tampered source) */
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

  function openFolder(id) {
    if (id === '1') id = null; /* the bar IS home */
    if (id != null && !findFolder(id)) return;
    ui.folder = id;
    ui.focusedId = null;
    render();
  }
  function goBack() {
    if (ui.folder == null) return;
    var prev = ui.folder;
    var f = findFolder(prev);
    ui.folder = f ? homeOf(f.parent) : null;
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
  /* every add / edit goes STRAIGHT to chrome.bookmarks — there is no local
     store, so a saved change IS a chrome change. The tree is re-read after
     the API callback (and the chrome event listeners re-render on their
     own). */
  function saveEditor(form) {
    var ed = ui.editor;
    if (!ed) return;
    var bk = chromeBk();
    if (!bk) { cancelEditor(); return; }
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

    var done = function (created) {
      /* focus the created/edited node, but only AFTER the fresh tree lands:
         render() falls back to the first row when the focused id is missing,
         and the just-created node isn't in the tree until refresh() re-reads
         it — so set focus on the refresh callback, not before */
      var focusId = (created && created.id) || (ed.node && ed.node.id) || null;
      ui.editor = null;
      if (ed.parent) ui.folder = homeOf(ed.parent);
      saveUI();
      render();
      refresh().then(function () {
        if (focusId) setFocused(focusId);
      });
    };

    if (ed.node) {
      /* edit an existing chrome bookmark in place */
      var upd = { title: name };
      if (ed.type === 'link') upd.url = url;
      try { bk.update(ed.node.id, upd, done); } catch (e) { cancelEditor(); }
    } else {
      /* fresh add — created directly in chrome */
      var o = { parentId: homeIdOf(ed.parent), title: name };
      if (ed.type === 'link') o.url = url;
      try { bk.create(o, done); } catch (e) { cancelEditor(); }
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
    var bk = chromeBk();
    if (!bk) return;
    var done = function () {
      ui.focusedId = parent;
      disarm();
      refresh();
    };
    try {
      /* real deletion in chrome — folders take the whole subtree */
      if (n.type === 'folder') bk.removeTree(id, done);
      else bk.remove(id, done);
    } catch (e) { /* chrome gone */ }
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
    var bk = chromeBk();
    if (!bk) return;
    /* direct move in chrome — home maps to the bookmarks bar */
    try {
      bk.move(id, { parentId: homeIdOf(newParent), index: newIndex }, function () {
        ui.focusedId = id;
        refresh();
      });
    } catch (e) { /* chrome gone */ }
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
      refresh().then(function () { chromeBtn.classList.remove('syncing'); });
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

  /* ------------------------------------------------------- public API
     The sidebar is a direct chrome editor now — it contributes NOTHING to
     the shared save doc. bind/forDoc/restore are kept only so app.js's
     guarded calls stay valid; none of them do anything. */

  window.BOOKMARKS = {
    bind: function () { /* no shared-doc writes anymore */ },
    forDoc: function () { return null; },           /* no slice in the doc */
    restore: function () { /* nothing to adopt — bookmarks live in chrome */ },
    refreshFromChrome: function () { return refresh(); }
  };

  /* ------------------------------------------------------- init */

  bindChromeEvents();
  loadPersistedIcons();

  var uiSaved = null;
  try { uiSaved = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch (e) { /* noop */ }
  if (uiSaved && uiSaved.open) {
    ui.open = true;
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
  }

  /* first paint: pull the real chrome tree */
  refresh();
})();
