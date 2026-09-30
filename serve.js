// ============================================================
// serve.js — 動作確認用の静的サーバ（依存ライブラリなし）
//
//   node serve.js
//
// 同じ Wi-Fi にいる iPhone からは、表示された
// http://192.168.x.x:8080 を Safari で開ける。
//
// ただし Service Worker と通知は http:// では動かない（localhost だけ例外）。
// iPhone で PWA として試すときは、GitHub Pages など https の置き場に上げること。
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm'
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'   // 開発中は毎回読み直す
    });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log('  http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list) {
      if (ni.family === 'IPv4' && !ni.internal) {
        console.log('  http://' + ni.address + ':' + PORT + '  (同じ Wi-Fi の iPhone から)');
      }
    }
  }
});
