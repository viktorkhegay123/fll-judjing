// Локальный запуск (ноутбук / Wi-Fi): node local-server.js
// На Vercel этот файл не используется — там работает api/index.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createStore } = require('./lib/store');
const { createApi } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const store = createStore();
const api = createApi(store);

if (!process.env.ORG_CODE) console.warn('ВНИМАНИЕ: ORG_CODE не задан, код организатора по умолчанию "fll-admin".');
const bye = () => { store.flush?.(); process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let f = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (url.pathname === '/' || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return api(req, res);
  serveStatic(req, res, url);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`\nFLL Judging запущен (хранилище: ${store.kind})`);
  console.log(`  Этот компьютер:    http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  Для судей (Wi-Fi): http://${a.address}:${PORT}`);
  console.log(`  Код организатора:  ${process.env.ORG_CODE || 'fll-admin'}\n`);
});
