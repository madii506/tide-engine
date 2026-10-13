// The engine. It is custodial, and says so: every coin launched on TIDE has its own wallet, derived on this server from
// one master secret, and that wallet is the coin's pump.fun creator. Every pass the engine claims the coin's creator
// fees into that wallet and pours them back into the coin: on the bonding curve it buys and burns; after graduation it
// buys with part of the slice, deposits both sides into the coin's PumpSwap pool and burns the LP tokens it receives,
// so that liquidity can never be withdrawn. There is no sell path and no withdraw path. Every step is a public
// Solana transaction, written to the ledger with its signature.
const crypto = require('crypto');
const L = require('./_lib');
const P = require('./_pool');

let web3 = null, spl = null;
const w3 = () => web3 || (web3 = require('@solana/web3.js'));
const sp = () => spl || (spl = require('@solana/spl-token'));

const LAMPORTS = 1e9;
const RESERVE = 0.015 * LAMPORTS;          // stays in every coin wallet for gas and token-account rent
const CREATE_COST = 0.03 * LAMPORTS;       // pump.fun rent for a new coin, plus margin; whatever is unused goes back
const MIN_DEV = 0.01, MAX_DEV = 5;
const TAU_MIN = 0.01 * LAMPORTS;           // τ_min: the smallest pour
const DEPTH_DIV = 200;                     // τ = min(P, max(τ_min, Q / 200))
const CLAIM_MIN = 0.002 * LAMPORTS;        // claim when at least this much is waiting (or every 10 minutes anyway)
const PORTAL = 'https://pumpportal.fun/api/trade-local';
const PRIORITY = Number(process.env.PRIORITY_FEE || 0.0002);
const CURVE_TOKENS = 793_100_000_000_000n; // real token reserves a pump.fun curve starts with (raw, 6 decimals)
const need = devBuy => Math.ceil((CREATE_COST + devBuy * 1.02 * LAMPORTS + RESERVE) / 1e6) * 1e6;   // rounded up to 0.001 SOL
const sol = l => +(Number(l) / LAMPORTS).toFixed(6);

// ---------- keys: derived, never stored ----------
let MASTER = null;
async function master() {
  if (MASTER) return MASTER;
  if (process.env.TIDE_MASTER && process.env.TIDE_MASTER.length >= 32) return (MASTER = process.env.TIDE_MASTER);
  await L.ready();
  await L.q(`INSERT INTO td_meta (k, v) VALUES ('master', $1) ON CONFLICT (k) DO NOTHING`, [crypto.randomBytes(32).toString('hex')]);
  const r = await L.q(`SELECT v FROM td_meta WHERE k='master'`);
  return (MASTER = r[0].v);
}
async function keys(id) {
  const m = await master(); const { Keypair } = w3();
  const seed = tag => crypto.createHmac('sha256', m).update(tag + ':' + id).digest();
  return { wallet: Keypair.fromSeed(seed('wallet')), mint: Keypair.fromSeed(seed('mint')) };
}
const newId = () => crypto.randomBytes(9).toString('base64url');

// ---------- sending ----------
async function blockhash() { const r = await L.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]); return r.value; }
async function confirm(sig, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await L.rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
      const s = r.value && r.value[0];
      if (s) { if (s.err) return { ok: false, err: JSON.stringify(s.err) }; if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return { ok: true }; }
    } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return { ok: false, err: 'not confirmed in time' };
}
async function sendRaw(bytes, skipPreflight = false) {
  const b64 = Buffer.from(bytes).toString('base64');
  const j = await L.rpcRaw('sendTransaction', [b64, { encoding: 'base64', skipPreflight, maxRetries: 3, preflightCommitment: 'confirmed' }], 20000);
  if (j.error) { const logs = j.error.data && j.error.data.logs; throw new Error((j.error.message || 'send failed') + (logs ? ' | ' + logs.slice(-3).join(' | ') : '')); }
  return j.result;
}
async function sendAndConfirm(bytes) { const sig = await sendRaw(bytes); const c = await confirm(sig); if (!c.ok) { const e = new Error(c.err); e.sig = sig; throw e; } return sig; }
async function sendIxs(payer, ixs) {
  const { Transaction, ComputeBudgetProgram } = w3();
  const bh = await blockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight });
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }), ...ixs); tx.sign(payer);
  return sendAndConfirm(tx.serialize());
}
// PumpPortal's local API writes the pump.fun transaction; we sign it here with the coin's own keys
async function portal(args, signers) {
  if (L.MOCK && L.MOCK.portal) return L.MOCK.portal(args, signers);
  const r = await fetch(PORTAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(15000) });
  if (r.status !== 200) throw new Error('pumpportal ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 160));
  const { VersionedTransaction } = w3();
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
  tx.sign(signers); return tx;
}

