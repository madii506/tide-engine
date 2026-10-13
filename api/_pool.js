// PumpSwap: read a coin's canonical pool and build the "pour" — buy part of a SOL budget into the coin, deposit both
// sides into the pool, and burn the LP tokens the deposit mints, all in one transaction when it fits.
// Built on the official @pump-fun/pump-swap-sdk (the same builders MILK ships, verified by mainnet simulation).
const L = require('./_lib');
let M = null;
function mods() {
  if (M) return M;
  const web3 = require('@solana/web3.js'), spl = require('@solana/spl-token'), BN = require('bn.js'), sdk = require('@pump-fun/pump-swap-sdk');
  return (M = { web3, spl, BN, sdk });
}
const U64_MAX = BigInt('18446744073709551615');
const ALT_KEYS = [(process.env.TIDE_ALT || '').trim(), '9rVP9Ly5RC1nix3WDm5QgkoWJbxV7Kteth1KHtYk5hT9', '7Pau8dAeZTzVhVjQgTJeELY3XMPVSHidpzB78RnDE3bR'].filter(Boolean);
const big = v => BigInt(v.toString());
const ceilDiv = (a, b) => (a + b - 1n) / b;

let conns = null;
function timedFetch(ms) { return (url, opt = {}) => fetch(url, { ...opt, signal: AbortSignal.timeout(ms) }); }
async function rpc(fn) {
  const { Connection } = mods().web3;
  if (!conns) conns = L.RPCS.map(u => new Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: timedFetch(9000) }));
  let last;
  for (const c of conns) { try { return await fn(c); } catch (e) { last = e; } }
  throw new Error('Solana RPC is busy: ' + String(last && last.message || last).slice(0, 140));
}

async function globals() {
  return L.remember('pp:globals', 60000, async () => {
    const { sdk } = mods();
    const [g, f] = await rpc(c => c.getMultipleAccountsInfo([sdk.GLOBAL_CONFIG_PDA, sdk.PUMP_AMM_FEE_CONFIG_PDA]));
    if (!g) throw new Error('PumpSwap global config not found');
    return { globalConfig: sdk.PUMP_AMM_SDK.decodeGlobalConfig(g), feeConfig: f ? sdk.PUMP_AMM_SDK.decodeFeeConfig(f) : null };
  });
}
async function lookupTables() {
  return L.remember('pp:alts', 300000, async () => {
    const { PublicKey, AddressLookupTableAccount } = mods().web3;
    const keys = ALT_KEYS.map(k => new PublicKey(k));
    const infos = await rpc(c => c.getMultipleAccountsInfo(keys));
    const out = [];
    infos.forEach((info, i) => {
      if (!info) return;
      try { const state = AddressLookupTableAccount.deserialize(info.data); if (BigInt(state.deactivationSlot) !== U64_MAX) return; out.push(new AddressLookupTableAccount({ key: keys[i], state })); } catch (e) { }
    });
    return out;
  });
}
function feesFor(pool, globalConfig, feeConfig, supply, Rb, Rq) {
  const { sdk, BN, web3 } = mods();
  const f = sdk.computeFeesBps({
    globalConfig, feeConfig, creator: pool.creator, baseMintSupply: new BN(supply.toString()), baseMint: pool.baseMint,
    baseReserve: new BN(Rb.toString()), quoteReserve: new BN((Rq + big(pool.virtualQuoteReserves)).toString()),
    quoteMint: pool.quoteMint, isMayhemMode: pool.isMayhemMode, creatorFeeBps: pool.creatorFeeBps,
  });
  const hasCreator = !pool.coinCreator.equals(web3.PublicKey.default);
  return { lp: big(f.lpFeeBps), pr: big(f.protocolFeeBps), cr: hasCreator ? big(f.creatorFeeBps) : 0n };
}
const poolKeyOf = mint => { const { sdk, web3 } = mods(); return sdk.canonicalPumpPoolPda(new web3.PublicKey(mint)); };

