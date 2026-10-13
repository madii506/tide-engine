// GET /api/tick   one engine pass: launches waiting on deposits, then every live coin (claim, size, pour, seal).
// Anyone may call it: it is locked so only one pass runs at a time, at most once every 50 seconds. Vercel Cron calls it
// every minute, a GitHub Actions schedule every five minutes as a backup, and visits to the site nudge it too.
const L = require('./_lib');
const E = require('./_engine');
module.exports = async (req, res) => {
  if (!L.dbReady()) return L.send(res, 200, { ok: false, error: 'engine offline: no database' });
  try { L.send(res, 200, await E.tick(Number(L.query(req).budget) > 0 ? Math.min(50000, Number(L.query(req).budget)) : 48000)); }
  catch (e) { L.send(res, 200, { ok: false, error: String(e && e.message).slice(0, 200) }); }
};