// ---------- reading ----------
async function mintInfo(mint) {
  return L.remember('mi:' + mint, 36e5, async () => { const [m] = await L.accounts([mint]); if (!m) throw new Error('mint not found'); return { program: m.owner, decimals: m.data[44] }; });
}
async function tokenBal(owner, mint) {
  const { program } = await mintInfo(mint); const [a] = await L.accounts([L.ataOf(owner, mint, program)]);
  return L.tokenAmount(a);
}
async function wsolBal(owner) { const [a] = await L.accounts([L.ataOf(owner, L.SOL, L.TOKEN)]); return Number(L.tokenAmount(a)); }
async function funds(owner) { const [b, w] = await Promise.all([L.balance(owner), wsolBal(owner).catch(() => 0)]); return { sol: b, wsol: w, total: b + w }; }
async function waiting(wallet) {   // creator fees waiting to be claimed (bonding curve vault + PumpSwap vault), lamports
  const v1 = L.creatorVaultOf(wallet), v2 = L.ammVaultOf(wallet);
  const [a, b] = await L.accounts([v1, L.ataOf(v2, L.SOL, L.TOKEN)]);
  return Math.max(0, (a ? a.lamports - L.RENT0 : 0)) + Number(L.tokenAmount(b));
}
function readCurve(data) {
  if (!data || data.length < 49) return null;
  return { vTok: data.readBigUInt64LE(8), vSol: data.readBigUInt64LE(16), rTok: data.readBigUInt64LE(24), rSol: data.readBigUInt64LE(32), supply: data.readBigUInt64LE(40), complete: data[48] === 1 };
}
function curveDump(cv) { const B = Number(cv.vTok), d = Number(cv.supply) * 0.01; const r = B / (B + d); return +((1 - r * r) * 100).toFixed(2); }

// one on-chain picture of a coin: which phase, how deep, price, progress
async function snapshot(c) {
  return L.remember('snap:' + c.mint, Number(process.env.SNAP_MS || 15000), async () => {
    if (L.MOCK && L.MOCK.snapshot) return L.MOCK.snapshot(c);
    const [bc] = await L.accounts([L.bondingCurveOf(c.mint)]);
    const cv = bc ? readCurve(bc.data) : null;
    const s = { at: Date.now(), phase: 'curve', depthSol: null, curveProgress: null, mcapSol: null, priceSol: null, dumpCostPct: null, lpSupply: null, pool: null };
    if (cv && !cv.complete) {
      const left = cv.rTok > CURVE_TOKENS ? CURVE_TOKENS : cv.rTok;
      s.curveProgress = +(Number(CURVE_TOKENS - left) / Number(CURVE_TOKENS)).toFixed(4);
      s.depthSol = sol(cv.vSol);
      const pl = Number(cv.vSol) / Number(cv.vTok);   // lamports per raw token
      s.priceSol = pl * 1e6 / LAMPORTS; s.mcapSol = +(pl * Number(cv.supply) / LAMPORTS).toFixed(3);
      s.dumpCostPct = curveDump(cv);
      return s;
    }
    const ps = await P.poolSnap(c.mint).catch(() => null);
    if (ps) return { ...s, phase: 'pool', curveProgress: 1, depthSol: +ps.depthSol.toFixed(4), mcapSol: +ps.mcapSol.toFixed(3), priceSol: ps.priceSol, dumpCostPct: ps.dumpCostPct, lpSupply: ps.lpSupply, lpDecimals: ps.lpDecimals, pool: ps.pool, solQuoted: ps.solQuoted };
    if (cv && cv.complete) return { ...s, phase: 'migrating', curveProgress: 1 };
    return { ...s, phase: 'unknown' };
  });
}