// Everything the builders need for one pool (and optionally one wallet), in two RPC round trips.
async function loadState(poolKey, user) {
  const { web3, spl, sdk } = mods(); const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MintLayout, AccountLayout, getAssociatedTokenAddressSync } = spl;
  const { globalConfig, feeConfig } = await globals();
  const poolInfo = await rpc(c => c.getAccountInfo(poolKey));
  if (!poolInfo || !poolInfo.owner.equals(sdk.PUMP_AMM_PROGRAM_ID)) return null;
  const pool = sdk.PUMP_AMM_SDK.decodePool(poolInfo);
  const keys = [pool.baseMint, pool.quoteMint, pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount, pool.lpMint];
  const uKeys = user ? [
    user,
    getAssociatedTokenAddressSync(pool.baseMint, user, true, TOKEN_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.baseMint, user, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.quoteMint, user, true, TOKEN_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.quoteMint, user, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.lpMint, user, true, TOKEN_2022_PROGRAM_ID),
  ] : [];
  const infos = await rpc(c => c.getMultipleAccountsInfo([...keys, ...uKeys]));
  const [bm, qm, pb, pq, lm] = infos;
  if (!bm || !qm || !pb || !pq) throw new Error('pool accounts are missing');
  const baseTokenProgram = bm.owner, quoteTokenProgram = qm.owner;
  const baseMintAccount = MintLayout.decode(bm.data.slice(0, MintLayout.span));
  const poolBaseTokenAccount = AccountLayout.decode(pb.data.slice(0, AccountLayout.span));
  const poolQuoteTokenAccount = AccountLayout.decode(pq.data.slice(0, AccountLayout.span));
  const Rb = big(poolBaseTokenAccount.amount), Rq = big(poolQuoteTokenAccount.amount), Lp = big(pool.lpSupply);
  const fee = feesFor(pool, globalConfig, feeConfig, baseMintAccount.supply, Rb, Rq);
  const st = {
    globalConfig, feeConfig, poolKey, poolInfo, pool, baseTokenProgram, quoteTokenProgram, baseMintAccount,
    poolBaseTokenAccount, poolQuoteTokenAccount, Rb, Rq, L: Lp, vqr: big(pool.virtualQuoteReserves), fee,
    decimals: baseMintAccount.decimals, supply: big(baseMintAccount.supply), solQuoted: pool.quoteMint.equals(spl.NATIVE_MINT),
    lpDecimals: lm ? lm.data[44] : 9,
  };
  if (user) {
    const [ua, ub1, ub2, uq1, uq2, ulp] = infos.slice(5);
    const b22 = baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID), q22 = quoteTokenProgram.equals(TOKEN_2022_PROGRAM_ID);
    const owned = (info, prog) => (info && info.owner.equals(prog) ? info : null);
    const amt = info => (info ? big(AccountLayout.decode(info.data.slice(0, AccountLayout.span)).amount) : 0n);
    st.u = {
      user, lamports: BigInt(ua ? ua.lamports : 0),
      userBaseTokenAccount: b22 ? uKeys[2] : uKeys[1], userBaseAccountInfo: owned(b22 ? ub2 : ub1, baseTokenProgram),
      userQuoteTokenAccount: q22 ? uKeys[4] : uKeys[3], userQuoteAccountInfo: owned(q22 ? uq2 : uq1, quoteTokenProgram),
      userPoolTokenAccount: uKeys[5], userPoolAccountInfo: owned(ulp, TOKEN_2022_PROGRAM_ID),
    };
    st.u.base = amt(st.u.userBaseAccountInfo); st.u.quote = amt(st.u.userQuoteAccountInfo); st.u.lp = amt(st.u.userPoolAccountInfo);
  }
  return st;
}
function swapState(st) {
  const { sdk, BN } = mods();
  return {
    globalConfig: st.globalConfig, feeConfig: st.feeConfig, poolKey: st.poolKey,
    poolAccountInfo: { ...st.poolInfo, data: Buffer.alloc(Math.max(st.poolInfo.data.length, sdk.POOL_ACCOUNT_NEW_SIZE)) },
    pool: st.pool, poolBaseAmount: new BN(st.Rb.toString()), poolQuoteAmount: new BN(st.Rq.toString()),
    baseTokenProgram: st.baseTokenProgram, quoteTokenProgram: st.quoteTokenProgram, baseMint: st.pool.baseMint,
    baseMintAccount: st.baseMintAccount, user: st.u.user, userBaseTokenAccount: st.u.userBaseTokenAccount,
    userQuoteTokenAccount: st.u.userQuoteTokenAccount, userBaseAccountInfo: st.u.userBaseAccountInfo,
    userQuoteAccountInfo: st.u.userQuoteAccountInfo,
  };
}
function liqState(st) {
  const { sdk } = mods();
  return {
    globalConfig: st.globalConfig, poolKey: st.poolKey,
    poolAccountInfo: { ...st.poolInfo, data: Buffer.alloc(Math.max(st.poolInfo.data.length, sdk.POOL_ACCOUNT_NEW_SIZE)) },
    pool: st.pool, poolBaseTokenAccount: st.poolBaseTokenAccount, poolQuoteTokenAccount: st.poolQuoteTokenAccount,
    baseTokenProgram: st.baseTokenProgram, quoteTokenProgram: st.quoteTokenProgram, user: st.u.user,
    userBaseTokenAccount: st.u.userBaseTokenAccount, userQuoteTokenAccount: st.u.userQuoteTokenAccount,
    userPoolTokenAccount: st.u.userPoolTokenAccount, userBaseAccountInfo: st.u.userBaseAccountInfo,
    userQuoteAccountInfo: st.u.userQuoteAccountInfo, userPoolAccountInfo: st.u.userPoolAccountInfo,
  };
}
// keep only the PumpSwap instruction and non-wSOL ATA creations (we wrap and unwrap SOL once for the whole tx)
function keep(ixs) {
  const { sdk, spl } = mods();
  return ixs.filter(ix => {
    if (ix.programId.equals(sdk.PUMP_AMM_PROGRAM_ID)) return true;
    if (ix.programId.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID)) return !ix.keys[3].pubkey.equals(spl.NATIVE_MINT);
    return false;
  });
}

