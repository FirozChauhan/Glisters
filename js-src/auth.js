/**
 * GLISTERS — In-extension auth (Clerk raw API, no ClerkJS, no hosted page redirects)
 *
 * Loaded from newtab.html before sync.js/app.js. Exposes `window.AUTH` — the
 * guarded hook every other module talks to. Never throws: a missing/invalid
 * publishable key never breaks the grid.
 *
 * HOW IT WORKS:
 *   Clerk's API rejects OAuth for extension clients (proven on both test and
 *   production instances; see AGENTS.md §3.9), but password-based sign-in and
 *   email-code sign-up work via raw REST calls if we carry a "dev browser
 *   token" (minted by POST /v1/dev_browser) as a URL query parameter on every
 *   request. This is exactly what ClerkJS does internally in dev mode.
 *
 *   Sign-in:  POST /v1/client/sign_ins  {identifier, password}
 *   Sign-up:  POST /v1/client/sign_ups  {strategy:"email_code", email_address, captchaToken, captchaWidgetType}
 *             → email code → attempt_verification → PATCH password → complete
 *
 *   The session JWT (last_active_token) is stored in chrome.storage.local
 *   and reused across reloads. The dev browser token is also cached.
 *
 *   Turnstile (Cloudflare CAPTCHA) is required for sign-up. The widget is
 *   rendered in the extension page via script loaded from challenges.cloudflare.com.
 *   The CSP in manifest.json already allows this.
 *
 * Contract consumed by app.js / sync.js:
 *   AUTH.ready      bool                      — true once boot resolved
 *   AUTH.enabled    bool                      — a publishable key is configured
 *   AUTH.isSignedIn bool                      — we have a valid session JWT
 *   AUTH.user       {id,email,name,imageUrl} | null
 *   AUTH.getToken() Promise<string|null>      — session JWT for the worker
 *   AUTH.signIn(el) opens the auth overlay
 *   AUTH.unmountSignIn(el)  cleans up the sign-in container
 *   AUTH.signOut()  revokes the session on the server + clears local state
 *   AUTH.onChange(fn) subscribe — fires immediately then on every auth change
 */
