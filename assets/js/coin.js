/* One tide: its tank, its numbers, its sealed-liquidity chart and every step of its engine, live. */
(function () {
  'use strict';
  const T = window.TIDE, { $, $$, esc } = T;
  const mint = new URLSearchParams(location.search).get('m') || '';
  let C = null, tank = null, seenRows = null, showAll = false, timer = 0;
  const fillOf = pct => Math.max(0.05, Math.min(1, Math.log10(1 + Math.max(0, pct) * 10) / 3));

  function missing(msg) {
    $('#coin').innerHTML = `<div class="coin-missing"><h1>No tide here.</h1><p>${esc(msg || 'That address isn’t a coin launched on TIDE.')}</p><div class="go-row" style="margin-top:28px"><a class="btn" href="/explore">Explore tides <span class="ar">→</span></a></div></div>`;
  }
  function links(c) {
    const out = [`<a class="lnk" href="https://pump.fun/coin/${encodeURIComponent(c.mint)}" target="_blank" rel="noopener">pump.fun <span class="ar">↗</span></a>`,
      `<a class="lnk" href="https://dexscreener.com/solana/${encodeURIComponent(c.mint)}" target="_blank" rel="noopener">dexscreener <span class="ar">↗</span></a>`,
      `<a class="lnk" href="https://solscan.io/token/${encodeURIComponent(c.mint)}" target="_blank" rel="noopener">solscan <span class="ar">↗</span></a>`,
      `<a class="lnk" href="https://solscan.io/account/${encodeURIComponent(c.wallet)}" target="_blank" rel="noopener">engine wallet <span class="ar">↗</span></a>`];
    if (c.twitter) out.push(`<a class="lnk" href="${esc(c.twitter)}" target="_blank" rel="noopener nofollow">x <span class="ar">↗</span></a>`);
    if (c.telegram) out.push(`<a class="lnk" href="${esc(c.telegram)}" target="_blank" rel="noopener nofollow">telegram <span class="ar">↗</span></a>`);
    if (c.website && !/\/coin\?m=/.test(c.website)) out.push(`<a class="lnk" href="${esc(c.website)}" target="_blank" rel="noopener nofollow">web <span class="ar">↗</span></a>`);
    return out.join('');
  }
  function stats(c) {
    const pool = c.phase === 'pool';
    const S = [
      ['depth', `Depth <i>Q</i>`, T.sol(c.depthSol, false), 'SOL', pool ? 'SOL side of the pool' : 'virtual SOL on the curve'],
      ['sealed', 'SOL sealed', T.sol(c.sealedSol, false), 'SOL', pool ? `${c.seals} seal${c.seals === 1 ? '' : 's'}` : 'starts at graduation'],
      ['lp', 'LP sealed', pool ? T.pct(c.sealedPct) : '—', '', pool ? 'of the pool’s LP, burned' : 'no pool yet'],
      ['burned', 'Supply burned', T.pct(c.burnedPct), '', `${T.compact(c.burnedTokens)} tokens on the curve`],
      ['dump', 'Dump cost', c.dumpCostPct == null ? '—' : '−' + T.pct(c.dumpCostPct, 2), '', 'price drop if 1% of supply sells'],
      ['p', 'Unspent <i>P</i>', T.sol(c.unspentSol, false), 'SOL', 'claimed, waiting to pour'],
      ['tau', 'Next slice <i>τ</i>', c.nextSliceSol > 0 ? T.sol(c.nextSliceSol, false) : 'waits', c.nextSliceSol > 0 ? 'SOL' : '', c.nextSliceSol > 0 ? 'on the next pass' : 'P is under 0.01 SOL'],
      ['claimed', 'Claimed', T.sol(c.claimedSol, false), 'SOL', 'creator fees, all time'],
      ['mcap', 'Market cap', c.mcapUsd != null ? T.usd(c.mcapUsd) : c.mcapSol != null ? T.sol(c.mcapSol, false) : '—', c.mcapUsd != null ? '' : 'SOL', c.priceSol ? `${c.priceSol.toExponential(2)} SOL / token` : ''],
      ['last', 'Last action', c.lastActionAt ? T.ago(c.lastActionAt) : '—', '', `${c.passes} pass${c.passes === 1 ? '' : 'es'} that poured`],
    ];
    return S.map(([k, lab, val, unit, sub]) => `<div class="s" data-s="${k}"><div class="k">${lab}</div><div class="val">${esc(val)}${unit ? `<small>${unit}</small>` : ''}</div><div class="sub">${esc(sub)}</div></div>`).join('');
  }
  function amount(r) {
    const s = T.sol, k = T.compact;
    switch (r.kind) {
      case 'claim': return `+${s(r.sol)} <span class="nt">creator fees claimed</span>`;
      case 'buy': return `${s(r.sol)} → ${k(r.tokens)} <span class="nt">bought</span>`;
      case 'burn': return `${k(r.tokens)} <span class="nt">burned for good</span>`;
      case 'pair': return `${s(r.sol)} + ${k(r.tokens)} <span class="nt">into the pool · ${k(r.lp)} LP</span>`;
      case 'seal': return `${k(r.lp)} LP <span class="nt">burned · ${s(r.sol)} sealed forever</span>`;
      default: return `<span class="nt">${esc(r.note || '')}</span>`;
    }
  }
  function ledger(c) {
    const rows = showAll ? c.ledger : c.ledger.slice(0, 25);
    const key = r => r.t + ':' + r.kind + ':' + (r.sig || '');
    const fresh = seenRows ? new Set(rows.filter(r => !seenRows.has(key(r))).map(key)) : new Set();
    seenRows = new Set(c.ledger.map(key));
    if (!rows.length) return `<div class="chart"><div class="none">No passes yet. The engine claims the first fees within a minute of the first trades.</div></div>`;
    return `<div class="tscroll"><table class="ltable"><thead><tr><th>time</th><th>step</th><th>amounts</th><th>tx</th></tr></thead><tbody>${rows.map(r => `<tr class="${fresh.has(key(r)) ? 'in' : ''}">
      <td class="t" title="${new Date(r.t).toLocaleString()}">${T.ago(r.t)}</td><td><span class="badge ${esc(r.kind)}">${esc(r.kind)}</span></td><td class="amt">${amount(r)}</td>
      <td class="tx">${r.sig ? `<a href="${T.txUrl(r.sig)}" target="_blank" rel="noopener">${esc(T.short(r.sig, 4))} ↗</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>
      ${c.ledger.length > 25 && !showAll ? `<div class="ledger-more"><button class="btn sm ghost" type="button" id="more">show all ${c.ledger.length}</button></div>` : ''}`;
  }
  // the sealed-liquidity chart: cumulative SOL sealed over time
  function chart(c) {
    const box = $('#chart'); if (!box) return;
    const h = c.history || [];
    if (h.length < 1) { box.innerHTML = `<div class="none">${c.phase === 'pool' ? 'No seals yet. The first pour lands on the next pass with enough fees.' : 'Sealing starts at graduation. Until then the engine buys and burns on the curve.'}</div>`; return; }
    const pts = h.length === 1 ? [[h[0][0] - 60000, 0], h[0]] : [[h[0][0] - 1, 0], ...h];
    const t0 = pts[0][0], t1 = Math.max(pts[pts.length - 1][0], t0 + 60000), ymax = Math.max(...pts.map(p => p[1])) * 1.15 || 1;
    const W = 1000, H = 300, X = t => (t - t0) / (t1 - t0) * W, Y = v => H - v / ymax * H;
    let d = `M${X(pts[0][0]).toFixed(1)},${Y(pts[0][1]).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += ` H${X(pts[i][0]).toFixed(1)} V${Y(pts[i][1]).toFixed(1)}`;   // steps: sealed only ever rises
    d += ` H${W}`;
    const grid = [0.25, 0.5, 0.75].map(k => `<line class="gl" x1="0" x2="${W}" y1="${(H * k).toFixed(0)}" y2="${(H * k).toFixed(0)}"/>`).join('');
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="SOL sealed over time"><defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(76,196,242,.45)"/><stop offset="1" stop-color="rgba(15,95,149,0)"/></linearGradient></defs>${grid}<path class="ar" d="${d} V${H} H0 Z" fill="url(#ga)"/><path class="ln" d="${d}"/></svg>
      <span class="ax" style="left:8px;bottom:4px">${new Date(t0).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><span class="ax" style="right:8px;top:10px">${T.sol(ymax / 1.15)}</span>
      <span class="cross"></span><span class="cdot"></span><span class="clab"></span>`;
    const ln = box.querySelector('.ln');
    if (!T.RM() && ln.getTotalLength) { const L = ln.getTotalLength(); ln.style.strokeDasharray = L; ln.style.strokeDashoffset = L; ln.getBoundingClientRect(); ln.style.transition = 'stroke-dashoffset 1.6s cubic-bezier(.2,.7,.2,1)'; ln.style.strokeDashoffset = '0'; }
    requestAnimationFrame(() => box.classList.add('drawn'));
    const svg = box.querySelector('svg');
    const move = e => {
      const r = svg.getBoundingClientRect(); const x = Math.max(0, Math.min(r.width, (e.touches ? e.touches[0].clientX : e.clientX) - r.left));
      const t = t0 + x / r.width * (t1 - t0); let v = 0, at = pts[0][0]; for (const p of pts) if (p[0] <= t) { v = p[1]; at = p[0]; }
      const y = r.height - v / ymax * r.height, off = svg.offsetLeft;
      box.querySelector('.cross').style.left = (off + x) + 'px'; const dot = box.querySelector('.cdot'); dot.style.left = (off + x) + 'px'; dot.style.top = (svg.offsetTop + y) + 'px';
      const lab = box.querySelector('.clab'); lab.textContent = `${T.sol(v)} sealed · ${new Date(Math.max(at, t0)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      lab.style.left = Math.min(off + x + 12, box.clientWidth - lab.offsetWidth - 6) + 'px'; box.classList.add('hov');
    };
    svg.addEventListener('mousemove', move); svg.addEventListener('touchmove', move, { passive: true });
    svg.addEventListener('mouseleave', () => box.classList.remove('hov')); svg.addEventListener('touchend', () => box.classList.remove('hov'));
  }
  function tankText(c) {
    const pool = c.phase === 'pool';
    return pool
      ? { l: 'Sealed liquidity', v: `${T.sol(c.sealedSol, false)}<small>SOL</small>`, s: `${T.pct(c.sealedPct)} of the pool’s LP is burned. It can never be withdrawn.` }
      : { l: 'Bonding curve', v: `${c.curveProgress == null ? '—' : T.pct(c.curveProgress * 100, 1)}`, s: `On the curve the engine buys and burns: ${T.pct(c.burnedPct)} of supply so far. Sealing starts at graduation.` };
  }
  function first(c) {
    document.title = `$${c.symbol} · ${c.name} · TIDE`;
    const t = tankText(c);
    $('#coin').innerHTML = `
      <div class="coin-head rv"><img class="im" src="${esc(c.image)}" alt=""><div style="min-width:0">
        <h1>${esc(c.name)} <span class="sy">$${esc(c.symbol)}</span> <span class="chip ${esc(c.phase)}" id="phase">${c.phase === 'pool' ? 'pool' : esc(c.phase)}</span></h1>
        <div class="ca"><code>${esc(c.mint)}</code><button class="copy" type="button" data-copy="${esc(c.mint)}" data-what="CA copied">copy CA</button></div>
        <div class="links">${links(c)}</div></div></div>
      ${c.description ? `<p class="coin-desc rv">${esc(c.description.split('\n\n')[0])}</p>` : ''}
      <div class="coin-grid rv">
        <div class="tankc"><canvas id="tank" aria-hidden="true"></canvas><span class="lbl tl" id="tl">${t.l}</span><div class="tv" id="tv">${t.v}</div><div class="ts" id="ts">${esc(t.s)}</div></div>
        <div class="sgrid" id="sgrid">${stats(c)}</div>
      </div>
      <div class="beat rv" id="beat"><span class="pulse"></span><span>the engine visits every minute</span></div>
      <section class="panel rv"><div class="ph"><span class="lbl">SOL sealed over time · <i class="hi" style="font-family:var(--serif);letter-spacing:0;text-transform:none">dL/dt ≥ 0</i></span><span class="lbl" id="chartN"></span></div><div class="chart" id="chart"></div></section>
      <section class="panel rv"><div class="ph"><span class="lbl">The ledger · every step, on chain</span><span class="lbl" id="ledN"></span></div><div id="ledger">${ledger(c)}</div></section>`;
    T.reveal($('#coin'));
    const cv = $('#tank');
    if (cv && T.Water) tank = new T.Water(cv, { mode: 'tank', ticks: c.phase !== 'pool', padTop: 0.32, shafts: 4 });
    level(c, true); chart(c); wire();
  }
  function level(c, now) { if (!tank) return; tank.setLevel(c.phase === 'pool' ? fillOf(c.sealedPct) : Math.max(0.03, c.curveProgress || 0), now); }
  function wire() { const m = $('#more'); if (m) m.addEventListener('click', () => { showAll = true; $('#ledger').innerHTML = ledger(C); wire(); }); }
  function update(c) {
    const old = C; C = c;
    const g = $('#sgrid'); const prev = {}; $$('.s', g).forEach(s => prev[s.dataset.s] = s.querySelector('.val').textContent);
    g.innerHTML = stats(c);
    $$('.s', g).forEach(s => { if (prev[s.dataset.s] != null && prev[s.dataset.s] !== s.querySelector('.val').textContent) s.classList.add('flash'); });
    const t = tankText(c); $('#tl').textContent = t.l; $('#tv').innerHTML = t.v; $('#ts').textContent = t.s;
    if (old.phase !== c.phase) { $('#phase').className = 'chip ' + c.phase; $('#phase').textContent = c.phase; if (tank) { tank.ticks = c.phase !== 'pool'; tank.gauge = null; } }
    level(c);
    const newPour = c.ledger.find(r => (r.kind === 'seal' || r.kind === 'burn') && (!old.ledger[0] || r.t > old.ledger[0].t));
    if (newPour && tank) tank.fall({ size: 1.3 });
    if ((c.history || []).length !== (old.history || []).length) chart(c);
    $('#ledger').innerHTML = ledger(c); wire();
    $('#ledN').textContent = `${c.ledger.length} rows`;
  }
  function beat() {
    const b = $('#beat'); if (!b || !T.stats) return;
    const lp = T.stats.lastPassAt; const next = lp ? Math.max(0, Math.round((lp + 60000 - Date.now()) / 1000)) : null;
    b.innerHTML = `<span class="pulse"></span><span>the engine visits every minute · last pass <b>${lp ? T.ago(lp) : '—'}</b>${next != null ? ` · next in about <b>${next || 'a few '}s</b>` : ''}</span>`;
  }
  async function load() {
    clearTimeout(timer);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) { missing('Open a tide from /explore, or add ?m=<its CA> to the address.'); return; }
    const j = await T.api('/api/coin?m=' + encodeURIComponent(mint));
    if (!j) { if (!C) $('#coin').innerHTML = `<div class="coin-missing"><h1>Engine data unavailable.</h1><p>Retrying…</p></div>`; }
    else if (!j.ok) { if (!C) missing(j.error); return; }
    else if (!C) { C = j.coin; first(C); $('#ledN').textContent = `${C.ledger.length} rows`; }
    else update(j.coin);
    timer = setTimeout(() => { if (!document.hidden) load(); else timer = setTimeout(load, 3000); }, 8000);
  }
  function boot() { load(); setInterval(beat, 1000); document.addEventListener('tide:stats', beat); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
