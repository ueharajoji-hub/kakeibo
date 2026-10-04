// ============================================================
// sw.js — オフラインで動かすためのキャッシュ
//
// sql.js の wasm も一緒に取り込む。これを入れておかないと
// 圏外のときに DB が開けない。
// ============================================================
var CACHE = 'kakeibo-v5';

var ASSETS = [
  './',
  './index.html',
  './style.css',
  './db.js',
  './repo.js',
  './app.js',
  './manifest.webmanifest',
  './icon-180.png',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm'
];

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 1つ落ちても install 自体は成功させる（アイコン等の欠けで詰まらせない）
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(new Request(url, { mode: 'cors' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// キャッシュ優先。裏で取り直して次回に備える。
self.addEventListener('fetch', function (ev) {
  if (ev.request.method !== 'GET') return;
  ev.respondWith(
    caches.match(ev.request).then(function (hit) {
      var fetched = fetch(ev.request).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(ev.request, copy); });
        }
        return res;
      });
      return hit || fetched;
    }).catch(function () { return fetch(ev.request); })
  );
});