// ---------- the math ----------
// Cost of buying exactly b base (mirrors pump-amm buy): quote in, LP fee (stays in the pool), total paid.
function buyCost(st, b) {
  const Rqe = st.Rq + st.vqr;
  if (b <= 0n) return { q: 0n, lpFee: 0n, total: 0n };
  if (b >= st.Rb) return { q: U64_MAX, lpFee: 0n, total: U64_MAX };
  const q = ceilDiv(Rqe * b, st.Rb - b);
  const f = bps => ceilDiv(q * bps, 10000n);
  return { q, lpFee: f(st.fee.lp), total: q + f(st.fee.lp) + f(st.fee.pr) + f(st.fee.cr) };
}
// Split a SOL budget into "buy b of the coin" + "deposit both sides" so almost nothing is left over.
function planPour(st, budget, slipBps) {
  let lo = 0n, hi = st.Rb / 2n;
  for (let i = 0; i < 90 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n; const c = buyCost(st, mid);
    if (c.total >= budget) { hi = mid; continue; }
    const D = budget - c.total; const Rb2 = st.Rb - mid, Rq2 = st.Rq + c.q + c.lpFee;
    if (mid * Rq2 < D * Rb2) lo = mid; else hi = mid;
  }
  const b = lo, c = buyCost(st, b);
  if (b <= 0n || c.total >= budget) throw new Error('slice too small for this pool');
  const D = budget - c.total, Rb2 = st.Rb - b, Rq2 = st.Rq + c.q + c.lpFee;
  let lp = b * st.L / Rb2; const lpQ = D * st.L / Rq2; if (lpQ < lp) lp = lpQ;
  lp = lp * (10000n - slipBps) / 10000n;
  if (lp <= 0n) throw new Error('slice too small for this pool');
  let maxBuy = c.total * (10000n + slipBps) / 10000n; if (maxBuy > budget) maxBuy = budget;
  return { baseOut: b, buyCost: c.total, maxBuy, lp, maxBase: b, maxQuoteDep: D, depBase: ceilDiv(Rb2 * lp, st.L), depQuote: ceilDiv(Rq2 * lp, st.L) };
}
// how far the price falls if `frac` of supply is sold into reserves (base B, effective quote Qe), in percent
function dumpCost(B, frac, supply) { const d = Number(supply) * frac, b = Number(B); if (!(b > 0)) return null; const r = b / (b + d); return +((1 - r * r) * 100).toFixed(2); }

