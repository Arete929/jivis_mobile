/* 지비스 모바일 서비스워커 | @version 2.13.0
   화면(index.html · jd/index.html)은 서버 먼저, 안 되면 담아 둔 것. 나머지(아이콘·jd/js)는 담아 둔 것 먼저. 새 판이 나오면 스스로 바뀐다. */
var CACHE = 'jivis-v2.13.0';
var ROOT = new URL('./', self.location).pathname;
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
  var isRoot = url.pathname === ROOT || url.pathname === ROOT + 'index.html';
  if (isRoot || e.request.mode === 'navigate' || /\.html$/.test(url.pathname)) {
    /* 화면 문서 — 서버 먼저. 앱 첫 화면은 './index.html' 로, 그 밖의 문서(jd/index.html)는 제 주소로 담는다 */
    var key = isRoot ? new Request('./index.html') : e.request;
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) { var cl = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, cl); }); }
      return res;
    }).catch(function () { return caches.match(key).then(function (r) { return r || caches.match('./index.html'); }); }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (r) {
    return r || fetch(e.request).then(function (res) {
      if (res && res.ok) { var clone = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, clone); }); }
      return res;
    });
  }));
});
