/* Explore: every tide, sorted three ways, with a live little tank (pool) or curve bar (bonding curve) per card. */
(function () {
  'use strict';
  const T = window.TIDE, { $, $$, esc } = T;
  let SORT = 'new', DATA = [], timer = 0, first = true, upd = 0;
  const WAVE = 'M0 3.5 Q 6.25 0 12.5 3.5 T 25 3.5 T 37.5 3.5 T 50 3.5 T 62.5 3.5 T 75 3.5 T 87.5 3.5 T 100 3.5 T 112.5 3.5 T 125 3.5 T 137.5 3.5 T 150 3.5 T 162.5 3.5 T 175 3.5 T 187.5 3.5 T 200 3.5 V7 H0 Z';
  // sealed share of LP is small early on, so the little tank fills on a log scale; the label is the true number
  const fillOf = pct => Math.max(0.06, Math.min(1, Math.log10(1 + Math.max(0, pct) * 10) / 3));

  function card(c) {
    const pool = c.phase === 'pool';
    const meter = pool
      ? `<div class="mtank"><div class="ticks"></div><div class="fill" style="--p:${fillOf(c.sealedPct).toFixed(3)}"><svg class="wv" viewBox="0 0 200 7" preserveAspectRatio="none" aria-hidden="true"><path d="${WAVE}" fill="rgba(143,220,255,.55)"/></svg><svg class="wv b" viewBox="0 0 200 7" preserveAspectRatio="none" aria-hidden="true"><path d="${WAVE}" fill="rgba(76,196,242,.5)"/></svg></div><span class="lab">LP sealed</span><span class="pct" data-f="pct">${T.pct(c.sealedPct)}</span></div>`
      : `<div class="cbar"><div class="lab"><span>bonding curve</span><b data-f="prog">${c.curveProgress == null ? '—' : T.pct(c.curveProgress * 100, 1)}</b></div><div class="track"><div class="bar" style="--p:${(c.curveProgress || 0).toFixed(4)}"></div></div></div>`;
    const cap = c.mcapUsd != null ? T.usd(c.mcapUsd) : c.mcapSol != null ? T.sol(c.mcapSol) : '—';
    const right = pool ? `<b data-f="sealed">${T.sol(c.sealedSol, false)}</b> SOL sealed` : `<b data-f="burned">${T.pct(c.burnedPct)}</b> supply burned`;
    return `<a class="tcard rv" href="/coin?m=${encodeURIComponent(c.mint)}" data-m="${esc(c.mint)}" data-ph="${esc(c.phase)}">
      <div class="top"><img class="im" src="${esc(c.image)}" alt="" loading="lazy" decoding="async"><div style="min-width:0"><div class="nm">${esc(c.name)}</div><div class="sy">$${esc(c.symbol)}</div></div><span class="chip ${esc(c.phase)}">${pool ? 'pool' : 'curve'}</span></div>
      ${meter}
      <div class="row"><div class="big"><span data-f="cap">${cap}</span><small>MCAP</small></div><div class="sm">${right}</div></div></a>`;
  }
  function skeleton() {
    $('#grid').innerHTML = Array.from({ length: 6 }, () => `<div class="tcard skc"><div class="top"><div class="sk im"></div><div><div class="sk sk-line" style="width:70%"></div><div class="sk sk-line" style="width:40%"></div></div><span></span></div><div class="sk" style="height:64px;border-radius:6px"></div><div class="sk sk-line" style="width:50%"></div></div>`).join('');
  }
  function visible() {
    const q = ($('#q').value || '').trim().toLowerCase();
    return q ? DATA.filter(c => (c.name || '').toLowerCase().includes(q) || (c.symbol || '').toLowerCase().includes(q) || (c.mint || '').toLowerCase() === q) : DATA;
  }
  function render(animate) {
    const g = $('#grid'), list = visible();
    const draw = () => {
      if (!DATA.length) { g.innerHTML = `<div class="state"><img src="/assets/img/drop-s.png" alt=""><div class="big">No tides yet.</div><div class="small">be the first · <a href="/launch">/launch</a></div></div>`; }
      else if (!list.length) g.innerHTML = `<div class="state"><div class="big">Nothing matches that.</div><div class="small">try a name, a ticker or a full CA</div></div>`;
      else { g.innerHTML = list.map(card).join(''); $$('.tcard', g).forEach((el, i) => el.style.setProperty('--d', Math.min(i, 12) * 45 + 'ms')); T.reveal(g); }
      g.classList.remove('fading');
    };
    if (animate && !T.RM()) { g.classList.add('fading'); setTimeout(draw, 220); } else draw();
    $('#exCount').textContent = DATA.length ? `${list.length} of ${DATA.length} tides` : '';
  }
  // refresh in place so the meters glide instead of the grid redrawing
  function patch() {
    const by = new Map(DATA.map(c => [c.mint, c]));
    const cards = $$('.tcard[data-m]');
    const ids = cards.map(el => el.dataset.m), want = visible().map(c => c.mint);
    if (ids.length !== want.length || ids.some((m, i) => m !== want[i]) || cards.some(el => by.get(el.dataset.m) && by.get(el.dataset.m).phase !== el.dataset.ph)) return render(false);
    for (const el of cards) {
      const c = by.get(el.dataset.m); if (!c) continue;
      const set = (f, v) => { const x = el.querySelector(`[data-f="${f}"]`); if (x && x.textContent !== v) x.textContent = v; };
      set('cap', c.mcapUsd != null ? T.usd(c.mcapUsd) : c.mcapSol != null ? T.sol(c.mcapSol) : '—');
      if (c.phase === 'pool') { set('pct', T.pct(c.sealedPct)); set('sealed', T.sol(c.sealedSol, false)); const f = el.querySelector('.fill'); if (f) f.style.setProperty('--p', fillOf(c.sealedPct).toFixed(3)); }
      else { set('prog', c.curveProgress == null ? '—' : T.pct(c.curveProgress * 100, 1)); set('burned', T.pct(c.burnedPct)); const b = el.querySelector('.bar'); if (b) b.style.setProperty('--p', (c.curveProgress || 0).toFixed(4)); }
    }
  }
  async function load(animate) {
    clearTimeout(timer);
    const j = await T.api('/api/coins?sort=' + SORT + '&limit=120');
    if (!j || !j.ok) {
      if (first) $('#grid').innerHTML = `<div class="state"><div class="big">Engine data unavailable.</div><div class="small">retrying…</div></div>`;
      $('#exUpd').textContent = 'retrying…';
    } else {
      const changedSort = animate; DATA = j.coins || []; upd = Date.now();
      if (first || changedSort) render(!first); else patch();
      first = false; $('#exUpd').textContent = 'live · updates every 15s';
    }
    timer = setTimeout(() => { if (!document.hidden) load(false); else timer = setTimeout(() => load(false), 4000); }, 15000);
  }
  function ink() { const b = $('.tabs [aria-selected="true"]'), k = $('.tabs .ink'); if (!b || !k) return; k.style.width = b.offsetWidth + 'px'; k.style.transform = `translateX(${b.offsetLeft}px)`; }
  function boot() {
    skeleton();
    $$('.tabs [data-sort]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.sort === SORT) return;
      SORT = b.dataset.sort; $$('.tabs [data-sort]').forEach(x => x.setAttribute('aria-selected', String(x === b))); ink(); load(true);
    }));
    let qt = 0; $('#q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => render(false), 120); });
    addEventListener('resize', ink); requestAnimationFrame(ink); document.fonts && document.fonts.ready.then(ink);
    load(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
