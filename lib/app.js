// Вся логика API. Используется и локальным local-server.js, и функцией Vercel (api/index.js).
const crypto = require('crypto');
const FLL = require('../public/rubrics.js');

function createApi(store) {
  const ORG_CODE = process.env.ORG_CODE || 'fll-admin';
  const SECRET = process.env.SECRET || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || 'local-' + ORG_CODE;

  // ---------- утилиты ----------
  const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
  const sign = (uid) => uid + '.' + crypto.createHmac('sha256', SECRET).update(uid).digest('base64url');
  const verify = (tok) => {
    const [uid, sig] = String(tok || '').split('.');
    if (!uid || !sig) return null;
    const good = crypto.createHmac('sha256', SECRET).update(uid).digest('base64url');
    return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) ? uid : null;
  };
  const pubUser = (u) => u && ({ id: u.id, username: u.username, name: u.name, room: u.room, role: u.role });
  const teamKey = (n, room) => `${n}-${room}`;
  const schedOr = (s) => s || JSON.parse(JSON.stringify(FLL.DEFAULT_SCHEDULE));
  function teamInfo(schedule, key) {
    const [n, room] = String(key).split('-').map(Number);
    const slot = schedule.slots.find((s) => s.n === n);
    if (!slot || !(room >= 1 && room <= FLL.ROOMS)) return null;
    return { key, n, room, time: slot.time, team: slot.teams[room - 1] || '' };
  }
  // оценки вида {"1-2|uid": sc} → {"1-2": {uid: sc}}
  function groupScores(flat) {
    const out = {};
    for (const [k, v] of Object.entries(flat || {})) { const [key, uid] = k.split('|'); (out[key] ??= {})[uid] = v; }
    return out;
  }

  function send(res, code, obj) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(obj));
  }
  async function readBody(req) {
    if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    return new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }

  // ---------- таймер ----------
  const emptyTimer = () => ({ key: null, stage: 0, running: false, startedAt: null, acc: 0, seq: 0 });
  async function loadTimer(room, t) {
    t = t || emptyTimer();
    if (t.running) {
      const st = FLL.STAGES[t.stage];
      if (!st || t.acc + (Date.now() - t.startedAt) >= st.min * 60000) {
        // этап закончился — следующий этап ждёт «Старт»
        Object.assign(t, { running: false, acc: 0, startedAt: null, stage: Math.min(t.stage + 1, FLL.STAGES.length) });
        t.seq++; await store.putTimer(room, t);
      }
    }
    return t;
  }
  function timerAction(t, schedule, room, body) {
    const now = Date.now();
    switch (body.action) {
      case 'select': {
        const info = teamInfo(schedule, body.key);
        if (!info || info.room !== room) throw new Error('Неверная команда');
        Object.assign(t, { key: body.key, stage: 0, running: false, startedAt: null, acc: 0 });
        break;
      }
      case 'start':
        if (!t.key) throw new Error('Сначала выберите команду');
        if (t.stage >= FLL.STAGES.length) throw new Error('Сессия уже завершена');
        if (!t.running) { t.running = true; t.startedAt = now; }
        break;
      case 'pause':
        if (t.running) { t.acc += now - t.startedAt; t.running = false; t.startedAt = null; }
        break;
      case 'next':
        Object.assign(t, { stage: Math.min(t.stage + 1, FLL.STAGES.length), running: false, startedAt: null, acc: 0 });
        break;
      case 'prev':
        Object.assign(t, { stage: Math.max(t.stage - 1, 0), running: false, startedAt: null, acc: 0 });
        break;
      case 'reset':
        Object.assign(t, { running: false, startedAt: null, acc: 0 });
        break;
      default: throw new Error('Неизвестное действие');
    }
    t.seq++;
    return t;
  }

  // ---------- результаты ----------
  function judgeSummary(users, uid, sc) {
    const u = users[uid] || { name: '(удалён)', role: 'judge' };
    const ip = FLL.scoreRubric('ip', sc.ip), rd = FLL.scoreRubric('rd', sc.rd);
    return {
      id: uid, name: u.name, role: u.role,
      ip: ip.total, ipGear: ip.gear, ipFilled: ip.filled,
      rd: rd.total, rdGear: rd.gear, rdFilled: rd.filled,
      gear: ip.gear + rd.gear, awards: sc.awards || [],
    };
  }
  async function results(users) {
    const [schedule, flat] = await Promise.all([store.schedule().then(schedOr), store.allScores(FLL.ROOMS)]);
    const scores = groupScores(flat);
    const rows = [];
    for (const slot of schedule.slots) {
      for (let room = 1; room <= FLL.ROOMS; room++) {
        const key = teamKey(slot.n, room);
        const judges = Object.entries(scores[key] || {})
          .map(([uid, sc]) => judgeSummary(users, uid, sc))
          .filter((j) => j.ipFilled || j.rdFilled || j.awards.length)
          .sort((a, b) => ((a.role === 'head') === (b.role === 'head') ? 0 : a.role === 'head' ? -1 : 1));
        const n = Math.max(2, judges.length); // знаменатель: 2 судьи × 40 = 80
        const sum = (f) => judges.reduce((a, j) => a + j[f], 0);
        const ipSum = sum('ip'), rdSum = sum('rd'), gearSum = sum('gear');
        const awards = {};
        judges.forEach((j) => j.awards.forEach((a) => { awards[a] = (awards[a] || 0) + 1; }));
        rows.push({
          key, n: slot.n, room, time: slot.time, team: slot.teams[room - 1] || '',
          judges, ipSum, rdSum, gearSum, maxPerRubric: 40 * n, maxGear: 40 * n,
          ipPct: (ipSum / (40 * n)) * 25, rdPct: (rdSum / (40 * n)) * 25, cvPct: (gearSum / (40 * n)) * 25,
          awards, complete: judges.length >= 2 && judges.every((j) => j.ipFilled === 10 && j.rdFilled === 10),
        });
      }
    }
    return rows;
  }
  function csv(rows) {
    const f = (x) => (Math.round(x * 100) / 100).toString().replace('.', ',');
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const head = ['Команда', 'Время', 'Инновационный проект (из 25%)', 'Дизайн робота (из 25%)', 'Core Values (из 25%)', 'ИП + ДР (из 50%)',
      '№', 'Комната', 'ИП судья 1', 'ИП судья 2', 'ИП сумма', 'ДР судья 1', 'ДР судья 2', 'ДР сумма', 'Шестерёнки сумма', 'Номинации', 'Судьи'];
    const lines = [head.map(q).join(';')];
    for (const r of rows) {
      const j = r.judges;
      lines.push([r.team, r.time, f(r.ipPct), f(r.rdPct), f(r.cvPct), f(r.ipPct + r.rdPct),
        r.n, r.room, j[0]?.ip ?? '', j[1]?.ip ?? '', r.ipSum, j[0]?.rd ?? '', j[1]?.rd ?? '', r.rdSum, r.gearSum,
        Object.entries(r.awards).map(([k, c]) => `${(FLL.AWARDS.find((a) => a.key === k) || {}).title} (${c})`).join(', '),
        j.map((x) => x.name).join(', ')].map(q).join(';'));
    }
    return '﻿' + lines.join('\r\n');
  }

  // ---------- обработчик ----------
  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      let p = url.pathname;
      if (url.searchParams.get('__path')) p = '/api/' + url.searchParams.get('__path'); // после rewrite на Vercel
      const m = req.method;

      if (p === '/api/health') return send(res, 200, { ok: true, store: store.kind });

      if (p === '/api/register' && m === 'POST') {
        const b = await readBody(req);
        const username = String(b.username || '').trim().toLowerCase();
        const name = String(b.name || '').trim().slice(0, 80);
        const role = ['head', 'judge', 'org'].includes(b.role) ? b.role : null;
        const room = Number(b.room);
        if (!username || !name || String(b.password || '').length < 4) return send(res, 400, { error: 'Заполните имя, логин и пароль (мин. 4 символа)' });
        if (!role) return send(res, 400, { error: 'Выберите роль' });
        if (role === 'org' && b.orgCode !== ORG_CODE) return send(res, 403, { error: 'Неверный код организатора' });
        if (role !== 'org' && !(room >= 1 && room <= FLL.ROOMS)) return send(res, 400, { error: 'Выберите комнату' });
        const users = await store.users();
        if (Object.values(users).some((u) => u.username === username)) return send(res, 409, { error: 'Такой логин уже занят' });
        const id = crypto.randomUUID(), salt = crypto.randomBytes(16).toString('hex');
        const u = { id, username, name, role, room: role === 'org' ? null : room, salt, pass: hash(String(b.password), salt), createdAt: Date.now() };
        await store.putUser(u);
        return send(res, 200, { token: sign(id), user: pubUser(u) });
      }
      if (p === '/api/login' && m === 'POST') {
        const b = await readBody(req);
        const users = await store.users();
        const u = Object.values(users).find((x) => x.username === String(b.username || '').trim().toLowerCase());
        if (!u || hash(String(b.password || ''), u.salt) !== u.pass) return send(res, 401, { error: 'Неверный логин или пароль' });
        return send(res, 200, { token: sign(u.id), user: pubUser(u) });
      }

      // --- дальше только для вошедших ---
      const h = req.headers.authorization || '';
      const uid = verify(h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token'));
      const users = uid ? await store.users() : {};
      const me = uid && users[uid];
      if (!me) return send(res, 401, { error: 'Нужно войти' });

      if (p === '/api/logout' && m === 'POST') return send(res, 200, { ok: true });
      if (p === '/api/me' && m === 'GET') return send(res, 200, { user: pubUser(me) });
      if (p === '/api/schedule' && m === 'GET') return send(res, 200, { schedule: schedOr(await store.schedule()), rooms: FLL.ROOMS });

      if (p === '/api/state' && m === 'GET') {
        const room = me.role === 'org' ? Number(url.searchParams.get('room')) || 1 : me.room;
        const bundle = await store.roomBundle(room);
        const schedule = schedOr(bundle.schedule);
        const timer = await loadTimer(room, bundle.timer);
        const scores = groupScores(bundle.scores);
        const mine = {}, status = {};
        for (const s of schedule.slots) {
          const key = teamKey(s.n, room), sc = scores[key] || {};
          if (sc[me.id]) mine[key] = sc[me.id];
          status[key] = Object.entries(sc).map(([id, x]) => {
            const j = judgeSummary(users, id, x); return { name: j.name, role: j.role, ipFilled: j.ipFilled, rdFilled: j.rdFilled };
          });
        }
        return send(res, 200, { now: Date.now(), room, timer, mine, status, schedule });
      }
      if (p === '/api/timer' && m === 'POST') {
        if (me.role !== 'head' && me.role !== 'org') return send(res, 403, { error: 'Таймером управляет Head Judge' });
        const b = await readBody(req);
        const room = me.role === 'org' ? Number(b.room) : me.room;
        const [t0, schedule] = await Promise.all([store.timer(room), store.schedule().then(schedOr)]);
        const t = await loadTimer(room, t0);
        try { timerAction(t, schedule, room, b); } catch (e) { return send(res, 400, { error: e.message }); }
        await store.putTimer(room, t);
        return send(res, 200, { now: Date.now(), timer: t });
      }
      if (p === '/api/score' && m === 'PUT') {
        if (me.role === 'org') return send(res, 403, { error: 'Организатор не оценивает' });
        const b = await readBody(req);
        const info = teamInfo(schedOr(await store.schedule()), String(b.key || ''));
        if (!info || info.room !== me.room) return send(res, 400, { error: 'Команда не из вашей комнаты' });
        const ids = (rk) => new Set(FLL.RUBRICS.find((r) => r.key === rk).sections.flatMap((s) => s.rows.map((r) => r.id)));
        const clean = (o, set) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => set.has(k) && [1, 2, 3, 4].includes(Number(v))).map(([k, v]) => [k, Number(v)]));
        const txt = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.slice(0, 2000)]));
        const sc = {
          ip: clean(b.ip, ids('ip')), rd: clean(b.rd, ids('rd')), comments: txt(b.comments),
          awards: (b.awards || []).filter((a) => FLL.AWARDS.some((x) => x.key === a)),
          notes: String(b.notes || '').slice(0, 5000), updatedAt: Date.now(),
        };
        await store.putScore(info.room, info.key, me.id, sc);
        return send(res, 200, { ok: true, updatedAt: sc.updatedAt });
      }
      if (p === '/api/results' && m === 'GET') return send(res, 200, { rows: await results(users) });
      if (p === '/api/results.csv' && m === 'GET') {
        const body = csv(await results(users));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="fll-judging-results.csv"');
        return res.end(body);
      }
      if (p === '/api/schedule' && m === 'PUT') {
        if (me.role !== 'org') return send(res, 403, { error: 'Только организатор' });
        const b = await readBody(req);
        if (!Array.isArray(b.slots)) return send(res, 400, { error: 'Неверные данные' });
        const schedule = {
          slots: b.slots.map((s, i) => ({
            n: i + 1, time: String(s.time || '').slice(0, 40),
            teams: Array.from({ length: FLL.ROOMS }, (_, k) => String((s.teams || [])[k] || '').slice(0, 80)),
          })),
          breaks: Array.isArray(b.breaks) ? b.breaks.map((x) => ({ after: Number(x.after), label: String(x.label || '').slice(0, 80) })) : [],
        };
        await store.putSchedule(schedule);
        return send(res, 200, { schedule });
      }
      if (p === '/api/users' && m === 'GET') {
        if (me.role !== 'org') return send(res, 403, { error: 'Только организатор' });
        return send(res, 200, { users: Object.values(users).map(pubUser) });
      }
      if (p.startsWith('/api/users/') && m === 'DELETE') {
        if (me.role !== 'org') return send(res, 403, { error: 'Только организатор' });
        const id = p.split('/').pop();
        if (id === me.id) return send(res, 400, { error: 'Нельзя удалить себя' });
        await store.delUser(id);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Не найдено' });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'Ошибка сервера: ' + e.message });
    }
  };
}

module.exports = { createApi };
