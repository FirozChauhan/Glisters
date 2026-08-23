/**
 * GLISTERS — Clerk auth bootstrap (SOURCE)
 *
 * Bundled to js/auth.js by `node scripts/gen-auth.mjs` (esbuild). Loaded from
 * newtab.html before sync.js/app.js. Exposes `window.AUTH` — the guarded hook
 * every other module talks to. Never throws: a missing/invalid publishable key
 * or a failed Clerk load must never break the grid.
 *
 * Contract consumed by app.js / sync.js:
 *   AUTH.ready      bool                — true once the client finished loading (even on failure)
 *   AUTH.enabled    bool                — a publishable key is configured in js/config.js
 *   AUTH.isSignedIn bool
 *   AUTH.user       {id,email,name,imageUrl} | null
 *   AUTH.getToken() Promise<string|null>  — session JWT for the worker (Authorization: Bearer)
 *   AUTH.signIn()   opens Clerk's sign-in popup
 *   AUTH.signOut()  signs out, returns to the new tab
 *   AUTH.onChange(fn) subscribe — fn(snapshot) fires immediately with the
 *                                 current state, then on every auth change
 *
 * Store-review note: Clerk is bundled here (esbuild), so no remote code ever
 * runs — only the session data flows to Clerk's servers.
 */
import { createClerkClient } from '@clerk/chrome-extension/client';

var CONFIG = window.CONFIG || {};
var KEY = String(CONFIG.publishableKey || '');
var HOME = chrome.runtime.getURL('newtab.html');

var clerk = null;
var listeners = [];

var api = {
  ready: false,
  enabled: !!KEY,
  isSignedIn: false,
  user: null,
  getToken: function () { return Promise.resolve(null); },
  signIn: function () {},
  signOut: function () { return Promise.resolve(); },
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
  var u = clerk && clerk.user;
  var email = '';
  if (u) {
    email = (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) || '';
    if (!email && u.emailAddresses && u.emailAddresses.length) {
      email = u.emailAddresses[0].emailAddress || '';
    }
  }
  return {
    ready: api.ready,
    enabled: api.enabled,
    isSignedIn: !!(clerk && clerk.session),
    user: u ? {
      id: u.id || '',
      email: email,
      name: u.fullName || u.username || '',
      imageUrl: u.imageUrl || ''
    } : null
  };
}

function emit() {
  var s = snapshot();
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](s); } catch (e) { /* a listener must never break the loop */ }
  }
}

window.AUTH = api;

if (!KEY) {
  /* no publishable key configured — sync stays off, grid fully local */
  api.ready = true;
  emit();
} else {
  try {
    clerk = createClerkClient({ publishableKey: KEY });
  } catch (e) {
    api.ready = true;
    emit();
    throw e;
  }

  clerk.addListener(function () { emit(); });

  /* chrome-extension: must be an allowed redirect protocol so the OAuth
     popup can land back on newtab.html (Clerk dashboard: allowed_origins
     must also include chrome-extension://<this extension's id>) */
  clerk.load({
    allowedRedirectProtocols: ['chrome-extension:'],
    afterSignOutUrl: HOME,
    signInForceRedirectUrl: HOME,
    signUpForceRedirectUrl: HOME
  }).then(function () {
    api.getToken = function () {
      return clerk && clerk.session ? clerk.session.getToken() : Promise.resolve(null);
    };
    api.signIn = function () { clerk.openSignIn({}); };
    api.signOut = function () { return clerk.signOut({ redirectUrl: HOME }); };
    api.ready = true;
    emit();
  }).catch(function () {
    api.ready = true;
    emit();
  });
}
