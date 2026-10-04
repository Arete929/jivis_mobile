/* 지비스 모바일 서비스워커 | @version 1.0.0
   혜원이지 모바일과 같은 방식 — 화면(index.html)은 서버 먼저, 안 되면 담아 둔 것. 새 판이 나오면 스스로 바뀐다. */
var CACHE = 'jivis-v1.0.0';
var ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-512.png', './icon-192.png', './logo-256.png', './apple-touch-icon.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(ASSETS.map(function (u) { return fetch(new Request(u, { cache: 'reload' })).then(function (res) { if (res.ok) return c.put(u, res); }); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;   // 글꼴 등 남의 주소는 브라우저에 맡긴다
  if (e.request.mode === 'navigate' || url.pathname.slice(-1) === '/' || /\/index\.html$/.test(url.pathname)) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) { var cl = res.clone(); caches.open(CACHE).then(function (c) { c.put('./index.html', cl); }); }
      return res;
    }).catch(function () { return caches.match('./index.html'); }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (r) {
    return r || fetch(e.request).then(function (res) {
      if (res && res.ok) { var clone = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, clone); }); }
      return res;
    }).catch(function () { return caches.match('./index.html'); });
  }));
});