// ---------- transactions ----------
async function priorityFee(keys) {
  try {
    const r = await L.remember('pp:prio:' + (keys[0] ? keys[0].toBase58() : ''), 20000, () => rpc(c => c.getRecentPrioritizationFees(keys.length ? { lockedWritableAccounts: keys.slice(0, 1) } : undefined)));
    const v = r.map(x => x.prioritizationFee).filter(x => x > 0).sort((a, b) => a - b);
    const p = v.length ? v[Math.floor(v.length * 0.7)] : 60000;
    return Math.max(25000, Math.min(1500000, p));
  } catch (e) { return 60000; }
}
async function compile(payer, ixs, cu, price, blockhash) {
  const { web3 } = mods(); const tables = await lookupTables();
  const all = [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), ...ixs];
  const msg = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: all }).compileToV0Message(tables);
  const tx = new web3.VersionedTransaction(msg);
  try { const bytes = tx.serialize(); return bytes.length <= 1232 ? { tx, bytes } : null; } catch (e) { return null; }
}
function wsolOpen(user, lamports) {
  const { spl, web3 } = mods();
  const ata = spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, user, true, spl.TOKEN_PROGRAM_ID);
  const ixs = [spl.createAssociatedTokenAccountIdempotentInstruction(user, ata, user, spl.NATIVE_MINT, spl.TOKEN_PROGRAM_ID)];
  if (lamports > 0n) ixs.push(web3.SystemProgram.transfer({ fromPubkey: user, toPubkey: ata, lamports }), spl.createSyncNativeInstruction(ata, spl.TOKEN_PROGRAM_ID));
  return ixs;
}
function wsolClose(user) { const { spl } = mods(); return spl.createCloseAccountInstruction(spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, user, true, spl.TOKEN_PROGRAM_ID), user, user, [], spl.TOKEN_PROGRAM_ID); }
function explain(sim) {
  const logs = (sim && sim.logs) || []; const l = logs.join('\n');
  const m = JSON.stringify(sim && sim.err || '').match(/"Custom":(\d+)/);
  if (/insufficient lamports|insufficient funds/i.test(l)) return 'not enough SOL in the wallet';
  if (m) return 'PumpSwap error ' + m[1];
  return 'would fail: ' + JSON.stringify(sim && sim.err).slice(0, 120);
}

