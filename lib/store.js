// Хранилище: Upstash Redis (для Vercel) или локальный JSON-файл (для запуска на ноутбуке).
const fs = require('fs');
const path = require('path');

const parse = (v) => (v == null ? null : JSON.parse(v));
const flatToObj = (arr) => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = JSON.parse(arr[i + 1]); return o; };

function redisStore(url, token) {
  url = url.replace(/\/$/, '');
  async function pipe(cmds) {
    const r = await fetch(url + '/pipeline', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds),
    });
    if (!r.ok) throw new Error('Redis ' + r.status + ' ' + (await r.text()));
    const out = await r.json();
    return out.map((x) => { if (x.error) throw new Error('Redis: ' + x.error); return x.result; });
  }
  return {
    kind: 'redis',
    async users() { const [u] = await pipe([['HGETALL', 'fll:users']]); return flatToObj(u); },
    async putUser(u) { await pipe([['HSET', 'fll:users', u.id, JSON.stringify(u)]]); },
    async delUser(id) { await pipe([['HDEL', 'fll:users', id]]); },
    async timer(room) { const [t] = await pipe([['GET', 'fll:timer:' + room]]); return parse(t); },
    async putTimer(room, t) { await pipe([['SET', 'fll:timer:' + room, JSON.stringify(t)]]); },
    async schedule() { const [s] = await pipe([['GET', 'fll:schedule']]); return parse(s); },
    async putSchedule(s) { await pipe([['SET', 'fll:schedule', JSON.stringify(s)]]); },
    async putScore(room, key, uid, sc) { await pipe([['HSET', 'fll:scores:' + room, key + '|' + uid, JSON.stringify(sc)]]); },
    // одним запросом: таймер, расписание и оценки комнаты
    async roomBundle(room) {
      const [t, s, sc] = await pipe([['GET', 'fll:timer:' + room], ['GET', 'fll:schedule'], ['HGETALL', 'fll:scores:' + room]]);
      return { timer: parse(t), schedule: parse(s), scores: flatToObj(sc) };
    },
    async allScores(rooms) {
      const res = await pipe(Array.from({ length: rooms }, (_, i) => ['HGETALL', 'fll:scores:' + (i + 1)]));
      return Object.assign({}, ...res.map(flatToObj));
    },
  };
}

function fileStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = {}; }
  db.users ??= {}; db.timers ??= {}; db.scores ??= {}; db.schedule ??= null;
  let t = null;
  const save = () => { clearTimeout(t); t = setTimeout(flush, 150); };
  function flush() { clearTimeout(t); fs.writeFileSync(file + '.tmp', JSON.stringify(db, null, 1)); fs.renameSync(file + '.tmp', file); }
  const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
  const roomScores = (room) => Object.fromEntries(Object.entries(db.scores).filter(([k]) => k.split('|')[0].endsWith('-' + room)));
  return {
    kind: 'file', flush,
    async users() { return clone(db.users); },
    async putUser(u) { db.users[u.id] = clone(u); save(); },
    async delUser(id) { delete db.users[id]; save(); },
    async timer(room) { return clone(db.timers[room]); },
    async putTimer(room, tm) { db.timers[room] = clone(tm); save(); },
    async schedule() { return clone(db.schedule); },
    async putSchedule(s) { db.schedule = clone(s); save(); },
    async putScore(room, key, uid, sc) { db.scores[key + '|' + uid] = clone(sc); save(); },
    async roomBundle(room) { return { timer: clone(db.timers[room]), schedule: clone(db.schedule), scores: clone(roomScores(room)) }; },
    async allScores() { return clone(db.scores); },
  };
}

function createStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisStore(url, token);
  if (process.env.VERCEL) throw new Error('На Vercel не подключена база: добавьте Upstash Redis (Storage → Upstash for Redis).');
  return fileStore(process.env.DATA_FILE || path.join(__dirname, '..', 'data.json'));
}

module.exports = { createStore };
