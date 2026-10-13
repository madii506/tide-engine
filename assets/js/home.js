/* The paper: figure 1 (live τ math with a small tank), the machine's steps lighting up, and the live ledger strip. */
(function () {
  'use strict';
  const T = window.TIDE, { $, $$, esc } = T;

  // ---------- figure 1 ----------
  const QMAX = 500, PMIN = 0.001, PMAX = 10;
  const qOf = v => Math.round(Math.pow(10, (v / 1000) * Math.log10(QMAX)) * 10) / 10;          // 1 … 500 SOL
  const pOf = v => +(PMIN * Math.pow(PMAX / PMIN, v / 1000)).toPrecision(3);                       // 0.001 … 10 SOL
  let tank = null, lastTau = null, dropT = 0;
  function fig() {
    const rQ = $('#rQ'), rP = $('#rP'); if (!rQ) return;
    const cv = $('#figTank'); if (cv && T.Water) tank = new T.Water(cv, { mode: 'tank', padTop: 0.16, shafts: 3, bubbles: 6, amp: 0.8 });
    const upd = (fromUser) => {
      const Q = qOf(+rQ.value), P = pOf(+rP.value);
      for (const r of [rQ, rP]) r.style.setProperty('--p', (r.value / 10) + '%');
      $('#oQ').textContent = T.sol(Q); $('#oP').textContent = T.sol(P);
      const floor = Math.max(0.01, Q / 200), tau = Math.min(P, floor), waits = P < 0.01;
      const f = n => T.sol(n, false);
      $('#cSub').innerHTML = waits
        ? `τ = min(<b>${f(P)}</b>, max(0.01, <b>${f(Q)}</b> / 200)) → <span class="wait">waits</span>`
        : `τ = min(<b>${f(P)}</b>, max(0.01, <b>${f(Q)}</b> / 200)) = <span class="tau">${T.sol(tau)}</span>`;
      const half = tau / 2, move = (Math.pow(1 + half / Q, 2) - 1) * 100;
      $('#cFacts').innerHTML = waits ? `<span class="wait">P is under τ<sub>min</sub>: the engine waits for more fees.</span>`
        : `<span>buys <b>${f(half)}</b></span><span>pairs <b>${f(half)}</b></span><span>price <b>+${T.pct(move, move < 0.1 ? 3 : 2)}</b></span><span>${P > floor ? 'depth-capped' : 'all of P'}</span>`;
      $('#figQv').textContent = 'Q ' + f(Q);
      $('#figState').textContent = waits ? 'waiting' : 'pour';
      if (tank) {
        tank.setLevel(0.12 + 0.78 * Math.log10(Q) / Math.log10(QMAX));
        if (fromUser && !waits && tau !== lastTau) { clearTimeout(dropT); dropT = setTimeout(() => tank.fall({ size: Math.min(1.6, 0.4 + Math.log10(1 + tau * 10)) }), 160); }
      }
      lastTau = tau;
    };
    rQ.addEventListener('input', () => upd(true)); rP.addEventListener('input', () => upd(true));
    upd(false);
    // a gentle drop now and then while the figure is on screen
    if ('IntersectionObserver' in window && tank) {
      let on = false; new IntersectionObserver(es => { on = es[0].isIntersecting; }, { threshold: 0.3 }).observe($('#fig1'));
      setInterval(() => { if (on && !document.hidden && lastTau && pOf(+rP.value) >= 0.01) tank.fall({ size: 0.7 }); }, 5200);
    }
  }

  // ---------- the machine: steps light up in order, faster and brighter when a real pass lands ----------
  const ORDER = ['claim', 'keep', 'size', 'buy', 'pair', 'seal'];
  let mt = 0, running = false;
  function sweep(live) {
    const rows = ORDER.map(k => $(`.mrow[data-k="${k}"]`)).filter(Boolean); if (!rows.length) return;
    clearTimeout(mt); running = true;
    rows.forEach(r => r.classList.remove('lit', 'live'));
    const step = live ? 380 : 900;
    rows.forEach((r, i) => setTimeout(() => { r.classList.add('lit'); if (live) r.classList.add('live'); if (i > 0) setTimeout(() => rows[i - 1].classList.remove('lit', 'live'), step * 0.6); }, i * step));
    mt = setTimeout(() => { rows.forEach(r => r.classList.remove('lit', 'live')); running = false; const tag = $('#mtag'); if (tag) tag.classList.remove('on'); mt = setTimeout(() => sweep(false), 2200); }, rows.length * step + 700);
  }
  function machine() {
    const m = $('#machine'); if (!m) return;
    if (T.RM()) return;
    if ('IntersectionObserver' in window) { let started = false; new IntersectionObserver(es => { if (es[0].isIntersecting && !started) { started = true; sweep(false); } }, { threshold: 0.25 }).observe(m); }
    else sweep(false);
  }

  // ---------- the live strip ----------
  const short = n => T.compact(n);
  function what(r) {
    const s = T.sol;
    switch (r.kind) {
      case 'claim': return `<span class="amt">+${s(r.sol)} claimed</span>`;
      case 'buy': return `<span class="amt">${s(r.sol)} → ${short(r.tokens)}</span>`;
      case 'burn': return `<span class="amt">${short(r.tokens)} burned</span>`;
      case 'pair': return `<span class="amt">${s(r.sol)} + ${short(r.tokens)} paired</span>`;
      case 'seal': return `<span class="amt">${s(r.sol)} sealed · ${short(r.lp)} LP burned</span>`;
      default: return `<span class="amt">${esc(r.note || '')}</span>`;
    }
  }
  function feed(items, fresh) {
    const ul = $('#feed'); if (!ul) return;
    if (items == null) { if (!ul.querySelector('li:not(.empty):not(.err)')) ul.innerHTML = '<li class="err">engine data unavailable · retrying</li>'; return; }
    if (!items.length) { ul.innerHTML = '<li class="empty">No passes yet. The first tide’s fees will show up here, step by step.</li>'; return; }
    const isNew = new Set(fresh.map(r => r.t + ':' + r.sig + ':' + r.kind));
    ul.innerHTML = items.slice(0, 8).map(r => `<li class="${isNew.has(r.t + ':' + r.sig + ':' + r.kind) ? 'in' : ''}">
      <span class="badge ${esc(r.kind)}">${esc(r.kind)}</span>
      <a class="what" href="/coin?m=${encodeURIComponent(r.mint)}"><span class="sym">$${esc(r.symbol)}</span>${what(r)}</a>
      <span class="when"><span>${T.ago(r.t)}</span>${r.sig ? `<a href="${T.txUrl(r.sig)}" target="_blank" rel="noopener" aria-label="transaction">tx ↗</a>` : ''}</span></li>`).join('');
    if (fresh.some(r => r.kind === 'seal' || r.kind === 'burn')) { const tag = $('#mtag'); if (tag) tag.classList.add('on'); sweep(true); }
  }

  function boot() { fig(); machine(); T.onLedger(feed); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