// ---------- the launch ----------
async function create(c) {
  const k = await keys(c.id);
  await L.log(c.id, 'launch', `deposit in. creating $${c.symbol} on pump.fun`);
  let sig;
  try {
    const tx = await portal({ publicKey: k.wallet.publicKey.toBase58(), action: 'create', tokenMetadata: { name: c.name, symbol: c.symbol, uri: c.meta_uri },
      mint: k.mint.publicKey.toBase58(), denominatedInSol: 'true', amount: c.dev_buy, slippage: 10, priorityFee: PRIORITY, pool: 'pump' }, [k.mint, k.wallet]);
    sig = await sendAndConfirm(tx.serialize());
  } catch (e) {
    const [bc] = await L.accounts([L.bondingCurveOf(c.mint)]).catch(() => [null]);
    if (!bc) {
      await L.q(`UPDATE td_coins SET state='failed', err=$2 WHERE id=$1`, [c.id, String(e.message).slice(0, 300)]);
      await L.log(c.id, 'error', 'launch failed: ' + String(e.message).slice(0, 200), { sig: e.sig });
      await refund(c, 'launch failed, deposit returned');
      return { ok: false, error: String(e.message) };
    }
    sig = e.sig || null;
  }
  await L.q(`UPDATE td_coins SET state='live', live_at=now(), create_sig=$2, err=NULL WHERE id=$1`, [c.id, sig]);
  await L.log(c.id, 'launch', `$${c.symbol} is live on pump.fun. the engine is attached`, { sig });
  await handOut(c, k).catch(e => L.log(c.id, 'error', 'sending the first buy back failed: ' + String(e.message).slice(0, 160)));
  return { ok: true, sig };
}
// after launch: the launcher's first-buy tokens and any SOL beyond the reserve go back to the launcher's wallet
async function handOut(c, k) {
  k = k || await keys(c.id);
  const { PublicKey, SystemProgram } = w3(); const S = sp();
  const owner = k.wallet.publicKey, to = new PublicKey(c.owner), mint = new PublicKey(c.mint);
  const { program, decimals } = await mintInfo(c.mint); const prog = new PublicKey(program);
  const ixs = [];
  const amt = await tokenBal(owner.toBase58(), c.mint);
  if (amt > 0n) {
    const src = new PublicKey(L.ataOf(owner.toBase58(), c.mint, program)), dst = new PublicKey(L.ataOf(c.owner, c.mint, program));
    ixs.push(S.createAssociatedTokenAccountIdempotentInstruction(owner, dst, to, mint, prog), S.createTransferCheckedInstruction(src, mint, dst, owner, amt, decimals, [], prog));
  }
  const bal = await L.balance(owner.toBase58());
  const extra = bal - RESERVE - 0.0025 * LAMPORTS;
  if (extra > 0.002 * LAMPORTS) ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: to, lamports: Math.floor(extra) }));
  if (!ixs.length) return null;
  const sig = await sendIxs(k.wallet, ixs);
  await L.q(`UPDATE td_coins SET out_sig=$2 WHERE id=$1`, [c.id, sig]);
  await L.log(c.id, 'launch', `first buy${extra > 0.002 * LAMPORTS ? ' and unused SOL' : ''} sent to the launcher`, { sig, sol: extra > 0 ? sol(extra) : null });
  return sig;
}
async function refund(c, why) {
  const k = await keys(c.id); const { SystemProgram, PublicKey } = w3();
  const bal = await L.balance(k.wallet.publicKey.toBase58());
  const amt = bal - 10000;
  if (amt <= 0) return null;
  try {
    const sig = await sendIxs(k.wallet, [SystemProgram.transfer({ fromPubkey: k.wallet.publicKey, toPubkey: new PublicKey(c.owner), lamports: amt })]);
    await L.q(`UPDATE td_coins SET refund_sig=$2, state=CASE WHEN state='live' THEN state ELSE 'refunded' END WHERE id=$1`, [c.id, sig]);
    await L.log(c.id, 'refund', why, { sig, sol: sol(amt) });
    return sig;
  } catch (e) { await L.log(c.id, 'error', 'refund failed, will retry: ' + String(e.message).slice(0, 160)); return null; }
}
// move a launch forward: called by the launch page while it waits, and by every engine pass
async function advance(c) {
  if (c.state === 'waiting') {
    const bal = await L.balance(c.wallet);
    if (bal >= Number(c.need) * 0.995) {
      const got = await L.q(`UPDATE td_coins SET state='creating', ticked_at=now() WHERE id=$1 AND state='waiting' RETURNING *`, [c.id]);
      if (got.length) return create(got[0]);
    } else if (Date.now() - new Date(c.created_at) > 3 * 36e5) {
      await L.q(`UPDATE td_coins SET state='expired' WHERE id=$1 AND state='waiting'`, [c.id]);
      if (bal > 10000) await refund({ ...c, state: 'expired' }, 'never fully funded, deposit returned');
    }
    return { ok: true, state: 'waiting', balance: bal };
  }
  if (c.state === 'creating' && Date.now() - new Date(c.ticked_at || c.created_at) > 4 * 6e4) {
    const [bc] = await L.accounts([L.bondingCurveOf(c.mint)]);
    if (bc) await L.q(`UPDATE td_coins SET state='live', live_at=COALESCE(live_at, now()) WHERE id=$1`, [c.id]);
    else { await L.q(`UPDATE td_coins SET state='failed', err='creation did not land' WHERE id=$1`, [c.id]); await refund(c, 'launch did not land, deposit returned'); }
  }
  if ((c.state === 'expired' || c.state === 'failed') && !c.refund_sig) { const bal = await L.balance(c.wallet); if (bal > 10000) await refund(c, 'deposit returned'); }
  return { ok: true, state: c.state };
}