(function () {
  'use strict';

  var CONFIG = window.CONFIG || {};
  var KEY = String(CONFIG.publishableKey || '');

  /* ---- derive the Clerk frontend API domain from the publishable key ---- */
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
    /* legacy override */
    return String(CONFIG.clerkProxyUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }

  var FRONTEND = deriveFrontendApi(); /* e.g. tidy-marmoset-1299.clerk.accounts.dev */
  var API = 'https://' + FRONTEND;    /* the Clerk frontend API base */
  var DBJWT_KEY = 'glisters-db-jwt';  /* chrome.storage key for dev browser token */
  var AUTH_KEY  = 'glisters-auth';    /* chrome.storage key for session auth */
  var TURNSTILE_SITEKEY = '0x4AAAAAAAWXJGBD7bONzLBd'; /* fallback; overridden from /v1/environment */

  var listeners = [];
  var dbJwt = null;                 /* in-memory dev browser token */
  var authStore = { jwt: null, sid: null, exp: 0, email: null };  /* in-memory session */
  var captchaToken = null;          /* latest Turnstile token */
  var captchaWidgetId = null;       /* Turnstile widget id */
  var turnstileLoaded = false;      /* script loaded */
  var turnstileSiteKey = TURNSTILE_SITEKEY;
  var signUpId = null;              /* current sign-up id (during sign-up flow) */
  var verifyEmail = null;           /* email being verified */
  var _tempPassword = null;         /* password temporarily stored during sign-up flow */

  /* ---- UI element refs (populated on first openOverlay) ---- */
  var overlay, closeBtn, tabSignIn, tabSignUp;
  var signInForm, signUpForm, verifyForm;
  var signInEmail, signInPass, signInSubmit;
  var signUpEmail, signUpPass, signUpConfirm, signUpSubmit, captchaEl;
  var verifyCode, verifySubmit, verifyEmailEl;
  var authError, authNote;

  var api = {
    ready: false,
    enabled: !!KEY && !!FRONTEND,
    isSignedIn: false,
    user: null,
    getToken: function () {
      /* return the current session JWT, refreshing if needed */
      if (authStore.jwt && Date.now() < authStore.exp - 60000) {
        return Promise.resolve(authStore.jwt);
      }
      if (authStore.jwt && authStore.sid) {
        return refreshToken().then(function () { return authStore.jwt; });
      }
      return Promise.resolve(authStore.jwt || null);
    },
    signIn: function (el) {
      if (el) {
        el.innerHTML = '';
        el.hidden = true; /* we use the overlay instead */
      }
      openOverlay();
    },
    unmountSignIn: function (el) {
      if (el) { el.innerHTML = ''; el.hidden = true; }
      closeOverlay();
    },
    signOut: function () {
      var jwt = authStore.jwt;
      clearAuth();
      api.isSignedIn = false;
      api.user = null;
      emit();
      if (jwt && FRONTEND) {
        fetch(API + '/v1/client/sessions', {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + jwt }
        }).catch(function () {});
      }
      return Promise.resolve();
    },
    onChange: function (fn) {
      listeners.push(fn);
      emit();
      return function () {
        listeners = listeners.filter(function (l) { return l !== fn; });
      };
    }
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
      try { listeners[i](s); } catch (e) { /* swallow */ }
    }
  }

  /* ===== storage helpers (chrome.storage.local + localStorage) ===== */

  function storeGet(key, cb) {
    var localVal = null;
    try { localVal = JSON.parse(localStorage.getItem(key)); } catch (e) {}
    try {
      chrome.storage.local.get(key, function (result) {
        var extVal = result && result[key];
        /* prefer chrome.storage.local (durable) over localStorage (fast) */
        cb(extVal !== undefined ? extVal : localVal);
      });
    } catch (e) {
      cb(localVal);
    }
  }

  function storeSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
    try {
      var obj = {};
      obj[key] = val;
      chrome.storage.local.set(obj);
    } catch (e) {}
  }

  function storeRemove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
    try { chrome.storage.local.remove(key); } catch (e) {}
  }

  /* ===== dev browser token ===== */

  function fetchDbJwt() {
    return fetch(API + '/v1/dev_browser', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var t = d && d.token;
        if (!t) throw new Error('dev browser token not found in response');
        dbJwt = t;
        storeSet(DBJWT_KEY, t);
        return t;
      });
  }

  function ensureDbJwt() {
    if (dbJwt) return Promise.resolve(dbJwt);
    return new Promise(function (resolve) {
      storeGet(DBJWT_KEY, function (stored) {
        if (stored) { dbJwt = stored; resolve(stored); }
        else { fetchDbJwt().then(resolve, resolve); } /* resolve on error too — callers will get 401 */
      });
    });
  }

  /* ===== raw API call with dev browser token ===== */

  function apiFetch(path, opts) {
    opts = opts || {};
    return ensureDbJwt().then(function (token) {
      var url = API + path + '?__clerk_db_jwt=' + encodeURIComponent(token || '');
      return fetch(url, {
        method: opts.method || 'GET',
        headers: opts.headers || { 'Content-Type': 'application/json' },
        body: opts.body || undefined
      });
    });
  }

  /* ===== Session auth persistence ===== */

  function persistAuth(jwt, sid, email) {
    authStore.jwt = jwt;
    authStore.sid = sid;
    authStore.email = email;
    /* extract exp from the JWT payload */
    try {
      var payload = JSON.parse(atob(jwt.split('.')[1]));
      authStore.exp = payload.exp ? payload.exp * 1000 : 0;
    } catch (e) {
      authStore.exp = 0;
    }
    storeSet(AUTH_KEY, { jwt: jwt, sid: sid, exp: authStore.exp, email: email });
  }

  function clearAuth() {
    authStore.jwt = null;
    authStore.sid = null;
    authStore.exp = 0;
    authStore.email = null;
    storeRemove(AUTH_KEY);
  }

  function loadAuth() {
    return new Promise(function (resolve) {
      storeGet(AUTH_KEY, function (stored) {
        if (stored && stored.jwt) {
          authStore.jwt = stored.jwt;
          authStore.sid = stored.sid || null;
          authStore.exp = stored.exp || 0;
          authStore.email = stored.email || null;
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  function refreshToken() {
    if (!authStore.jwt || !authStore.sid) return Promise.reject(new Error('no session'));
    return fetch(API + '/v1/client/sessions/' + authStore.sid + '/tokens?__clerk_db_jwt=' + encodeURIComponent(dbJwt || ''), {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + authStore.jwt }
    }).then(function (r) {
      if (!r.ok) return Promise.reject(new Error('refresh failed'));
      return r.json();
    }).then(function (d) {
      var jwt = d && (d.jwt || (d.response && d.response.jwt));
      if (!jwt) throw new Error('no jwt in refresh response');
      persistAuth(jwt, authStore.sid, authStore.email);
      api.isSignedIn = true;
      emit();
      return jwt;
    }).catch(function (err) {
      /* session expired or revoked — clear */
      clearAuth();
      api.isSignedIn = false;
      api.user = null;
      emit();
      throw err;
    });
  }

  /* ===== fetch user info ===== */

  function fetchUser(jwt) {
    return fetch(API + '/v1/me', {
      headers: { 'Authorization': 'Bearer ' + jwt }
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

  /* ===== fetch Turnstile sitekey from environment ===== */

  function fetchSiteKey() {
    return fetch(API + '/v1/environment').then(function (r) { return r.json(); })
      .then(function (d) {
        var dc = (d && d.response && d.response.display_config) || (d && d.display_config);
        if (dc && dc.captcha_public_key) {
          turnstileSiteKey = dc.captcha_public_key;
        }
      }).catch(function () { /* keep fallback */ });
  }

  /* ===== Turnstile captcha ===== */

  function loadTurnstile() {
    if (turnstileLoaded) return Promise.resolve();
    if (window.turnstile) { turnstileLoaded = true; return Promise.resolve(); }
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = function () { turnstileLoaded = true; resolve(); };
      s.onerror = function () { resolve(); }; /* fail soft */
      document.head.appendChild(s);
    });
  }

  function renderTurnstile() {
    if (captchaWidgetId !== null) return; /* already rendered */
    if (!window.turnstile || !captchaEl) return;
    /* wait for the element to be visible */
    captchaWidgetId = window.turnstile.render(captchaEl, {
      sitekey: turnstileSiteKey,
      callback: function (token) { captchaToken = token; },
      'expired-callback': function () { captchaToken = null; },
      'error-callback': function () { captchaToken = null; }
    });
  }

  function destroyTurnstile() {
    if (captchaWidgetId !== null && window.turnstile) {
      window.turnstile.remove(captchaWidgetId);
    }
    captchaWidgetId = null;
    captchaToken = null;
  }

  function getCaptchaToken() {
    if (captchaToken) return Promise.resolve(captchaToken);
    /* trigger the widget explicitly */
    if (window.turnstile && captchaWidgetId !== null) {
      window.turnstile.execute(captchaWidgetId);
    }
    /* wait up to 30s for a callback */
    return new Promise(function (resolve, reject) {
      var waited = 0;
      var interval = setInterval(function () {
        waited += 200;
        if (captchaToken) {
          clearInterval(interval);
          resolve(captchaToken);
        } else if (waited >= 30000) {
          clearInterval(interval);
          reject(new Error('CAPTCHA timeout'));
        }
      }, 200);
    });
  }

  /* ===== sign-in ===== */

  function doSignIn(email, password) {
    return apiFetch('/v1/client/sign_ins', {
      method: 'POST',
      body: JSON.stringify({ identifier: email, password: password })
    }).then(function (r) { return r.json(); }).then(function (d) {
      var resp = d.response || d;
      if (d.errors && d.errors.length) {
        throw new Error(d.errors[0].long_message || d.errors[0].message || 'Sign-in failed');
      }
      if (resp.status === 'complete') {
        return extractSession(d);
      }
      if (resp.status === 'needs_first_factor') {
        /* two-step flow: prepare first factor with password */
        return apiFetch('/v1/client/sign_ins/' + resp.id + '/prepare_first_factor', {
          method: 'POST',
          body: JSON.stringify({ strategy: 'password', password: password })
        }).then(function (r2) { return r2.json(); }).then(function (d2) {
          var r2resp = d2.response || d2;
          if (d2.errors && d2.errors.length) {
            throw new Error(d2.errors[0].long_message || d2.errors[0].message || 'Sign-in failed');
          }
          if (r2resp.status === 'complete') {
            return extractSession(d2);
          }
          throw new Error('Sign-in returned unexpected status: ' + r2resp.status);
        });
      }
      if (resp.status === 'needs_identifier') {
        throw new Error('No account for that email. Try signing up.');
      }
      throw new Error('Sign-in returned unexpected status: ' + resp.status);
    });
  }

  function extractSession(d) {
    var client = d.client || (d.response && d.response.client) || {};
    var sessions = client.sessions || [];
    if (!sessions.length) {
      /* sometimes the session is nested deeper — check the sign-in's created_session_id */
      var resp = d.response || d;
      if (resp.created_session_id) {
        return apiFetch('/v1/client/sessions/' + resp.created_session_id).then(function (r) { return r.json(); })
          .then(function (sd) {
            var sess = sd.response || sd;
            if (!sess || !sess.id) throw new Error('No session found');
            var jwt = sess.last_active_token;
            if (jwt && typeof jwt === 'object') jwt = jwt.jwt || null;
            if (!jwt) throw new Error('No session token');
            return finishSession(sess, jwt);
          });
      }
      throw new Error('No session returned');
    }
    var sess = sessions[0];
    var jwt = sess.last_active_token;
    /* last_active_token can be a string or an object with jwt */
    if (jwt && typeof jwt === 'object') jwt = jwt.jwt || (jwt.getRawString && jwt.getRawString()) || null;
    if (!jwt) throw new Error('No session token returned');
    return finishSession(sess, jwt);
  }

  function finishSession(sess, jwt) {
    persistAuth(jwt, sess.id, '');
    api.isSignedIn = true;
    emit();
    return fetchUser(jwt).then(function (u) {
      api.user = u;
      emit();
      closeOverlay();
      return true;
    });
  }

  /* ===== sign-up ===== */

  function doSignUp(email, password) {
    return getCaptchaToken().then(function (captcha) {
      return apiFetch('/v1/client/sign_ups', {
        method: 'POST',
        body: JSON.stringify({
          strategy: 'email_code',
          email_address: email,
          captchaToken: captcha,
          captchaWidgetType: 'smart'
        })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.errors && d.errors.length) {
        throw new Error(d.errors[0].long_message || d.errors[0].message || 'Sign-up failed');
      }
      var resp = d.response || d;
      signUpId = resp.id;
      verifyEmail = email;
      /* make sure the email code is sent (create may not auto-send it) */
      return apiFetch('/v1/client/sign_ups/' + signUpId + '/prepare_verification', {
        method: 'POST',
        body: JSON.stringify({ strategy: 'email_code' })
      }).then(function (r2) { return r2.json(); }).then(function (d2) {
        if (d2.errors && d2.errors.length) {
          /* non-fatal: some setups auto-send the code on create */
          if (d2.errors[0].code !== 'verification_already_sent') {
            throw new Error(d2.errors[0].long_message || d2.errors[0].message || 'Failed to send code');
          }
        }
        showVerifyForm(email);
        return true;
      });
    });
  }

  /* ===== UI: auth overlay ===== */

  function cacheElements() {
    overlay = document.getElementById('authOverlay');
    closeBtn = document.getElementById('authClose');
    tabSignIn = document.getElementById('authTabSignIn');
    tabSignUp = document.getElementById('authTabSignUp');
    signInForm = document.getElementById('authSignInForm');
    signUpForm = document.getElementById('authSignUpForm');
    verifyForm = document.getElementById('authVerifyForm');
    signInEmail = document.getElementById('authSignInEmail');
    signInPass = document.getElementById('authSignInPassword');
    signInSubmit = document.getElementById('authSignInSubmit');
    signUpEmail = document.getElementById('authSignUpEmail');
    signUpPass = document.getElementById('authSignUpPassword');
    signUpConfirm = document.getElementById('authSignUpConfirm');
    signUpSubmit = document.getElementById('authSignUpSubmit');
    captchaEl = document.getElementById('authCaptcha');
    verifyCode = document.getElementById('authVerifyCode');
    verifySubmit = document.getElementById('authVerifySubmit');
    verifyEmailEl = document.getElementById('authVerifyEmail');
    authError = document.getElementById('authError');
    authNote = document.getElementById('authNote');
  }

  function openOverlay() {
    if (!overlay) cacheElements();
    if (!overlay) return;
    overlay.hidden = false;
    showSignInForm();
    if (signInEmail) signInEmail.focus();
    /* ensure dev browser token is ready */
    ensureDbJwt().catch(function () {});
    /* fetch sitekey for Turnstile */
    fetchSiteKey();
  }

  function closeOverlay() {
    if (!overlay) return;
    overlay.hidden = true;
    signUpId = null;
    verifyEmail = null;
    destroyTurnstile();
    /* reset forms */
    if (signInForm) { signInForm.reset(); signInForm.hidden = false; }
    if (signUpForm) { signUpForm.reset(); signUpForm.hidden = true; }
    if (verifyForm) { verifyForm.reset(); verifyForm.hidden = true; }
    hideError();
    hideNote();
  }

  function showSignInForm() {
    if (signInForm) signInForm.hidden = false;
    if (signUpForm) signUpForm.hidden = true;
    if (verifyForm) verifyForm.hidden = true;
    if (tabSignIn) tabSignIn.className = 'auth-tab active';
    if (tabSignUp) tabSignUp.className = 'auth-tab';
    destroyTurnstile();
    hideError();
    hideNote();
  }

  function showSignUpForm() {
    if (signInForm) signInForm.hidden = true;
    if (signUpForm) signUpForm.hidden = false;
    if (verifyForm) verifyForm.hidden = true;
    if (tabSignIn) tabSignIn.className = 'auth-tab';
    if (tabSignUp) tabSignUp.className = 'auth-tab active';
    hideError();
    hideNote();
    /* load Turnstile and render */
    loadTurnstile().then(function () {
      renderTurnstile();
    });
  }

  function showVerifyForm(email) {
    if (signInForm) signInForm.hidden = true;
    if (signUpForm) signUpForm.hidden = true;
    if (verifyForm) verifyForm.hidden = false;
    if (verifyEmailEl) verifyEmailEl.textContent = email;
    if (tabSignIn) tabSignIn.className = 'auth-tab';
    if (tabSignUp) tabSignUp.className = 'auth-tab active';
    destroyTurnstile();
    captchaToken = null; /* reset so sign-up step 2 can re-acquire */
    hideError();
    hideNote();
    showNote('A verification code was sent to ' + email + '.');
    setTimeout(function () { if (verifyCode) verifyCode.focus(); }, 100);
  }

  function showError(msg) {
    if (authError) {
      authError.textContent = msg;
      authError.hidden = false;
    }
  }

  function hideError() {
    if (authError) { authError.textContent = ''; authError.hidden = true; }
  }

  function showNote(msg) {
    if (authNote) {
      authNote.textContent = msg;
      authNote.hidden = false;
    }
  }

  function hideNote() {
    if (authNote) { authNote.textContent = ''; authNote.hidden = true; }
  }

  function setBusy(form, busy) {
    var submit = form && form.querySelector('.auth-submit');
    if (submit) submit.disabled = busy;
  }

  /* ===== wire form events ===== */

  function wireForms() {
    if (!overlay) cacheElements();
    if (!overlay) return;

    /* tab switching */
    if (tabSignIn) tabSignIn.addEventListener('click', function () { showSignInForm(); });
    if (tabSignUp) tabSignUp.addEventListener('click', function () { showSignUpForm(); });

    /* close */
    if (closeBtn) closeBtn.addEventListener('click', closeOverlay);
    if (overlay) overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeOverlay();
    });

    /* close on Esc — stopPropagation so the grid's document handler (which
       would close the drawer / move focus) never sees it */
    if (overlay) overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        closeOverlay();
      }
    });

    /* sign-in form */
    if (signInForm) signInForm.addEventListener('submit', function (e) {
      e.preventDefault();
      hideError();
      var email = signInEmail.value.trim();
      var pass = signInPass.value;
      if (!email) { showError('Enter your email.'); return; }
      if (!pass) { showError('Enter your password.'); return; }
      setBusy(signInForm, true);
      doSignIn(email, pass).catch(function (err) {
        setBusy(signInForm, false);
        showError(err.message || 'Sign-in failed.');
      });
    });

    /* sign-up form */
    if (signUpForm) signUpForm.addEventListener('submit', function (e) {
      e.preventDefault();
      hideError();
      var email = signUpEmail.value.trim();
      var pass = signUpPass.value;
      var confirm = signUpConfirm.value;
      if (!email) { showError('Enter your email.'); return; }
      if (!pass) { showError('Choose a password (15+ characters).'); return; }
      if (pass.length < 15) { showError('Password must be at least 15 characters.'); return; }
      if (pass !== confirm) { showError('Passwords don\'t match.'); return; }
      setBusy(signUpForm, true);
      /* keep the password for the verification step */
      _tempPassword = pass;
      doSignUp(email, pass).catch(function (err) {
        setBusy(signUpForm, false);
        showError(err.message || 'Sign-up failed.');
      });
    });

    /* verification form */
    if (verifyForm) verifyForm.addEventListener('submit', function (e) {
      e.preventDefault();
      hideError();
      var code = verifyCode.value.trim();
      if (!code) { showError('Enter the verification code.'); return; }
      setBusy(verifyForm, true);
      /* complete verification + set password */
      var password = _tempPassword; _tempPassword = null;
      setPasswordAndComplete(code, password).catch(function (err) {
        setBusy(verifyForm, false);
        showError(err.message || 'Verification failed.');
      });
    });
  }

  /* ===== set password after email verification ===== */

  function setPasswordAndComplete(code, password) {
    if (!signUpId) return Promise.reject(new Error('No sign-up in progress'));
    /* step 1: verify email code — path is /client/sign_ups/{id}/attempt_verification */
    return apiFetch('/v1/client/sign_ups/' + signUpId + '/attempt_verification', {
      method: 'POST',
      body: JSON.stringify({ strategy: 'email_code', code: code })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.errors && d.errors.length) {
        throw new Error(d.errors[0].long_message || d.errors[0].message || 'Verification failed');
      }
      var resp = d.response || d;
      var verified = resp.status === 'verified' || (resp.verification && resp.verification.status === 'verified');
      if (!verified) {
        throw new Error('Email verification failed — try the code again.');
      }
      /* step 2: set password on the sign-up */
      return getCaptchaToken().then(function (captcha2) {
        return apiFetch('/v1/client/sign_ups/' + signUpId, {
          method: 'PATCH',
          body: JSON.stringify({
            strategy: 'password',
            password: password,
            captchaToken: captcha2,
            captchaWidgetType: 'smart'
          })
        });
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.errors && d.errors.length) {
        throw new Error(d.errors[0].long_message || d.errors[0].message || 'Failed to set password');
      }
      var resp = d.response || d;
      if (resp.status === 'complete' || (d.client && d.client.sessions && d.client.sessions.length)) {
        return extractSession(d);
      }
      /* sign-up not complete yet (rare) — surface what's missing */
      var missing = (resp.missing_fields || []).join(', ') || 'unknown requirements';
      throw new Error('Sign-up incomplete — missing: ' + missing);
    });
  }

  /* ===== boot ===== */

  window.AUTH = api;

  if (!KEY || !FRONTEND) {
    api.ready = true;
    emit();
    return;
  }

  /* boot sequence: load dev browser token + persisted auth → check session validity */
  function boot() {
    ensureDbJwt().then(function () {
      return loadAuth();
    }).then(function (hasStored) {
      if (hasStored && authStore.jwt) {
        /* try fetching user info to validate the session */
        return fetchUser(authStore.jwt).then(function (u) {
          if (u) {
            api.isSignedIn = true;
            api.user = u;
            api.ready = true;
            emit();
          } else {
            /* session token may be expired — try refreshing */
            if (authStore.sid) {
              return refreshToken().then(function () {
                return fetchUser(authStore.jwt);
              }).then(function (u2) {
                if (u2) {
                  api.isSignedIn = true;
                  api.user = u2;
                }
                api.ready = true;
                emit();
              }).catch(function () {
                clearAuth();
                api.ready = true;
                emit();
              });
            } else {
              clearAuth();
              api.ready = true;
              emit();
            }
          }
        });
      } else {
        api.ready = true;
        emit();
      }
    }).catch(function () {
      api.ready = true;
      emit();
    });
  }

  boot();

  /* wire forms lazily — first call to openOverlay will populate elements */
  setTimeout(function () {
    if (!overlay) cacheElements();
    if (overlay) wireForms();
  }, 0);
})();