// The pour: budget (lamports) from `owner` → buy → deposit → burn the LP it minted. Returns signed-ready txs (unsigned).
async function buildPour(owner, mint, budget, slipBps = 300n) {
  const { web3, spl, sdk, BN } = mods();
  const user = new web3.PublicKey(owner), poolKey = poolKeyOf(mint);
  const st = await loadState(poolKey, user);
  if (!st) throw new Error('no PumpSwap pool for this coin yet');
  if (!st.solQuoted) throw new Error('this pool is not quoted in SOL');
  const plan = planPour(st, BigInt(budget), slipBps);
  const q = sdk.buyBaseInput({ base: new BN(plan.baseOut.toString()), slippage: Number(slipBps) / 100, baseReserve: new BN(st.Rb.toString()), quoteReserve: new BN(st.Rq.toString()), virtualQuoteReserves: st.pool.virtualQuoteReserves, globalConfig: st.globalConfig, baseMintAccount: st.baseMintAccount, baseMint: st.pool.baseMint, coinCreator: st.pool.coinCreator, creator: st.pool.creator, feeConfig: st.feeConfig, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps });
  const sdkTotal = big(q.uiQuote);
  if (sdkTotal > plan.buyCost) { plan.buyCost = sdkTotal; plan.maxBuy = sdkTotal * (10000n + slipBps) / 10000n; if (plan.maxBuy > BigInt(budget)) plan.maxBuy = BigInt(budget); }
  const extend = st.poolInfo.data.length < sdk.POOL_ACCOUNT_NEW_SIZE ? [await sdk.PUMP_AMM_SDK.extendAccount(poolKey, user)] : [];
  const buy = keep(await sdk.PUMP_AMM_SDK.buyInstructions(swapState(st), new BN(plan.baseOut.toString()), new BN(plan.maxBuy.toString())));
  const dep = keep(await sdk.PUMP_AMM_SDK.depositInstructionsInternal(liqState(st), new BN(plan.lp.toString()), new BN(plan.maxBase.toString()), new BN(plan.maxQuoteDep.toString())));
  // seal: burn exactly the LP tokens this deposit mints (the LP mint is Token-2022; its authority is the pool)
  const seal = spl.createBurnInstruction(st.u.userPoolTokenAccount, st.pool.lpMint, user, plan.lp, [], spl.TOKEN_2022_PROGRAM_ID);
  const one = [...extend, ...wsolOpen(user, BigInt(budget)), ...buy, ...dep, seal, wsolClose(user)];
  const groups = (await compile(user, one, 400000, 50000, '11111111111111111111111111111111')) ? [one] : [
    [...extend, ...wsolOpen(user, plan.maxBuy), ...buy, wsolClose(user)],
    [...wsolOpen(user, plan.maxQuoteDep), ...dep, seal, wsolClose(user)],
  ];
  const { blockhash, lastValidBlockHeight } = await rpc(c => c.getLatestBlockhash('confirmed'));
  const price = await priorityFee([poolKey]);
  const txs = [];
  for (let i = 0; i < groups.length; i++) {
    const first = await compile(user, groups[i], 1_000_000, price, blockhash);
    if (!first) throw new Error('transaction too large');
    let units = 300000, sim = null;
    if (i === 0) {
      const r = await rpc(c => c.simulateTransaction(first.tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }));
      sim = r.value;
      if (sim.err) { const e = new Error(explain(sim)); e.logs = (sim.logs || []).slice(-8); throw e; }
      units = Math.min(1_400_000, Math.ceil((sim.unitsConsumed || 300000) * 1.2) + 15000);
    }
    const fin = await compile(user, groups[i], units, price, blockhash);
    txs.push({ tx: fin.tx, bytes: fin.bytes.length, units, simUnits: sim ? sim.unitsConsumed : null });
  }
  return {
    txs, blockhash, lastValidBlockHeight, pool: poolKey.toBase58(), lp: plan.lp, lpMint: st.pool.lpMint.toBase58(),
    buySol: Number(plan.buyCost) / 1e9, coinOut: plan.baseOut, depSol: Number(plan.depQuote) / 1e9, depCoin: plan.depBase, decimals: st.decimals, lpDecimals: st.lpDecimals,
  };
}

// a light read of a coin's pool for the pages (no wallet)
async function poolSnap(mint) {
  const st = await loadState(poolKeyOf(mint));
  if (!st) return null;
  const Qe = Number(st.Rq + st.vqr), B = Number(st.Rb);
  const priceLam = B > 0 ? Qe / B : 0;   // lamports per raw token
  return {
    pool: st.poolKey.toBase58(), solQuoted: st.solQuoted, depthSol: Number(st.Rq) / 1e9, lpSupply: Number(st.L), lpMint: st.pool.lpMint.toBase58(), lpDecimals: st.lpDecimals,
    priceSol: priceLam * 10 ** st.decimals / 1e9, mcapSol: priceLam * Number(st.supply) / 1e9, supply: Number(st.supply), decimals: st.decimals,
    dumpCostPct: dumpCost(st.Rb, 0.01, st.supply),
  };
}

module.exports = { mods, rpc, poolKeyOf, loadState, planPour, buyCost, dumpCost, buildPour, poolSnap, lookupTables, priorityFee };
