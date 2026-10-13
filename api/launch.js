// GET  /api/launch?op=config            what launching costs and whether it is open
// POST /api/launch?op=prepare           record the coin; returns its own engine wallet and the deposit it needs
// GET  /api/launch?op=status&id=        where a launch is (and moves it forward: a full deposit starts the coin)
// GET  /api/launch?op=blockhash         for the wallet that signs the deposit
// POST /api/launch?op=relay {tx}        sends a signed deposit, for wallets that can sign but not send
// GET  /api/launch?op=selftest[&mint=][&pour=<graduated mint>&wallet=<funded wallet>]   builds and SIMULATES (nothing is sent)
const L = require('./_lib');
const E = require('./_engine');

const SOL = n => +(n / 1e9).toFixed(4);
async function upload(img, f, site, id) {
  // 1) Pinata, when the house has a key  2) this site (/m/<id>, /i/<id>)
  const jwt = (process.env.PINATA_JWT || '').trim();
  if (jwt && !L.MOCK) {
    try {
      const put = async (blob, name) => { const fd = new FormData(); fd.append('network', 'public'); fd.append('file', blob, name);
        const r = await fetch('https://uploads.pinata.cloud/v3/files', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: fd, signal: AbortSignal.timeout(15000) });
        const j = await r.json(); if (!j || !j.data || !j.data.cid) throw new Error('pinata'); return 'https://ipfs.io/ipfs/' + j.data.cid; };
      const image = await put(new Blob([img], { type: 'image/jpeg' }), 'coin.jpg');
      const meta = await put(new Blob([JSON.stringify({ name: f.name, symbol: f.symbol, description: f.description, image, showName: true, createdOn: site, twitter: f.twitter || undefined, telegram: f.telegram || undefined, website: f.website })], { type: 'application/json' }), 'meta.json');
      return { uri: meta, via: 'pinata ipfs' };
    } catch {}
  }
  return { uri: site + '/m/' + id, via: 'tide' };
}

