/**
 * GLISTERS — Clerk auth bootstrap (COOKIE-BASED — no ClerkJS in the extension)
 *
 * Loaded from newtab.html before sync.js/app.js. Exposes `window.AUTH` — the
 * guarded hook every other module talks to. Never throws: a missing/invalid
 * publishable key or a missing cookie must never break the grid.
 *
 * HOW SIGN-IN WORKS (why there is no ClerkJS bundle):
 *   This extension has its OWN dedicated Clerk project (a test instance while
 *   developing — see AGENTS.md §3.9). Clerk's API refuses to start the OAuth
 *   verification for extension clients, so the extension does not run the SDK
 *   itself. Instead it opens the instance's hosted sign-in page in a new tab
 *   (`https://<instance>.accounts.dev/sign-in` — Clerk's own domain, branded
 *   "glisters", normal browser flow, Google OAuth). That flow sets the
 *   HTTP-only `__session` cookie on the hosted domain, which this module reads
 *   with the privileged chrome.cookies API (permissions already in the
 *   manifest). The cookie value IS the Clerk session JWT the worker verifies,
 *   so `Authorization: Bearer <jwt>` works with zero extra plumbing. Cookie
 *   changes (sign-in / sign-out / session rotation) are picked up live via
 *   chrome.cookies.onChanged plus a 30s polling fallback.
 *
 * Domains are DERIVED from the publishable key so the same code works for any
 * Clerk instance: the pk base64-encodes `<instance>.clerk.accounts.dev`; the
 * hosted (Account Portal) pages live on `<instance>.accounts.dev`.
 *
 * Contract consumed by app.js / sync.js:
 *   AUTH.ready      bool                — true once the boot cookie check ran
 *   AUTH.enabled    bool                — a publishable key is configured
 *   AUTH.isSignedIn bool                — a __session cookie was found
 *   AUTH.user       {id,email,name,imageUrl} | null  (fetched from /v1/me)
 *   AUTH.getToken() Promise<string|null>  — session JWT for the worker
 *   AUTH.signIn(el) renders a "Continue with Google" button that opens the
 *                   Clerk hosted sign-in page in a new tab
 *   AUTH.unmountSignIn(el)  removes the button
 *   AUTH.signOut()  removes the Clerk cookies (best-effort server revoke)
 *   AUTH.onChange(fn) subscribe — fn(snapshot) fires immediately with the
 *                                 current state, then on every auth change
 */