// ---------- step 1: claim ----------
async function unwrap(k) {
  const S = sp(); const owner = k.wallet.publicKey;
  const ata = new (w3().PublicKey)(L.ataOf(owner.toBase58(), L.SOL, L.TOKEN));
  return sendIxs(k.wallet, [S.createCloseAccountInstruction(ata, owner, owner, [], new (w3().PublicKey)(L.TOKEN))]);
}
async function claim(c, k) {
  const w = await waiting(c.wallet);
  const stale = !c.last_claim_at || Date.now() - new Date(c.last_claim_at) > 10 * 6e4;
  if (w < CLAIM_MIN && !(stale && w > 0)) return 0;
  const before = await funds(c.wallet);
  const tx = await portal({ publicKey: c.wallet, action: 'collectCreatorFee', priorityFee: 0.00001, pool: 'pump' }, [k.wallet]);
  const sig = await sendAndConfirm(tx.serialize());
  let after = await funds(c.wallet);
  if (after.wsol > 0) { await unwrap(k).catch(() => null); after = await funds(c.wallet); }   // PumpSwap pays its creator fee in wSOL
  const got = Math.max(0, after.total - before.total);
  await L.q(`UPDATE td_coins SET last_claim_at=now() WHERE id=$1`, [c.id]);
  if (got <= 0) return 0;
  let cut = 0;
  if (L.STUDIO && L.STUDIO_BPS > 0) {
    cut = Math.floor(got * L.STUDIO_BPS / 1e4);
    if (cut >= 100000) {
      const { SystemProgram, PublicKey } = w3();
      const s2 = await sendIxs(k.wallet, [SystemProgram.transfer({ fromPubkey: k.wallet.publicKey, toPubkey: new PublicKey(L.STUDIO), lamports: cut })]).catch(() => null);
      if (s2) await L.log(c.id, 'fee', `house cut ${(L.STUDIO_BPS / 100).toFixed(2)}%`, { sig: s2, sol: sol(cut) }); else cut = 0;
    } else cut = 0;
  }
  await L.q(`UPDATE td_coins SET claimed = claimed + $2, unspent = unspent + $3 WHERE id=$1`, [c.id, got, got - cut]);
  await L.log(c.id, 'claim', `claimed ${sol(got)} SOL of creator fees`, { sig, sol: sol(got) });
  return got - cut;
}