async function prepare(req, res) {
  if (L.limited('prep:' + L.ip(req), 8, 600000)) return L.send(res, 200, { ok: false, error: 'Too many launches from here. Wait a few minutes.' });
  if (!L.dbReady()) return L.send(res, 200, { ok: false, error: 'The engine’s records are offline, so launching is paused.' });
  const b = await L.body(req, 2.5 * 1024 * 1024);
  if (b.tooBig) return L.send(res, 200, { ok: false, error: 'That picture is too big. Use one under 1.5 MB.' });
  const owner = String(b.owner || b.launcher || '').trim();
  if (!L.isAddr(owner)) return L.send(res, 200, { ok: false, error: 'Connect a wallet (or paste your address) so the first buy and any refund have somewhere to go.' });
  const name = L.clean(b.name, 32), symbol = L.clean(b.symbol, 10).replace(/^\$/, '').toUpperCase();
  const description = L.clean(b.description, 500);
  if (!name || Buffer.byteLength(name) > 32) return L.send(res, 200, { ok: false, error: 'Give the coin a name of up to 32 characters.' });
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) return L.send(res, 200, { ok: false, error: 'The ticker is 1–10 letters or numbers.' });
  if (L.BANNED.test(name + ' ' + symbol + ' ' + description)) return L.send(res, 200, { ok: false, error: 'Pick other words. Those break the house rules.' });
  const tw = String(b.twitter || '').trim(), tg = String(b.telegram || '').trim(), web = String(b.website || '').trim();
  if (tw && !/^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}(\/status\/\d+)?\/?$/.test(tw)) return L.send(res, 200, { ok: false, error: 'The X link should look like https://x.com/yourcoin.' });
  if (tg && !/^https:\/\/t\.me\/[A-Za-z0-9_+\/-]{3,80}$/.test(tg)) return L.send(res, 200, { ok: false, error: 'The Telegram link should look like https://t.me/yourcoin.' });
  if (web && !/^https:\/\/[^\s"'<>]{3,200}$/.test(web)) return L.send(res, 200, { ok: false, error: 'The website should start with https://.' });
  const dev = Number(b.devBuySol != null ? b.devBuySol : b.devBuy);
  if (!(dev >= E.MIN_DEV && dev <= E.MAX_DEV)) return L.send(res, 200, { ok: false, error: `The first buy is between ${E.MIN_DEV} and ${E.MAX_DEV} SOL.` });
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
  if (!m) return L.send(res, 200, { ok: false, error: 'Add a picture for the coin.' });
  let img;
  try { img = await require('sharp')(Buffer.from(m[2], 'base64')).rotate().resize(512, 512, { fit: 'cover' }).flatten({ background: '#000000' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer(); }
  catch { return L.send(res, 200, { ok: false, error: 'That picture couldn’t be read. Try a PNG or JPG.' }); }
  try {
    await L.ready();
    const id = E.newId(); const k = await E.keys(id);
    const wallet = k.wallet.publicKey.toBase58(), mint = k.mint.publicKey.toBase58();
    const site = L.origin(req);
    const page = site + '/coin?m=' + mint;
    const desc = (description ? description + '\n\n' : '') + `A tide on TIDE: its creator fees deepen its own pool, and that liquidity is sealed for good. ${page.replace(/^https?:\/\//, '')}`;
    const up = await upload(img, { name, symbol, description: desc, twitter: tw, telegram: tg, website: web || page }, site, id);
    const needL = E.need(dev);
    await L.q(`INSERT INTO td_coins (id, wallet, mint, owner, name, symbol, description, twitter, telegram, website, img, meta_uri, dev_buy, need)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, wallet, mint, owner, name, symbol, desc, tw || null, tg || null, web || null, img, up.uri, dev, needL]);
    await L.log(id, 'launch', `$${symbol} recorded; waiting for ${SOL(needL)} SOL`);
    L.send(res, 200, { ok: true, id, wallet, mint, depositSol: SOL(needL), depositLamports: needL, expiresAt: Date.now() + 3 * 36e5, uri: up.uri, via: up.via });
  } catch (e) { L.send(res, 200, { ok: false, error: 'The launch didn’t save. Try again.' }); }
}

const STATE = { waiting: 'awaiting_deposit', creating: 'creating', live: 'live', refunded: 'refunded', failed: 'failed', expired: 'expired' };
async function status(req, res) {
  const id = String(L.query(req).id || '');
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id) || !L.dbReady()) return L.send(res, 200, { ok: false, error: 'No such launch.' });
  await L.ready();
  let r = await L.q('SELECT * FROM td_coins WHERE id=$1', [id]);
  if (!r.length) return L.send(res, 200, { ok: false, error: 'No such launch.' });
  let c = r[0], bal = null, note = null;
  if (['waiting', 'creating', 'failed', 'expired'].includes(c.state)) {
    try { const a = await E.advance(c); if (a && a.balance != null) bal = a.balance; if (a && a.error) note = a.error; } catch (e) { note = String(e.message).slice(0, 160); }
    c = (await L.q('SELECT * FROM td_coins WHERE id=$1', [id]))[0];
  }
  if (bal == null && c.state === 'waiting') bal = await L.balance(c.wallet).catch(() => null);
  const logs = await L.q(`SELECT kind, note, sig, at FROM td_log WHERE id=$1 ORDER BY n DESC LIMIT 12`, [id]);
  const message = c.state === 'live' ? `$${c.symbol} is live. The engine visits it every minute.` : c.state === 'waiting' ? `Waiting for ${SOL(Number(c.need))} SOL at the coin’s wallet.` :
    c.state === 'creating' ? 'Deposit in. Creating the coin on pump.fun…' : c.state === 'refunded' ? 'The deposit was returned.' : c.err || note || c.state;
  L.send(res, 200, { ok: true, id: c.id, state: STATE[c.state] || c.state, wallet: c.wallet, mint: c.state === 'live' ? c.mint : null, symbol: c.symbol,
    depositSol: SOL(Number(c.need)), depositLamports: Number(c.need), balanceSol: bal == null ? null : SOL(bal), sig: c.create_sig, outSig: c.out_sig, refundSig: c.refund_sig, message, note,
    logs: logs.map(l => ({ kind: l.kind, note: l.note, sig: l.sig, t: new Date(l.at).getTime() })) });
}

async function relay(req, res) {
  if (L.limited('relay:' + L.ip(req), 10, 600000)) return L.send(res, 200, { ok: false, error: 'Too many from here.' });
  const b = await L.body(req, 4096);
  try {
    const { Transaction, SystemProgram } = require('@solana/web3.js');
    const buf = Buffer.from(String(b.tx || ''), 'base64'); const tx = Transaction.from(buf);
    const to = tx.instructions.filter(i => i.programId.equals(SystemProgram.programId)).map(i => i.keys[1] && i.keys[1].pubkey.toBase58()).filter(Boolean);
    if (!to.length) return L.send(res, 200, { ok: false, error: 'That isn’t a deposit.' });
    await L.ready();
    const ok = await L.q(`SELECT 1 FROM td_coins WHERE wallet = ANY($1) AND state='waiting'`, [to]);
    if (!ok.length) return L.send(res, 200, { ok: false, error: 'That deposit isn’t for a launch that is waiting.' });
    const sig = await E.sendRaw(buf);
    L.send(res, 200, { ok: true, sig });
  } catch (e) { L.send(res, 200, { ok: false, error: 'Sending failed: ' + String(e.message).slice(0, 140) }); }
}

async function selftest(req, res) {
  if (L.limited('st:' + L.ip(req), 8, 600000)) return L.send(res, 200, { ok: false, error: 'Wait a few minutes.' });
  const { Keypair } = require('@solana/web3.js');
  const qy = L.query(req);
  const sim = async tx => { const j = await L.rpcRaw('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
    const v = j.result && j.result.value; return { err: v ? v.err : j.error && j.error.message, units: v && v.unitsConsumed, logs: v && v.logs ? v.logs.slice(-4) : [] }; };
  const out = {}; const w = Keypair.generate(), mk = Keypair.generate();
  const step = async (name, fn) => { const t0 = Date.now(); try { out[name] = { ok: true, ...(await fn()), ms: Date.now() - t0 }; } catch (e) { out[name] = { ok: false, error: String(e.message).slice(0, 220), logs: e.logs, ms: Date.now() - t0 }; } };
  const who = L.isAddr(String(qy.wallet || '')) ? String(qy.wallet) : null;
  await step('create', async () => { const tx = await E.portal({ publicKey: w.publicKey.toBase58(), action: 'create', tokenMetadata: { name: 'tide selftest', symbol: 'TEST', uri: L.origin(req) + '/m/selftest' }, mint: mk.publicKey.toBase58(), denominatedInSol: 'true', amount: 0.01, slippage: 10, priorityFee: 0.0001, pool: 'pump' }, [mk, w]);
    return { bytes: tx.serialize().length, signers: tx.signatures.length, sim: await sim(tx) }; });
  const curve = L.isAddr(String(qy.mint || '')) ? String(qy.mint) : null;
  if (curve) await step('curveBuy', async () => { const tx = await E.portal({ publicKey: who || w.publicKey.toBase58(), action: 'buy', mint: curve, denominatedInSol: 'true', amount: 0.01, slippage: 15, priorityFee: 0.0001, pool: 'auto' }, who ? [] : [w]); return { bytes: tx.serialize().length, sim: await sim(tx) }; });
  await step('claim', async () => { const tx = await E.portal({ publicKey: w.publicKey.toBase58(), action: 'collectCreatorFee', priorityFee: 0.00001, pool: 'pump' }, [w]); return { bytes: tx.serialize().length, sim: await sim(tx) }; });
  const pourMint = L.isAddr(String(qy.pour || '')) ? String(qy.pour) : null;
  if (pourMint && who) await step('pour', async () => {
    const lam = Math.floor(Math.max(0.01, Math.min(0.5, Number(qy.sol) || 0.05)) * 1e9);
    const b = await require('./_pool').buildPour(who, pourMint, lam);   // simulates the first transaction and throws on failure
    return { txs: b.txs.map(t => ({ bytes: t.bytes, units: t.units, simUnits: t.simUnits })), lp: b.lp.toString(), lpDecimals: b.lpDecimals, buySol: b.buySol, depSol: b.depSol, pool: b.pool, lpMint: b.lpMint };
  });
  if (pourMint) await step('snapshot', async () => { const s = await E.snapshot({ mint: pourMint }); return { snap: s }; });
  await step('keys', async () => { if (!L.dbReady()) return { db: false }; const a = await E.keys('selftest-x'), b2 = await E.keys('selftest-x'); return { stable: a.wallet.publicKey.equals(b2.wallet.publicKey), distinct: !a.wallet.publicKey.equals(a.mint.publicKey) }; });
  L.send(res, 200, { ok: true, note: 'nothing is sent. create/claim use throwaway keys, so insufficient-funds errors there are expected; pour uses the wallet you pass', ...out });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return L.send(res, 204, {});
  const op = String(L.query(req).op || (req.method === 'POST' ? 'prepare' : 'config'));
  try {
    if (req.method === 'POST' && op === 'prepare') return await prepare(req, res);
    if (req.method === 'POST' && op === 'relay') return await relay(req, res);
    if (op === 'status') return await status(req, res);
    if (op === 'blockhash') return L.send(res, 200, { ok: true, ...(await E.blockhash()) });
    if (op === 'selftest') return await selftest(req, res);
    L.send(res, 200, { ok: true, open: L.dbReady(), reserveSol: E.RESERVE / 1e9, createSol: E.CREATE_COST / 1e9, minDev: E.MIN_DEV, maxDev: E.MAX_DEV, tauMinSol: E.TAU_MIN / 1e9, depthDiv: E.DEPTH_DIV,
      houseBps: L.STUDIO ? L.STUDIO_BPS : 0 }, L.CACHE(60));
  } catch (e) { L.send(res, 200, { ok: false, error: 'Something broke: ' + String(e && e.message).slice(0, 120) }); }
};
