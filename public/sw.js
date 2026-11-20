const SHELL_CACHE = 'kokona-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/hls.min.js',
  '/index.json',
  '/manifest.json',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE)

      .then(function (c) { return Promise.all(SHELL_ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

const CACHEABLE = /^\/(hls\.min\.js|index\.json|manifest\.json|favicon[^/]*\.png|icon-\d+\.png)$/;

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  var isDoc = req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  if (isDoc) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put('/index.html', copy); });
        }
        return res;
      }).catch(function () {
        return caches.match('/index.html').then(function (m) {
          return m || new Response('离线', { status: 503 });
        });
      })
    );
    return;
  }

  if (!CACHEABLE.test(url.pathname)) return;

  e.respondWith(
    caches.open(SHELL_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok) c.put(req, res.clone());
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      });
    })
  );
});