(function () {
  'use strict';

  var CONFIG = window.CONFIG || {};
  var KEY = String(CONFIG.publishableKey || '');

  /* ---- derive the Clerk domains from the publishable key ----
     pk format: pk_test_<base64> / pk_live_<base64>, where the base64 decodes
     to `<instance>.clerk.accounts.dev$` (the frontend API domain). The hosted
     sign-in / Account Portal pages live on `<instance>.accounts.dev`. */
  function deriveFrontendApi() {
    var parts = KEY.split('_');
    if (parts.length >= 3) {
      try {
        var decoded = atob(parts[parts.length - 1]);
        if (decoded.indexOf('.') > 0) {
          return decoded.replace(/\$$/, '');
        }
      } catch (e) { /* fall through */ }
    }
    /* legacy override (custom frontend API domain, e.g. a proxy) */
    return String(CONFIG.clerkProxyUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }

  var FRONTEND = deriveFrontendApi(); /* e.g. tidy-marmoset-1299.clerk.accounts.dev */
  var HOSTED = FRONTEND.replace(/\.clerk\.accounts\.dev$/, '.accounts.dev'); /* e.g. tidy-marmoset-1299.accounts.dev */
  var PROTO = 'https://';
  var COOKIE_URL = PROTO + HOSTED;           /* where the __session cookie lives */
  var SIGN_IN_URL = COOKIE_URL + '/sign-in'; /* Clerk hosted sign-in page */
  var SESSION_COOKIE = '__session';
  var POLL_MS = 30000;

  var listeners = [];
  var lastSessionToken = null;
  var pollTimer = null;

  var api = {
    ready: false,
    enabled: !!KEY && !!FRONTEND,
    isSignedIn: false,
    user: null,
    getToken: function () { return Promise.resolve(lastSessionToken); },
    signIn: function (el) {
      if (el) {
        el.innerHTML = '';
        el.hidden = false;
        var btn = document.createElement('button');
        btn.textContent = 'Continue with Google';
        btn.className = 'acct-google-btn';
        btn.onclick = function () {
          try { chrome.tabs.create({ url: SIGN_IN_URL }); }
          catch (e) { window.open(SIGN_IN_URL, '_blank', 'noopener'); }
        };
        el.appendChild(btn);
        var hint = document.createElement('p');
        hint.textContent = 'Opens the Glisters sign-in page in a new tab — complete it there and sync turns on here.';
        hint.className = 'acct-google-hint';
        el.appendChild(hint);
      }
    },
    unmountSignIn: function (el) {
      if (el) {
        el.innerHTML = '';
        el.hidden = true;
      }
    },
    signOut: function () {
      var token = lastSessionToken;
      lastSessionToken = null;
      api.isSignedIn = false;
      api.user = null;
      emit();
      /* forget the session in the browser itself */
      try {
        chrome.cookies.remove({ url: COOKIE_URL, name: SESSION_COOKIE });
        chrome.cookies.remove({ url: COOKIE_URL, name: '__client' });
        chrome.cookies.remove({ url: COOKIE_URL, name: '__clerk_uat' });
      } catch (e) { /* best-effort */ }
      /* best-effort server-side session revocation (DELETE /v1/client/sessions
         is what ClerkJS calls on sign-out; with the session JWT as Bearer) */
      if (token && FRONTEND) {
        fetch(PROTO + FRONTEND + '/v1/client/sessions', {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + token }
        }).catch(function () { /* the local cookie removal already signs out */ });
      }
      return Promise.resolve();
    },
    onChange: function (fn) {
      listeners.push(fn);
      emit();
      return function () {
        listeners = listeners.filter(function (l) { return l !== fn; });
      };
    },
    refresh: emit
  };

  function snapshot() {
    return {
      ready: api.ready,
      enabled: api.enabled,
      isSignedIn: api.isSignedIn,
      user: api.user
    };
  }

  function emit() {
    var s = snapshot();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](s); } catch (e) { /* a listener must never break the loop */ }
    }
  }

  /* the __session cookie value is the session JWT the worker verifies */
  function readSessionToken() {
    return new Promise(function (resolve) {
      try {
        chrome.cookies.get({ url: COOKIE_URL, name: SESSION_COOKIE }, function (c) {
          resolve(c ? c.value : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /* user display info (email/name) is not in the session JWT — ask the Clerk
     API for the user object. Fails soft: the account row still shows signed-in. */
  function fetchUser(token) {
    return fetch(PROTO + FRONTEND + '/v1/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function (data) {
      var u = (data && data.response) || data;
      if (!u || !u.id) return null;
      var email = '';
      if (u.email_addresses && u.email_addresses.length) {
        email = u.email_addresses[0].email_address || '';
      }
      return {
        id: u.id,
        email: email,
        name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '',
        imageUrl: u.image_url || u.profile_image_url || ''
      };
    }).catch(function () { return null; });
  }

  /* re-read the cookie; emit on change (sign-in / sign-out / token rotation) */
  function checkSession() {
    return readSessionToken().then(function (token) {
      if (token === lastSessionToken) return;
      lastSessionToken = token;
      if (token) {
        api.isSignedIn = true;
        emit();
        fetchUser(token).then(function (u) {
          api.user = u;
          emit();
        });
      } else {
        api.isSignedIn = false;
        api.user = null;
        emit();
      }
    });
  }

  window.AUTH = api;

  if (!KEY || !FRONTEND) {
    /* no publishable key configured — sync stays off, grid fully local */
    api.ready = true;
    emit();
    return;
  }

  /* boot: read the cookie, then flip ready */
  checkSession().then(function () {
    api.ready = true;
    emit();
  });

  /* live updates: signing in/out on the hosted page (or anywhere the shared
     cookie changes) while this page is open */
  try {
    chrome.cookies.onChanged.addListener(function (changeInfo) {
      if (changeInfo && changeInfo.cookie &&
          changeInfo.cookie.domain === HOSTED &&
          changeInfo.cookie.name === SESSION_COOKIE) {
        checkSession();
      }
    });
  } catch (e) { /* listener is best-effort */ }

  /* fallback polling in case an onChanged event is missed */
  pollTimer = setInterval(function () {
    checkSession();
  }, POLL_MS);
})();
