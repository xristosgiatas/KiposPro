/* ============================================================
   KiposPro — αντάπτορας για την έκδοση GitHub Pages
   Μιμείται το google.script.run, ώστε ο κώδικας της εφαρμογής
   να μένει ίδιος. Προσθέτει:
   • επικοινωνία με το Apps Script μέσω doPost
   • τοπικό αντίγραφο δεδομένων για άνοιγμα χωρίς σήμα
   • ουρά αλλαγών που στέλνονται μόλις βρεθεί σήμα
   ============================================================ */
(function () {
  var API_URL = 'https://script.google.com/macros/s/AKfycbxAM8SSO5C7OL7dbaGApmaRKLSoBXduLZ1ejZK-h6T53Wj7qgPf8FN1RLjr5aa4l6OSmg/exec';

  var LS_TOKEN = 'kp_api_token', LS_CACHE = 'kp_cache_v1', LS_QUEUE = 'kp_queue_v1', LS_LOGIN = 'kp_last_login';
  var DATA_KEYS = ['clients','ektas','incomes','expenses','appointments','docs','supply','offers','visits','receipts','reports','schedule'];

  // Χρειάζονται πάντα σήμα — δεν μπαίνουν σε ουρά
  var ONLINE_ONLY = {
    uploadPhoto:1, uploadDocFile:1, getClientPhotos:1, getDocsFolderUrl:1,
    createQuotePdf:1, createReceipt:1, sendReceiptEmail:1, getNextReceiptNumber:1,
    getDrivingKm:1, getPortalLink:1, loadDesigns:1, resolveReport:1
  };
  var SLOW = { uploadPhoto:1, uploadDocFile:1, createQuotePdf:1, createReceipt:1, sendReceiptEmail:1, loadAll:1 };

  var KP_VERSION = '2026-09-24d';
  window.KP_WEB = true;
  window.KP_VERSION = KP_VERSION;

  function ls(k, v) {
    try {
      if (v === undefined) { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; }
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {}
    return null;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function netErr(msg) { var e = new Error(msg || 'Χωρίς σύνδεση'); e.network = true; return e; }

  /* ---------- δίκτυο ---------- */
  function kpLog(msg) {
    try {
      var L = ls('kp_log') || [];
      L.push(new Date().toLocaleTimeString('el-GR') + ' ' + msg);
      ls('kp_log', L.slice(-40));
    } catch (e) {}
  }
  window.kpLog = kpLog;

  function post1(fn, args, opId) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, SLOW[fn] ? 120000 : 45000);
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, args: args, token: ls(LS_TOKEN) || '', opId: opId || '' }),
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (txt) {
        try { return JSON.parse(txt); }
        catch (e) {
          var clean = String(txt || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
          var er = new Error('Η Google απάντησε με σφάλμα (' + r.status + '): ' + (clean || 'κενή απάντηση'));
          er.server = true; throw er;
        }
      });
    }, function (e) {
      clearTimeout(timer);
      throw netErr(e && e.name === 'AbortError' ? 'Αργή απάντηση — λήξη χρόνου' : 'Χωρίς σύνδεση' + (e && e.message ? ' (' + e.message + ')' : ''));
    });
  }

  // Ξαναδοκιμάζει μέχρι 2 φορές — το Apps Script έχει συχνά προσωρινά σφάλματα
  function post(fn, args, opId) {
    var tries = 0;
    function attempt() {
      tries++;
      return post1(fn, args, opId).then(function (res) {
        if (tries > 1) kpLog('✓ ' + fn + ' πέρασε στην ' + tries + 'η προσπάθεια');
        return res;
      }, function (e) {
        kpLog('✗ ' + fn + ' #' + tries + ': ' + e.message);
        if (tries < 3) return new Promise(function (ok) { setTimeout(ok, tries * 1500); }).then(attempt);
        throw e;
      });
    }
    return attempt();
  }

  // Νέο κλειδί με τα αποθηκευμένα στοιχεία, αν έληξε
  var _reauth = null;
  function reauth() {
    if (_reauth) return _reauth;
    var em = localStorage.getItem('kipospro_email'), pn = localStorage.getItem('kipospro_pin');
    if (!em || !pn) return Promise.reject(new Error('Συνδεθείτε ξανά'));
    _reauth = post('loginWithEmail', [em, pn]).then(function (res) {
      _reauth = null;
      if (res && res.ok && res.result && res.result.success && res.result.apiToken) {
        ls(LS_TOKEN, res.result.apiToken); return true;
      }
      throw new Error('Συνδεθείτε ξανά');
    }, function (e) { _reauth = null; throw e; });
    return _reauth;
  }

  function call(fn, args, opId) {
    return post(fn, args, opId).then(function (res) {
      if (res && res.auth === false) {
        return reauth().then(function () { return post(fn, args, opId); });
      }
      return res;
    }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || 'Σφάλμα');
      return res.result;
    });
  }

  /* ---------- τοπικό αντίγραφο ---------- */
  var _snapT = null;
  function snapshotSoon() {
    clearTimeout(_snapT);
    _snapT = setTimeout(snapshot, 400);
  }
  function snapshot() {
    var em = window._kpEmail || localStorage.getItem('kipospro_email') || '';
    if (!em) return;
    var base = ls(LS_CACHE);
    if (!base || base.email !== em) return;
    DATA_KEYS.forEach(function (k) { if (Array.isArray(window[k])) base.data[k] = window[k]; });
    base.savedAt = Date.now();
    ls(LS_CACHE, base);
  }
  function storeLoadAll(email, raw) {
    try {
      var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!data || data.error) return;
      ls(LS_CACHE, { email: email, data: data, savedAt: Date.now() });
    } catch (e) {}
  }

  /* ---------- ουρά ---------- */
  var _pending = {};          // opId -> {ok, fail, user}
  var _flushing = false;

  function queue() { return ls(LS_QUEUE) || []; }
  function setQueue(q) { ls(LS_QUEUE, q); badge(); }

  function enqueue(fn, args) {
    var op = { opId: uid(), fn: fn, args: args, t: Date.now() };
    var q = queue(); q.push(op); setQueue(q);
    return op;
  }

  function flush() {
    if (_flushing) return Promise.resolve();
    var q = queue();
    if (!q.length) return Promise.resolve();
    _flushing = true; badge();
    var synced = 0;
    function next() {
      var q2 = queue();
      if (!q2.length) return Promise.resolve();
      var op = q2[0];
      return call(op.fn, op.args, op.opId).then(function (result) {
        setQueue(queue().filter(function (x) { return x.opId !== op.opId; }));
        synced++;
        var cb = _pending[op.opId]; delete _pending[op.opId];
        if (cb && cb.ok) try { cb.ok(result, cb.user); } catch (e) {}
        return next();
      }, function (err) {
        if (err && (err.network || err.server)) throw err;          // σταματάμε, ξαναδοκιμάζουμε αργότερα
        // σφάλμα εφαρμογής: η αλλαγή απορρίφθηκε — τη βγάζουμε για να μην κολλήσει η ουρά
        setQueue(queue().filter(function (x) { return x.opId !== op.opId; }));
        var cb = _pending[op.opId]; delete _pending[op.opId];
        if (cb && cb.fail) try { cb.fail(err, cb.user); } catch (e) {}
        else kpNote('⚠ Δεν αποθηκεύτηκε: ' + op.fn + ' — ' + err.message, true);
        return next();
      });
    }
    return next().then(function () {
      _flushing = false; badge();
      if (synced) kpNote('✓ Συγχρονίστηκαν ' + synced + ' αλλαγ' + (synced === 1 ? 'ή' : 'ές'));
    }, function () { _flushing = false; badge(); });
  }

  /* ---------- δρομολόγηση κλήσεων ---------- */
  function run(fn, args, ok, fail, user) {
    ok = ok || function () {}; 
    var failCb = fail || function (e) { console.warn('[KP]', fn, e && e.message); };

    if (fn === 'loginWithEmail') {
      var em = String(args[0] || '').toLowerCase().trim();
      var last0 = ls(LS_LOGIN);
      var fast = last0 && last0.email === em && last0.pin === String(args[1] || '') && ls(LS_TOKEN);
      if (fast) {
        // Άμεση είσοδος — ο έλεγχος συνδρομής γίνεται στο παρασκήνιο
        ok(last0.result, user);
        call(fn, args).then(function (r) {
          if (r && r.success) {
            if (r.apiToken) ls(LS_TOKEN, r.apiToken);
            var c2 = {}; for (var k2 in r) if (k2 !== 'apiToken') c2[k2] = r[k2];
            ls(LS_LOGIN, { email: em, pin: String(args[1] || ''), result: c2 });
            setOffline(false);
          } else if (r && r.success === false) {
            // λήξη / απενεργοποίηση / άλλαξε το PIN
            ls(LS_LOGIN, null); ls(LS_TOKEN, null);
            localStorage.removeItem('kipospro_email'); localStorage.removeItem('kipospro_pin');
            alert(r.error || 'Συνδεθείτε ξανά');
            location.reload();
          }
        }, function (e) { if (e.network) setOffline(true); });
        return;
      }
      call(fn, args).then(function (r) {
        if (r && r.success) {
          if (r.apiToken) ls(LS_TOKEN, r.apiToken);
          var copy = {}; for (var k in r) if (k !== 'apiToken') copy[k] = r[k];
          ls(LS_LOGIN, { email: em, pin: String(args[1] || ''), result: copy });
        }
        ok(r, user);
      }, function (e) {
        var last = ls(LS_LOGIN);
        if ((e.network || e.server) && last && last.email === em && last.pin === String(args[1] || '')) {
          setOffline(!!e.network); ok(last.result, user);
        } else failCb(e, user);
      });
      return;
    }

    if (fn === 'loadAll') {
      var email = args[0];
      var useCache = function (e) {
        var c = ls(LS_CACHE);
        if (c && c.email === email) {
          setOffline(!!(e && e.network));
          if (e && e.server) kpNote('⚠ Η Google δεν απάντησε — δείχνω τα αποθηκευμένα', true);
          ok(c.data, user); return true;
        }
        return false;
      };
      // Αν υπάρχει αντίγραφο: δείξε το αμέσως, φέρε τα νέα στο παρασκήνιο
      var cached = ls(LS_CACHE);
      if (cached && cached.email === email) {
        ok(cached.data, user);
        var before = '';
        try { before = JSON.stringify(cached.data); } catch (x) {}
        flush().then(function () {
          return call('loadAll', args);
        }).then(function (raw) {
          setOffline(false);
          storeLoadAll(email, raw);
          var fresh = typeof raw === 'string' ? raw : JSON.stringify(raw);
          if (fresh !== before && !queue().length) ok(raw, user);
        }, function (e) {
          if (e.network) setOffline(true);
          else if (e.server) kpNote('⚠ Η Google δεν απάντησε — δείχνω τα αποθηκευμένα', true);
        });
        return;
      }
      // πρώτα στέλνουμε ό,τι περιμένει, μετά φέρνουμε τα νέα δεδομένα
      flush().then(function () {
        return call('loadAll', args);
      }).then(function (raw) {
        setOffline(false);
        storeLoadAll(email, raw);
        ok(raw, user);
      }, function (e) {
        if (!((e.network || e.server) && useCache(e))) failCb(e, user);
      });
      return;
    }

    if (ONLINE_ONLY[fn]) {
      call(fn, args).then(function (r) { setOffline(false); ok(r, user); }, function (e) {
        if (e.network) { setOffline(true); failCb(new Error('Χρειάζεται σύνδεση στο internet'), user); }
        else failCb(e, user);
      });
      return;
    }

    // Αλλαγές δεδομένων: ουρά
    var op = enqueue(fn, args);
    snapshotSoon();
    if (isOffline()) {
      ok({ success: true, queued: true }, user);
      scheduleRetry();
      return;
    }
    _pending[op.opId] = { ok: ok, fail: fail, user: user };
    // Αν δεν απαντήσει γρήγορα, θεωρούμε ότι πέρασε — η ουρά θα το ολοκληρώσει
    var t = setTimeout(function () {
      var cb = _pending[op.opId];
      if (cb) { delete _pending[op.opId]; try { cb.ok({ success: true, queued: true }, cb.user); } catch (e) {} }
    }, 8000);
    flush().then(function () {
      clearTimeout(t);
      if (queue().some(function (x) { return x.opId === op.opId; })) {
        var cb = _pending[op.opId];
        if (cb) { delete _pending[op.opId]; try { cb.ok({ success: true, queued: true }, cb.user); } catch (e) {} }
        setOffline(true); scheduleRetry();
      } else setOffline(false);
    });
  }

  function runner(ok, fail, user) {
    var base = {
      withSuccessHandler: function (h) { return runner(h, fail, user); },
      withFailureHandler: function (h) { return runner(ok, h, user); },
      withUserObject: function (o) { return runner(ok, fail, o); }
    };
    return new Proxy(base, {
      get: function (t, k) {
        if (k in t) return t[k];
        if (typeof k !== 'string' || k === 'then') return undefined;
        return function () { run(k, Array.prototype.slice.call(arguments), ok, fail, user); };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  Object.defineProperty(window.google.script, 'run', { get: function () { return runner(); }, configurable: true });

  /* ---------- κατάσταση σήματος ---------- */
  var _offline = false;
  function isOffline() { return _offline; }
  function setOffline(v) { if (_offline !== v) { _offline = v; badge(); if (!v) flush(); } }

  var _retryT = null;
  function scheduleRetry() {
    if (_retryT) return;
    _retryT = setTimeout(function () {
      _retryT = null;
      if (!queue().length) return;
      post('ping', []).then(function () { setOffline(false); flush(); }, function () { scheduleRetry(); });
    }, 20000);
  }

  window.addEventListener('online', function () { setOffline(false); flush(); });
  window.addEventListener('offline', function () { setOffline(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && queue().length) flush();
    if (document.visibilityState === 'hidden') snapshot();
  });
  window.addEventListener('pagehide', snapshot);

  /* ---------- ένδειξη ---------- */
  var _pill = null, _noteT = null;
  function pill() {
    if (_pill || !document.body) return _pill;
    _pill = document.createElement('div');
    _pill.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 8px);'
      + 'z-index:99999;padding:7px 14px;border-radius:999px;font:600 12.5px/1.2 Inter,system-ui,sans-serif;'
      + 'box-shadow:0 4px 14px rgba(0,0,0,.18);display:none;align-items:center;gap:6px;white-space:nowrap;pointer-events:auto;cursor:pointer';
    _pill.onclick = function () {
      var L = ls('kp_log') || [];
      if (L.length && confirm('Να δεις τι έγινε;\n\n' + L.slice(-8).join('\n') + '\n\n(OK = ξαναδοκιμή)')) flush();
      else flush();
    };
    document.body.appendChild(_pill);
    return _pill;
  }
  function badge() {
    var p = pill(); if (!p) return;
    if (_noteT) return;
    var n = queue().length;
    if (_offline) {
      p.style.background = '#3a3a3a'; p.style.color = '#fff';
      p.textContent = '⚡ Χωρίς σήμα' + (n ? ' · ' + n + ' σε αναμονή' : '');
      p.style.display = 'flex';
    } else if (n) {
      p.style.background = '#FFF4DB'; p.style.color = '#7A5200';
      p.textContent = (_flushing ? '↻ Συγχρονισμός… ' : '↻ ') + n + ' σε αναμονή';
      p.style.display = 'flex';
    } else {
      p.style.display = 'none';
    }
  }
  function kpNote(msg, bad) {
    var p = pill(); if (!p) return;
    clearTimeout(_noteT);
    p.style.background = bad ? '#FDE2E2' : '#DDF3E6'; p.style.color = bad ? '#8A1C1C' : '#14532D';
    p.textContent = msg; p.style.display = 'flex';
    _noteT = setTimeout(function () { _noteT = null; badge(); }, bad ? 6000 : 2500);
  }
  document.addEventListener('DOMContentLoaded', function () {
    badge(); if (queue().length) flush();
    if (/[?&]diag\b/.test(location.search)) {
      var L = ls('kp_log') || [];
      alert('KiposPro ' + KP_VERSION + ' — τελευταία γεγονότα:\n\n' + (L.length ? L.join('\n') : '(κανένα)') + '\n\nΣε αναμονή: ' + queue().length);
    }
  });

  window.KP_SYNC = { flush: flush, queue: queue, snapshot: snapshot };

  /* ---------- service worker ---------- */
  if ('serviceWorker' in navigator) {
    // ?reset — σβήνει την αποθηκευμένη εφαρμογή (όχι τα δεδομένα) και φορτώνει από την αρχή
    if (/[?&]reset\b/.test(location.search)) {
      navigator.serviceWorker.getRegistrations().then(function (rs) {
        return Promise.all(rs.map(function (r) { return r.unregister(); }));
      }).then(function () {
        return window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }) : null;
      }).then(function () { location.replace(location.pathname); });
      return;
    }
    // Μόλις εγκατασταθεί νέα έκδοση, ξαναφορτώνει μία φορά για να την πάρει
    var hadCtrl = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadCtrl) return;
      if (sessionStorage.getItem('kp_sw_reloaded')) return;
      sessionStorage.setItem('kp_sw_reloaded', '1');
      snapshot();
      location.reload();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        try { reg.update(); } catch (e) {}
      }).catch(function () {});
    });
  }
})();