// ---------- steps 3–6: size, buy, pair, seal (or buy + burn on the curve) ----------
function slice(unspent, depthSol) {
  const Q = Math.floor((depthSol || 0) * LAMPORTS);
  const t = Math.min(unspent, Math.max(TAU_MIN, Math.floor(Q / DEPTH_DIV)));
  return t >= TAU_MIN ? t : 0;
}
async function curvePour(c, k, lam) {
  const S = sp(); const { PublicKey } = w3();
  const before = await tokenBal(c.wallet, c.mint).catch(() => 0n);
  const tx = await portal({ publicKey: c.wallet, action: 'buy', mint: c.mint, denominatedInSol: 'true', amount: +(lam / LAMPORTS).toFixed(6), slippage: 15, priorityFee: PRIORITY, pool: 'pump' }, [k.wallet]);
  const sig = await sendAndConfirm(tx.serialize());
  const after = await tokenBal(c.wallet, c.mint);
  const got = after > before ? after - before : 0n;
  const { program, decimals } = await mintInfo(c.mint);
  await L.log(c.id, 'buy', `bought on the curve`, { sig, sol: sol(lam), tokens: Number(got) / 10 ** decimals });
  if (got <= 0n) return { sig };
  const prog = new PublicKey(program), mint = new PublicKey(c.mint), src = new PublicKey(L.ataOf(c.wallet, c.mint, program));
  const sig2 = await sendIxs(k.wallet, [S.createBurnCheckedInstruction(src, mint, k.wallet.publicKey, got, decimals, [], prog)]);
  const ui = Number(got) / 10 ** decimals;
  await L.q(`UPDATE td_coins SET burned = burned + $2, burns = burns + 1 WHERE id=$1`, [c.id, ui]);
  await L.log(c.id, 'burn', `burned what the buy delivered`, { sig: sig2, tokens: ui });
  return { sig: sig2 };
}
async function poolPour(c, k, lam) {
  const built = await ((L.MOCK && L.MOCK.buildPour) || P.buildPour)(c.wallet, c.mint, lam);
  const sigs = [];
  for (const t of built.txs) { t.tx.sign([k.wallet]); sigs.push(await sendAndConfirm(t.tx.serialize())); }
  const lpUi = Number(built.lp) / 10 ** (built.lpDecimals == null ? 9 : built.lpDecimals);
  const coinUi = Number(built.coinOut) / 10 ** built.decimals;
  await L.log(c.id, 'buy', 'bought on PumpSwap', { sig: sigs[0], sol: built.buySol, tokens: coinUi });
  await L.log(c.id, 'pair', 'paired both sides into the pool', { sig: sigs[sigs.length - 1], sol: built.depSol, tokens: Number(built.depCoin) / 10 ** built.decimals, lp: lpUi });
  await L.log(c.id, 'seal', 'burned the LP tokens: this liquidity can never be withdrawn', { sig: sigs[sigs.length - 1], sol: built.depSol, lp: lpUi });
  await L.q(`UPDATE td_coins SET sealed_sol = sealed_sol + $2, sealed_lp = sealed_lp + $3, seals = seals + 1 WHERE id=$1`, [c.id, Math.round(built.depSol * LAMPORTS), lpUi]);
  return { sig: sigs[sigs.length - 1] };
}

