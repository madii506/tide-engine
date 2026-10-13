// GET /api/stats · /api/coins?sort= · /api/coin?m= · /api/ledger   (all rewritten to /api/data?op=…)
// Read-only views of the engine's records plus the on-chain picture it keeps of every coin.
const L = require('./_lib');
const E = require('./_engine');

const SOLMINT = 'So11111111111111111111111111111111111111112';
async function solUsd() {
  return L.remember('solusd', 60000, async () => {
    if (L.MOCK && L.MOCK.solUsd) return L.MOCK.solUsd();
    try {
      const r = await L.getJson('https://api.dexscreener.com/tokens/v1/solana/' + SOLMINT, {}, 6000);
      const p = (Array.isArray(r.json) ? r.json : []).filter(x => x && x.baseToken && x.baseToken.address === SOLMINT && +x.priceUsd > 0)
        .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
      if (p) return +p.priceUsd;
    } catch {}
    const g = await L.getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {}, 6000);
    return (g.json && g.json.solana && +g.json.solana.usd) || null;
  }).catch(() => null);
}
const ms = d => (d ? new Date(d).getTime() : null);
const lam = v => +(Number(v || 0) / 1e9).toFixed(6);
function phaseOf(r) {
  if (r.state === 'waiting' || r.state === 'creating') return 'pending';
  if (r.state === 'failed') return 'failed';
  if (r.state === 'expired' || r.state === 'refunded') return 'refunded';
  const s = r.snap || {};
  return s.phase === 'pool' ? 'pool' : 'curve';
}
function view(r, usd) {
  const s = (typeof r.snap === 'string' ? JSON.parse(r.snap) : r.snap) || {};
  const lpDec = s.lpDecimals == null ? 9 : s.lpDecimals;
  const sealedLp = Number(r.sealed_lp || 0), burned = Number(r.burned || 0);
  const unspent = Number(r.unspent || 0);
  const sealedPct = s.lpSupply ? Math.min(100, sealedLp * 10 ** lpDec / s.lpSupply * 100) : 0;
  return {
    id: r.id, mint: r.mint, name: r.name, symbol: r.symbol, image: '/i/' + r.id, description: r.description || '',
    twitter: r.twitter || null, telegram: r.telegram || null, website: r.website || null, createdAt: ms(r.live_at || r.created_at),
    phase: phaseOf({ ...r, snap: s }), wallet: r.wallet,
    mcapSol: s.mcapSol == null ? null : s.mcapSol, mcapUsd: s.mcapSol != null && usd ? +(s.mcapSol * usd).toFixed(0) : null,
    priceSol: s.priceSol == null ? null : s.priceSol,
    curveProgress: s.curveProgress == null ? null : s.curveProgress, depthSol: s.depthSol == null ? null : s.depthSol,
    claimedSol: lam(r.claimed), unspentSol: lam(unspent), nextSliceSol: lam(s.depthSol != null ? E.slice(unspent, s.depthSol) : 0),
    sealedSol: lam(r.sealed_sol), sealedLp, sealedPct: +sealedPct.toFixed(3), burnedTokens: burned, burnedPct: +(burned / 1e9 * 100).toFixed(4),
    passes: r.passes || 0, seals: r.seals || 0, burns: r.burns || 0, lastActionAt: ms(r.last_action_at), dumpCostPct: s.dumpCostPct == null ? null : s.dumpCostPct,
    snapAt: s.at || null,
  };
}
const KIND = { claim: 'claim', buy: 'buy', burn: 'burn', pair: 'pair', seal: 'seal' };
function row(l) {
  const k = KIND[l.kind] || 'note';
  return { t: ms(l.at), kind: k, sol: l.sol == null ? null : +l.sol, tokens: l.tokens == null ? null : +l.tokens, lp: l.lp == null ? null : +l.lp, sig: l.sig || null,
    note: k === 'note' ? (l.kind === 'error' ? 'retry: ' : '') + l.note : l.note };
}
let lastNudge = 0;
async function nudge(req) {
  if (Date.now() - lastNudge < 30000) return; lastNudge = Date.now();
  try {
    const r = await L.q(`SELECT v FROM td_meta WHERE k='lastpass'`);
    if (r.length && Date.now() - Number(r[0].v) < 70000) return;
    const p = fetch(L.origin(req) + '/api/tick', { signal: AbortSignal.timeout(20000) }).catch(() => {});
    try { require('@vercel/functions').waitUntil(p); } catch {}
  } catch {}
}

