(function () {
  'use strict';

  /* Cloudflare Worker sync. The worker (worker/) holds the R2 binding and
     verifies the Clerk session, so no credentials ever ship in the extension —
     config.js only carries the public worker URL + the Clerk publishable key.
     Each user's save lives at its own R2 object (Glisters/users/<id>/save.json),
     read and written through GET/PUT /save with `Authorization: Bearer <jwt>`. */

  var CF = window.CONFIG || {};
  var base = String(CF.worker || CF.endpoint || '').replace(/\/+$/, '');
  var cfg = { enabled: !!base };

  /* session JWT from window.AUTH (js/auth.js) — null when signed out, which
     the worker answers with 401 and the app surfaces as 'sign in to sync' */
  function getToken() {
    var A = window.AUTH;
    if (A && typeof A.getToken === 'function') return A.getToken();
    return Promise.resolve(null);
  }

  function req(method, body, headers) {
    var opts = { method: method, headers: {} };
    if (body != null) {
      opts.body = body;
      opts.headers['Content-Type'] = 'application/json';
    }
    if (headers) {
      for (var k in headers) opts.headers[k] = headers[k];
    }
    return getToken().then(function (token) {
      if (token) opts.headers['Authorization'] = 'Bearer ' + token;
      return fetch(base + '/save', opts).then(function (r) {
        if (r.status === 404) return null;
        if (r.status === 401) return { unauthorized: true };
        if (!r.ok) {
          /* 409 = a newer save exists — the caller should pull it and adopt */
          if (r.status === 409) return { conflict: true };
          return r.text().then(function (t) { throw new Error(t || String(r.status)); });
        }
        if (method === 'PUT') return true;
        return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
      });
    });
  }

  function push(data, seed) {
    if (!cfg.enabled) return Promise.reject(new Error('cloud sync disabled'));
    /* a fresh-install seed (no real local edits yet) is flagged so the
       worker can refuse to let it overwrite an existing save — a wiped
       local store must pull + adopt the cloud, never clobber it */
    var h = seed ? { 'X-Glisters-Seed': '1' } : null;
    return req('PUT', JSON.stringify(data), h);
  }

  function pull() {
    if (!cfg.enabled) return Promise.reject(new Error('cloud sync disabled'));
    return req('GET');
  }

  /* window.SYNC — the cloud client consumed by app.js.
     - cfg.enabled: worker URL configured (config.js)
     - push(doc, seed?): PUT /save. seed=true adds X-Glisters-Seed: 1 so the
       worker refuses to overwrite an existing save. Resolves true, or
       { conflict: true } (newer save exists — pull + adopt), or
       { unauthorized: true } (worker 401 — session rejected), or rejects
     - pull(): GET /save → doc JSON | null (404) | { conflict/unauthorized }
     - getToken(): Promise<string|null> — the current session JWT (delegates
       to window.AUTH), used by tests and callers outside sync itself
  --------------------------------------------------------------------------- */
  window.SYNC = { cfg: cfg, push: push, pull: pull, getToken: getToken };
})();
