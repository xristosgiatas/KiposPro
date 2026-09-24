/* KiposPro — αποθηκεύει την εφαρμογή στο κινητό ώστε να ανοίγει χωρίς σήμα.
   Άλλαξε το VERSION σε κάθε νέο ανέβασμα για να παίρνουν όλοι την ενημέρωση. */
var VERSION = 'kp-2026-09-24b';
var CORE = ['./', './index.html', './kp-api.js', './manifest.json', './icon-192.png', './icon-512.png', './icon-maskable.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k.indexOf('kp-') === 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Γραμματοσειρές: από την αποθήκη, ενημέρωση στο παρασκήνιο
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(swr(req, VERSION + '-fonts'));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Η σελίδα: ανοίγει ακαριαία από την αποθήκη, ενημερώνεται στο παρασκήνιο
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(VERSION).then(function (c) {
      return c.match('./index.html').then(function (hit) {
        var net = fetch(req).then(function (r) { if (r && r.ok) c.put('./index.html', r.clone()); return r; });
        return hit || net;
      });
    }));
    return;
  }
  e.respondWith(swr(req, VERSION));
});

function swr(req, cacheName) {
  return caches.open(cacheName).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (r) {
        if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
        return r;
      }).catch(function () { return hit; });
      return hit || net;
    });
  });
}