// ---------- one pass for one live coin ----------
async function tickCoin(c) {
  const k = await keys(c.id);
  if (k.wallet.publicKey.toBase58() !== c.wallet) throw new Error('key mismatch');
  if (c.retry_at && new Date(c.retry_at) > Date.now()) return { skipped: 'backing off' };
  try { await claim(c, k); } catch (e) { await L.log(c.id, 'error', 'claim failed: ' + String(e.message).slice(0, 160)); }
  const cur = (await L.q(`SELECT * FROM td_coins WHERE id=$1`, [c.id]))[0];
  let snap = null;
  try { snap = await snapshot(cur); await L.q(`UPDATE td_coins SET snap=$2 WHERE id=$1`, [c.id, JSON.stringify(snap)]); } catch (e) { await L.log(c.id, 'error', 'read failed: ' + String(e.message).slice(0, 160)); }
  let done = 'idle';
  if (snap && (snap.phase === 'curve' || snap.phase === 'pool')) {
    const f = await funds(c.wallet);
    const spendable = Math.max(0, f.sol - RESERVE - 0.006 * LAMPORTS);   // rent margin for the token, LP and wSOL accounts
    const tau = Math.min(slice(Number(cur.unspent), snap.depthSol), spendable);
    if (tau >= TAU_MIN) {
      try {
        if (snap.phase === 'pool' && snap.solQuoted !== false) await poolPour(cur, k, tau); else await curvePour(cur, k, tau);
        const g = await funds(c.wallet);
        const spent = Math.max(0, f.total - g.total);
        await L.q(`UPDATE td_coins SET unspent = GREATEST(0, unspent - $2), spent = spent + $2, passes = passes + 1, last_action_at=now(), fails=0, retry_at=NULL WHERE id=$1`, [c.id, spent]);
        done = snap.phase === 'pool' ? 'sealed' : 'burned';
      } catch (e) {
        const fails = (cur.fails || 0) + 1;
        await L.q(`UPDATE td_coins SET fails=$2, retry_at=now() + ($3 || ' seconds')::interval WHERE id=$1`, [c.id, fails, String(Math.min(900, 60 * fails))]);
        await L.log(c.id, 'error', `pour failed (try ${fails}): ` + String(e.message).slice(0, 160), { sig: e.sig });
        done = 'failed';
      }
    }
  }
  await L.q(`UPDATE td_coins SET ticked_at=now() WHERE id=$1`, [c.id]);
  return { done };
}

// ---------- the pass: launches waiting for deposits, then live coins, oldest-visited first ----------
async function tick(budgetMs = 45000) {
  await L.ready();
  const lock = await L.q(`INSERT INTO td_meta (k, v) VALUES ('tick', $1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v WHERE td_meta.v::bigint < $2 RETURNING v`, [String(Date.now()), Date.now() - Number(process.env.TICK_GAP_MS || 50000)]);
  if (!lock.length) return { ok: true, skipped: 'another pass is running or ran under a minute ago' };
  const deadline = Date.now() + budgetMs; const done = { launches: 0, coins: 0, sealed: 0, burned: 0, errors: 0 };
  const pend = await L.q(`SELECT * FROM td_coins WHERE state IN ('waiting','creating') OR (state IN ('expired','failed') AND refund_sig IS NULL) ORDER BY created_at LIMIT 20`);
  for (const c of pend) { if (Date.now() > deadline) break; try { await advance(c); done.launches++; } catch { done.errors++; } }
  const live = await L.q(`SELECT * FROM td_coins WHERE state='live' ORDER BY ticked_at NULLS FIRST LIMIT 40`);
  let i = 0;
  await Promise.all([0, 1, 2].map(async () => {
    while (i < live.length && Date.now() < deadline - 9000) {
      const c = live[i++];
      try { const r = await tickCoin(c); done.coins++; if (r.done === 'sealed') done.sealed++; if (r.done === 'burned') done.burned++; }
      catch (e) { done.errors++; await L.log(c.id, 'error', 'pass: ' + String(e.message).slice(0, 160)); }
    }
  }));
  await L.q(`INSERT INTO td_meta (k, v) VALUES ('lastpass', $1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [String(Date.now())]);
  return { ok: true, ...done, at: new Date().toISOString() };
}

module.exports = { keys, newId, need, advance, tick, tickCoin, blockhash, sendRaw, confirm, portal, waiting, snapshot, slice, funds, readCurve,
  RESERVE, CREATE_COST, MIN_DEV, MAX_DEV, LAMPORTS, TAU_MIN, DEPTH_DIV };
