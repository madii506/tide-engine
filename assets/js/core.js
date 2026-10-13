/* TIDE core: shared by every page. The masthead stats, the page's water and the drops that fall when the engine
   seals, reveals, tooltips, copy, toasts, wallets, and the page-transition fallback. Never shows a made-up number:
   until the engine answers, values read "—". */
(function () {
  'use strict';
  const T = window.TIDE = window.TIDE || {};
  const X_URL = 'https://x.com/';                       // the project's X account (set when it exists)
  document.documentElement.classList.add('js');
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const RM = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  Object.assign(T, { $, $$, esc, RM, X_URL });

  // ---------- data ----------
  async function api(path, ms = 12000) {
    try { const r = await fetch(path, { signal: AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined, cache: 'no-store' }); const j = await r.json(); return j; }
    catch (e) { return null; }
  }
  async function post(path, body, ms = 30000) {
    try { const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined }); return await r.json(); }
    catch (e) { return { ok: false, error: 'The engine didn’t answer. Try again.' }; }
  }
  // ---------- numbers ----------
  function sol(v, unit = true) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v); const d = a === 0 ? 0 : a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: d ? Math.min(2, d) : 0, maximumFractionDigits: d }) + (unit ? ' SOL' : '');
  }
  function compact(v, prefix = '') {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    const [n, s] = a >= 1e9 ? [v / 1e9, 'B'] : a >= 1e6 ? [v / 1e6, 'M'] : a >= 1e3 ? [v / 1e3, 'K'] : [v, ''];
    const d = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
    return prefix + Number(n.toFixed(d)).toLocaleString('en-US') + s;
  }
  const usd = v => compact(v, '$');
  function pct(v, d) { if (v == null || !isFinite(v)) return '—'; const a = Math.abs(v); const k = d != null ? d : a >= 10 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4; return Number(v).toFixed(k).replace(/\.?0+$/, m => m.includes('.') ? '' : m) + '%'; }
  function ago(ms) {
    if (!ms) return '—'; const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return Math.max(1, Math.round(s)) + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago'; if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago';
  }
  const short = (a, n = 4) => a ? String(a).slice(0, n) + '…' + String(a).slice(-n) : '';
  const txUrl = s => 'https://solscan.io/tx/' + encodeURIComponent(s);
  Object.assign(T, { api, post, sol, compact, usd, pct, ago, short, txUrl });

  // ---------- small UI ----------
  let tt = 0;
  function toast(m) {
    let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2000);
  }
  async function copy(text, what, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch {} ta.remove(); }
    toast(ok ? (what || 'Copied') + ' ✓' : 'Copy failed');
    if (btn && ok) { const t0 = btn.textContent; btn.classList.add('done'); btn.textContent = 'copied'; setTimeout(() => { btn.classList.remove('done'); btn.textContent = t0; }, 1400); }
  }
  document.addEventListener('click', e => { const b = e.target.closest('[data-copy]'); if (b) { e.preventDefault(); copy(b.getAttribute('data-copy'), b.getAttribute('data-what') || 'Copied', b.matches('.copy') ? b : null); } });
  function countUp(el, to, fmt, ms = 900) {
    if (!el) return; const from = Number(el.dataset.val || 0); el.dataset.val = to;
    if (RM() || !isFinite(to) || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = t => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function reveal(root = document) {
    const els = $$('.rv:not(.vis)', root); if (!els.length) return;
    if (!('IntersectionObserver' in window) || RM()) { els.forEach(e => e.classList.add('vis')); return; }
    const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { en.target.classList.add('vis'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    els.forEach(e => io.observe(e));
  }
  // tooltips for the variables in the paper: <span class="v" data-tip="…">
  function tips() {
    let tip = null, cur = null;
    const show = el => { if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); } cur = el; tip.innerHTML = el.getAttribute('data-tip'); tip.classList.add('on');
      const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight; let x = r.left + r.width / 2 - w / 2, y = r.top - h - 10; if (y < 8) y = r.bottom + 10; x = Math.max(8, Math.min(innerWidth - w - 8, x)); tip.style.transform = `translate(${x}px,${y}px)`;
      $$(`.v[data-sym="${el.getAttribute('data-sym')}"]`).forEach(v => v.classList.add('on')); };
    const hide = () => { if (tip) tip.classList.remove('on'); $$('.v.on').forEach(v => v.classList.remove('on')); cur = null; };
    $$('.v[data-tip]').forEach(v => { v.tabIndex = 0; v.addEventListener('mouseenter', () => show(v)); v.addEventListener('mouseleave', hide); v.addEventListener('focus', () => show(v)); v.addEventListener('blur', hide); v.addEventListener('click', () => (cur === v ? hide() : show(v))); });
    addEventListener('scroll', () => cur && hide(), { passive: true });
  }
  Object.assign(T, { toast, copy, countUp, reveal });

  // ---------- nav ----------
  function nav() {
    const p = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
    $$('.nav a').forEach(a => { const h = a.getAttribute('href'); if (h === p || (h === '/' && (p === '/' || p === '/index'))) a.setAttribute('aria-current', 'page'); });
    $$('[data-x]').forEach(a => { a.href = X_URL; });
  }

  // ---------- the page's water + the engine's pulse ----------
  let water = null;
  function initWater() {
    const cv = $('#water'); if (!cv || !T.Water) return;
    water = T.water = new T.Water(cv, { mode: 'page' });
  }
  const listeners = [];
  T.onLedger = fn => listeners.push(fn);
  let seen = null, firstLedger = true;
  async function ledger() {
    const j = await api('/api/ledger?limit=24');
    if (!j || !j.ok) { listeners.forEach(f => f(null, [])); return; }
    const key = r => r.t + ':' + (r.sig || '') + ':' + r.kind;
    const fresh = [];
    if (seen) for (const r of j.items) { if (seen.has(key(r))) break; fresh.push(r); }
    seen = new Set(j.items.map(key));
    if (!firstLedger && water) {
      let n = 0; for (const r of fresh.slice().reverse()) { if (r.kind === 'seal' || r.kind === 'burn') setTimeout(() => water.fall({ big: r.kind === 'seal' && r.sol > 0.5 }), 260 * n++); }
    }
    listeners.forEach(f => f(j.items, firstLedger ? [] : fresh));
    firstLedger = false;
  }
  T.stats = null;
  async function stats() {
    const j = await api('/api/stats');
    const eg = $('#engine');
    if (!j || !j.ok) { if (eg) { eg.className = 'engine err'; eg.innerHTML = '<span class="pulse"></span><span>engine data unavailable · retrying</span>'; } return; }
    T.stats = j;
    countUp($('#sTides'), j.tides, v => Math.round(v).toLocaleString('en-US'));
    countUp($('#sSeals'), j.seals + j.burns, v => Math.round(v).toLocaleString('en-US'));
    countUp($('#sSol'), j.sealedSol, v => sol(v, false));
    if (water) water.setSol(j.sealedSol, !water._set); if (water) water._set = true;
    if (eg) {
      eg.className = 'engine ' + (j.engineOk ? 'ok' : 'err');
      eg.innerHTML = `<span class="pulse"></span><span>${j.engineOk ? `engine running · last pass ${ago(j.lastPassAt)}` : j.lastPassAt ? `engine paused · last pass ${ago(j.lastPassAt)}` : 'engine waiting for its first pass'}</span>`;
    }
    document.dispatchEvent(new CustomEvent('tide:stats', { detail: j }));
  }

  // ---------- wallets (Phantom, Solflare, Backpack) ----------
  const wallets = () => [
    { id: 'phantom', name: 'Phantom', p: (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom ? window.solana : null) },
    { id: 'solflare', name: 'Solflare', p: window.solflare && window.solflare.isSolflare ? window.solflare : null },
    { id: 'backpack', name: 'Backpack', p: window.backpack && (window.backpack.solana || window.backpack) },
  ].filter(w => w.p);
  let WAL = null;
  async function connect(id) {
    const ws = wallets(); if (!ws.length) { toast('No Solana wallet found in this browser'); return null; }
    const w = ws.find(x => x.id === id) || ws[0];
    try { const r = await w.p.connect(); const pk = (r && r.publicKey) || w.p.publicKey; WAL = { ...w, pk: pk.toString() }; try { localStorage.setItem('tide:w', w.id); } catch {} document.dispatchEvent(new CustomEvent('tide:wallet', { detail: WAL })); return WAL; }
    catch { toast('Wallet connection was cancelled'); return null; }
  }
  function disconnect() { try { WAL && WAL.p.disconnect && WAL.p.disconnect(); } catch {} WAL = null; try { localStorage.removeItem('tide:w'); } catch {} document.dispatchEvent(new CustomEvent('tide:wallet', { detail: null })); }
  async function silent() { try { const id = localStorage.getItem('tide:w'); const w = wallets().find(x => x.id === id); if (w) { const r = await w.p.connect({ onlyIfTrusted: true }); const pk = (r && r.publicKey) || w.p.publicKey; if (pk) { WAL = { ...w, pk: pk.toString() }; document.dispatchEvent(new CustomEvent('tide:wallet', { detail: WAL })); } } } catch {} }
  Object.assign(T, { wallets, connect, disconnect, wallet: () => WAL });

  // ---------- page transitions: native cross-document view transitions, a fade where unsupported ----------
  function transitions() {
    const native = 'onpagereveal' in window || (CSS && CSS.supports && CSS.supports('view-transition-name: a') && 'navigation' in window && 'activation' in (window.navigation || {}));
    if (native || RM()) return;
    document.documentElement.classList.add('vtf');
    document.addEventListener('click', e => {
      const a = e.target.closest('a[href]'); if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
      const u = new URL(a.href, location.href); if (u.origin !== location.origin || u.pathname.startsWith('/api') || (u.pathname === location.pathname && u.search === location.search)) return;
      e.preventDefault(); document.documentElement.classList.add('leaving'); setTimeout(() => { location.href = u.href; }, 180);
    });
    addEventListener('pageshow', () => document.documentElement.classList.remove('leaving'));
  }

  function boot() {
    nav(); initWater(); reveal(); tips(); transitions(); silent();
    stats(); setInterval(() => { if (!document.hidden) stats(); }, 15000);
    ledger(); setInterval(() => { if (!document.hidden) ledger(); }, 8000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { stats(); ledger(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