async function stats(req, res) {
  await nudge(req);
  const [a] = await L.q(`SELECT count(*) FILTER (WHERE state='live')::int AS tides, COALESCE(sum(seals),0)::int AS seals, COALESCE(sum(burns),0)::int AS burns,
    COALESCE(sum(sealed_sol),0)::float8 AS sealed, COALESCE(sum(claimed),0)::float8 AS claimed, COALESCE(sum(burned),0)::float8 AS burned FROM td_coins`);
  const [cl] = await L.q(`SELECT count(*)::int AS n FROM td_log WHERE kind='claim'`);
  const lp = await L.q(`SELECT v FROM td_meta WHERE k='lastpass'`);
  const lastPassAt = lp.length ? Number(lp[0].v) : null;
  L.send(res, 200, { ok: true, tides: a.tides, seals: a.seals, burns: a.burns, claims: cl.n, sealedSol: lam(a.sealed), claimedSol: lam(a.claimed), burnedTokens: +a.burned,
    lastPassAt, engineOk: !!(lastPassAt && Date.now() - lastPassAt < 5 * 6e4), solUsd: await solUsd() }, L.CACHE(10));
}
async function coins(req, res) {
  const qy = L.query(req); const sort = String(qy.sort || 'new'); const limit = Math.max(1, Math.min(120, Number(qy.limit) || 60));
  const order = sort === 'sealed' ? `sealed_sol DESC, burned DESC, n DESC` : sort === 'deep' ? `COALESCE((snap->>'depthSol')::float8, 0) DESC, n DESC` : `n DESC`;
  const rows = await L.q(`SELECT * FROM td_coins WHERE state='live' ORDER BY ${order} LIMIT ${limit}`);
  const usd = await solUsd();
  await nudge(req);
  L.send(res, 200, { ok: true, coins: rows.map(r => view(r, usd)) }, L.CACHE(10));
}
async function coin(req, res) {
  const qy = L.query(req); const m = String(qy.m || ''), id = String(qy.id || '');
  if (!L.isAddr(m) && !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return L.send(res, 200, { ok: false, error: 'No such tide.' });
  const rows = await L.q(L.isAddr(m) ? `SELECT * FROM td_coins WHERE mint=$1` : `SELECT * FROM td_coins WHERE id=$1`, [L.isAddr(m) ? m : id]);
  if (!rows.length) return L.send(res, 200, { ok: false, error: 'No such tide.' });
  let r = rows[0];
  const s = r.snap || {};
  if (r.state === 'live' && (!s.at || Date.now() - s.at > 20000)) {
    try { const fresh = await E.snapshot(r); await L.q(`UPDATE td_coins SET snap=$2 WHERE id=$1`, [r.id, JSON.stringify(fresh)]); r = { ...r, snap: fresh }; } catch {}
  }
  const logs = await L.q(`SELECT * FROM td_log WHERE id=$1 ORDER BY n DESC LIMIT 120`, [r.id]);
  const seals = await L.q(`SELECT at, sol FROM td_log WHERE id=$1 AND kind='seal' ORDER BY n ASC LIMIT 2000`, [r.id]);
  let cum = 0; const history = seals.map(x => [ms(x.at), +(cum += Number(x.sol || 0)).toFixed(6)]);
  const usd = await solUsd();
  await nudge(req);
  L.send(res, 200, { ok: true, coin: { ...view(r, usd), history, ledger: logs.map(row) } }, L.CACHE(5));
}
async function ledger(req, res) {
  const limit = Math.max(1, Math.min(100, Number(L.query(req).limit) || 40));
  const rows = await L.q(`SELECT l.*, c.mint, c.symbol, c.id AS cid FROM td_log l JOIN td_coins c ON c.id = l.id WHERE l.kind IN ('claim','buy','burn','pair','seal') ORDER BY l.n DESC LIMIT ${limit}`);
  L.send(res, 200, { ok: true, items: rows.map(l => ({ ...row(l), mint: l.mint, symbol: l.symbol, image: '/i/' + l.cid })) }, L.CACHE(5));
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return L.send(res, 204, {});
  if (!L.dbReady()) return L.send(res, 200, { ok: false, error: 'The engine’s records are offline right now.' });
  try {
    await L.ready();
    const op = String(L.query(req).op || 'stats');
    if (op === 'stats') return await stats(req, res);
    if (op === 'coins') return await coins(req, res);
    if (op === 'coin') return await coin(req, res);
    if (op === 'ledger') return await ledger(req, res);
    L.send(res, 404, { ok: false, error: 'unknown' });
  } catch (e) { L.send(res, 200, { ok: false, error: 'Engine data unavailable: ' + String(e && e.message).slice(0, 120) }); }
};
