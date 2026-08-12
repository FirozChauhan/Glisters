(function () {
  'use strict';

  /* Cloudflare Worker sync. The worker (worker/) holds the R2 binding, so no
     credentials ever ship in the extension — config.js only carries the public
     worker URL. The whole save file lives at one object (Glisters/save.json),
     read and written through GET/PUT /save. */

  var CF = window.CONFIG || {};
  var base = String(CF.worker || CF.endpoint || '').replace(/\/+$/, '');
  var cfg = { enabled: !!base };

  function req(method, body) {
    var opts = { method: method, headers: {} };
    if (body != null) {
      opts.body = body;
      opts.headers['Content-Type'] = 'application/json';
    }
    return fetch(base + '/save', opts).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) {
        /* 409 = a newer save exists — the caller should pull it and adopt */
        if (r.status === 409) return { conflict: true };
        return r.text().then(function (t) { throw new Error(t || String(r.status)); });
      }
      if (method === 'PUT') return true;
      return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
    });
  }

  function push(data) {
    if (!cfg.enabled) return Promise.reject(new Error('cloud sync disabled'));
    return req('PUT', JSON.stringify(data));
  }

  function pull() {
    if (!cfg.enabled) return Promise.reject(new Error('cloud sync disabled'));
    return req('GET');
  }

  window.SYNC = { cfg: cfg, push: push, pull: pull };
})();
