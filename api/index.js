// Функция Vercel: все запросы /api/* попадают сюда (см. vercel.json).
const { createStore } = require('../lib/store');
const { createApi } = require('../lib/app');

let handler;
module.exports = async (req, res) => {
  try { handler ??= createApi(createStore()); }
  catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: e.message }));
  }
  return handler(req, res);
};
