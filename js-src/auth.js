/**
 * GLISTERS — Clerk auth bootstrap (COOKIE-BASED — no ClerkJS in the extension)
 *
 * Loaded from newtab.html before sync.js/app.js. Exposes `window.AUTH` — the
 * guarded hook every other module talks to. Never throws: a missing/invalid
 * publishable key or a missing cookie must never break the grid.
 *
 * HOW SIGN-IN WORKS (why there is no ClerkJS bundle):
 *   The Clerk instance's domains are partially dead (see AGENTS.md §3.9) and
 *   its API refuses to start the OAuth verification for extension clients, so
 *   the extension does NOT run the Clerk SDK. Instead the user signs in
 *   through the morphica web app's own working Google OAuth flow
 *   (https://morphica-nine.vercel.app/sign-in — same Clerk project, same user
 *   pool). That flow sets the HTTP-only `__session` cookie on the morphica
 *   domain, which this module reads with the privileged chrome.cookies API
 *   (permissions already in the manifest). The cookie value IS the Clerk
 *   session JWT that the worker verifies, so `Authorization: Bearer <jwt>`
 *   works with zero extra plumbing. Cookie changes (sign-in on the web app,
 *   sign-out elsewhere) are picked up live via chrome.cookies.onChanged plus
 *   a polling fallback.
 *
 * Contract consumed by app.js / sync.js:
 *   AUTH.ready      bool                — true once the boot cookie check ran
 *   AUTH.enabled    bool                — a publishable key is configured
 *   AUTH.isSignedIn bool                — a __session cookie was found
 *   AUTH.user       {id,email,name,imageUrl} | null  (fetched from /v1/me)
 *   AUTH.getToken() Promise<string|null>  — session JWT for the worker
 *   AUTH.signIn(el) renders a "Continue with Google" button that opens the
 *                   morphica web app's sign-in page in a new tab
 *   AUTH.unmountSignIn(el)  removes the button
 *   AUTH.signOut()  removes the Clerk cookies (best-effort server revoke)
 *   AUTH.onChange(fn) subscribe — fn(snapshot) fires immediately with the
 *                                 current state, then on every auth change
 */
(function () {
  'use strict';

  var CONFIG = window.CONFIG || {};
  var KEY = String(CONFIG.publishableKey || '');
  var AUTH_BASE = 'https://morphica-nine.vercel.app';
  var PROXY = String(CONFIG.clerkProxyUrl || AUTH_BASE + '/__clerk');
  var SESSION_COOKIE = '__session';
  var COOKIE_URL = AUTH_BASE; /* cookie is host-scoped to the morphica domain */
  var SIGN_IN_URL = AUTH_BASE + '/sign-in';
  var POLL_MS = 30000;

  var listeners = [];
  var lastSessionToken = null;
  var pollTimer = null;

  var api = {
    ready: false,
    enabled: !!KEY,
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
      if (token) {
        fetch(PROXY + '/v1/client/sessions', {
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
    return fetch(PROXY + '/v1/me', {
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

  if (!KEY) {
    /* no publishable key configured — sync stays off, grid fully local */
    api.ready = true;
    emit();
    return;
  }

  /* boot: read the cookie synchronously-ish, then flip ready */
  checkSession().then(function () {
    api.ready = true;
    emit();
  });

  /* live updates: signing in/out on the morphica web app (or anywhere the
     shared cookie changes) while this page is open */
  try {
    chrome.cookies.onChanged.addListener(function (changeInfo) {
      if (changeInfo && changeInfo.cookie &&
          changeInfo.cookie.domain === 'morphica-nine.vercel.app' &&
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
