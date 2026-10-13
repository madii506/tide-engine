/* Launch: the form, the wallet, one deposit to the coin's own engine wallet, then status until the coin is live. */
(function () {
  'use strict';
  const T = window.TIDE, { $, $$, esc } = T;
  const CREATE = 0.03, RESERVE = 0.015;
  const needSol = dev => Math.ceil((CREATE + dev * 1.02 + RESERVE) * 1000) / 1000;
  let IMG = null, DEV = 0.1, L = null, poll = 0, busy = false;

  // ---------- image ----------
  function setImg(file) {
    const dz = $('#dz');
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) { dz.classList.add('bad'); err('Use a PNG, JPG, WEBP or GIF.'); return; }
    if (file.size > 1.5 * 1024 * 1024) { dz.classList.add('bad'); err('That picture is over 1.5 MB.'); return; }
    const r = new FileReader();
    r.onload = () => { IMG = r.result; $('#dzImg').src = IMG; dz.classList.add('has'); dz.classList.remove('bad'); err(''); rail(1, 'pin'); };
    r.readAsDataURL(file);
  }
  function imageUi() {
    const dz = $('#dz'), f = $('#file');
    dz.addEventListener('click', e => { if (e.target !== f) { e.preventDefault(); f.click(); } });
    dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); f.click(); } });
    f.addEventListener('change', () => setImg(f.files[0]));
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', e => setImg(e.dataTransfer.files[0]));
  }

  // ---------- fields ----------
  const RX = { tw: /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}(\/status\/\d+)?\/?$/, tg: /^https:\/\/t\.me\/[A-Za-z0-9_+\/-]{3,80}$/, web: /^https:\/\/[^\s"'<>]{3,200}$/ };
  function fieldErr(id, msg) { const e = $('#' + id + 'E'), i = $('#' + id); if (e) e.textContent = msg || ''; if (i) i.classList.toggle('bad', !!msg); return !msg; }
  function validate(show) {
    const name = $('#name').value.trim(), sym = $('#symbol').value.trim().replace(/^\$/, '').toUpperCase();
    let ok = true;
    const chk = (id, bad, msg) => { if (bad) { ok = false; if (show) fieldErr(id, msg); } else fieldErr(id, ''); };
    chk('name', !name || new TextEncoder().encode(name).length > 32, 'Give the coin a name (up to 32 characters).');
    chk('symbol', !/^[A-Z0-9]{1,10}$/.test(sym), 'The ticker is 1–10 letters or numbers.');
    for (const k of ['tw', 'tg', 'web']) { const v = $('#' + k).value.trim(); chk(k, v && !RX[k].test(v), k === 'tw' ? 'Use https://x.com/yourcoin' : k === 'tg' ? 'Use https://t.me/yourcoin' : 'Start with https://'); }
    if (!IMG) { ok = false; if (show) { $('#dz').classList.add('bad'); } }
    if (!(DEV >= 0.01 && DEV <= 5)) { ok = false; if (show) err('The dev buy is between 0.01 and 5 SOL.'); }
    return ok;
  }
  function fieldsUi() {
    const cnt = (id, c, n) => { const i = $('#' + id); i.addEventListener('input', () => { $('#' + c).textContent = `${new TextEncoder().encode(i.value).length}/${n}`; if (i.classList.contains('bad')) validate(true); }); };
    cnt('name', 'nameC', 32); cnt('symbol', 'symC', 10);
    $('#symbol').addEventListener('input', e => { const i = e.target, p = i.selectionStart; i.value = i.value.replace(/[^A-Za-z0-9$]/g, '').toUpperCase(); try { i.setSelectionRange(p, p); } catch {} });
    $$('[data-dev]').forEach(b => b.addEventListener('click', () => { DEV = +b.dataset.dev; $('#devC').value = ''; paintDev(); }));
    $('#devC').addEventListener('input', e => { const v = parseFloat(e.target.value.replace(',', '.')); DEV = isFinite(v) ? v : 0; paintDev(); });
    paintDev();
  }
  function paintDev() {
    $$('[data-dev]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.dev === DEV && !$('#devC').value)));
    const ok = DEV >= 0.01 && DEV <= 5;
    $('#needL').textContent = ok ? `deposit ${T.sol(needSol(DEV))}` : '0.01 – 5 SOL';
    $('#devNote').textContent = ok ? `You send ${T.sol(needSol(DEV))} once: ${T.sol(CREATE, false)} creation, your ${T.sol(DEV)} first buy, ${T.sol(RESERVE, false)} gas reserve. Unused SOL comes back.` : 'Pick a first buy between 0.01 and 5 SOL.';
  }
  function err(m) { $('#formErr').textContent = m || ''; }

  // ---------- the rail ----------
  const STEPS = ['pin', 'deposit', 'create', 'live'];
  function rail(k, on, bad) {
    const r = $('#rail'); r.style.setProperty('--k', String(Math.max(0, Math.min(1, k / 3))));
    $$('.rs', r).forEach(s => { const i = STEPS.indexOf(s.dataset.s), j = STEPS.indexOf(on); s.classList.toggle('done', i < j || (on === 'live' && i === j)); s.classList.toggle('on', i === j && on !== 'live'); s.classList.toggle('bad', !!bad && i === j); });
  }

  // ---------- wallet ----------
  function paintWallet() {
    const w = T.wallet(), row = $('#walletRow');
    row.innerHTML = w ? `<span class="wdot"></span><span>${esc(w.name)}</span><span class="addr">${esc(T.short(w.pk, 5))}</span><button type="button" id="wOut">disconnect</button>` : '';
    if (w) $('#wOut').addEventListener('click', () => T.disconnect());
    if (!L) $('#go').innerHTML = w ? 'Launch <span class="ar">→</span>' : 'Connect wallet <span class="ar">→</span>';
  }
  function picker() {
    const ws = T.wallets(), p = $('#picker');
    if (ws.length <= 1) return T.connect(ws[0] && ws[0].id);
    p.hidden = false;
    p.innerHTML = ws.map(w => `<button type="button" data-w="${w.id}"><span class="wi"></span>${esc(w.name)}</button>`).join('');
    return new Promise(res => { p.onclick = async e => { const b = e.target.closest('[data-w]'); if (!b) return; p.hidden = true; res(await T.connect(b.dataset.w)); }; });
  }

  // ---------- launch ----------
  async function go(e) {
    e && e.preventDefault(); if (busy) return; err('');
    if (!T.wallet()) { if (!T.wallets().length) { err('No Solana wallet found. Install Phantom, Solflare or Backpack, then reload.'); return; } await picker(); return; }
    if (!validate(true)) { err(IMG ? 'Fix the fields marked above.' : 'Add a picture for the coin.'); return; }
    busy = true; const btn = $('#go'); btn.classList.add('busy'); btn.innerHTML = '<span class="spin"></span> Preparing';
    const body = { op: 'prepare', name: $('#name').value.trim(), symbol: $('#symbol').value.trim().replace(/^\$/, '').toUpperCase(), description: $('#desc').value.trim(),
      twitter: $('#tw').value.trim(), telegram: $('#tg').value.trim(), website: $('#web').value.trim(), image: IMG, devBuySol: DEV, owner: T.wallet().pk };
    const r = await T.post('/api/launch?op=prepare', body);
    busy = false; btn.classList.remove('busy');
    if (!r || !r.ok) { btn.innerHTML = 'Launch <span class="ar">→</span>'; err((r && r.error) || 'The engine didn’t answer. Try again.'); return; }
    L = { ...r, symbol: body.symbol }; try { localStorage.setItem('tide:launch', JSON.stringify(L)); } catch {}
    btn.innerHTML = 'Waiting for deposit'; btn.disabled = true;
    rail(1, 'deposit'); depositCard(); sendDeposit();
    clearInterval(poll); poll = setInterval(status, 2500); status();
  }
  function depositCard() {
    const f = $('#flow'); f.hidden = false;
    f.innerHTML = `<div class="card dep" id="dep">
      <div class="ch"><span class="lbl">Deposit · one transfer</span><span class="exp" id="exp"></span></div>
      <div class="amount">${esc(T.sol(L.depositSol, false))}<small>SOL</small></div>
      <div class="to">to the coin’s own engine wallet, which becomes its pump.fun creator:</div>
      <div class="addrbox"><code>${esc(L.wallet)}</code><button class="copy" type="button" data-copy="${esc(L.wallet)}" data-what="Address copied">copy</button></div>
      <div class="acts"><button class="btn sm" type="button" id="send">Send from wallet <span class="ar">→</span></button><button class="copy" type="button" data-copy="${esc(L.depositSol)}" data-what="Amount copied">copy amount</button></div>
      <div class="msg" id="depMsg">Approve the transfer in your wallet. Or send exactly this amount from any wallet: the launch starts the moment it lands.</div>
    </div>`;
    $('#send').addEventListener('click', sendDeposit);
    tickExp(); clearInterval(depositCard.t); depositCard.t = setInterval(tickExp, 30000);
    f.scrollIntoView({ behavior: T.RM() ? 'auto' : 'smooth', block: 'center' });
  }
  function tickExp() { const e = $('#exp'); if (!e || !L) return; const m = Math.max(0, Math.round((L.expiresAt - Date.now()) / 60000)); e.textContent = m > 0 ? `refunds itself in ${m >= 60 ? Math.floor(m / 60) + 'h ' : ''}${m % 60}m if unfunded` : 'expired'; }
  async function web3() { if (window.solanaWeb3) return window.solanaWeb3; await new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/assets/js/web3.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); return window.solanaWeb3; }
  async function sendDeposit() {
    const w = T.wallet() || await picker(); if (!w || !L) return;
    const msg = $('#depMsg');
    try {
      const { Transaction, SystemProgram, PublicKey } = await web3();
      const bh = await T.api('/api/launch?op=blockhash'); if (!bh || !bh.ok) throw new Error('Solana didn’t answer. Try again.');
      const from = new PublicKey(w.pk);
      const tx = new Transaction({ feePayer: from, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }).add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(L.wallet), lamports: L.depositLamports }));
      msg.textContent = 'Approve the transfer in your wallet…';
      let sig = null;
      if (w.p.signAndSendTransaction) { const r = await w.p.signAndSendTransaction(tx); sig = r && (r.signature || r); }
      else { const s = await w.p.signTransaction(tx); const r = await T.post('/api/launch?op=relay', { tx: btoa(String.fromCharCode(...s.serialize())) }); if (!r.ok) throw new Error(r.error); sig = r.sig; }
      msg.innerHTML = `Sent: <a href="${T.txUrl(String(sig))}" target="_blank" rel="noopener">${esc(T.short(String(sig), 6))}</a>. Waiting for it to land…`;
    } catch (e) { msg.innerHTML = `<span class="bad">${esc((e && e.message) || 'The transfer was cancelled.')}</span> You can also send it from any wallet.`; }
  }
  let lastState = '';
  async function status() {
    if (!L) return;
    const r = await T.api('/api/launch?op=status&id=' + encodeURIComponent(L.id));
    if (!r || !r.ok) return;
    if (r.state === lastState && r.state !== 'awaiting_deposit') return; lastState = r.state;
    if (r.state === 'awaiting_deposit') { const m = $('#depMsg'); if (m && r.balanceSol > 0) m.textContent = `${T.sol(r.balanceSol)} of ${T.sol(r.depositSol)} has arrived…`; return; }
    if (r.state === 'creating') { rail(2, 'create'); const d = $('#dep'); if (d) d.querySelector('.msg').innerHTML = '<span class="status"><span class="spin"></span> Deposit in. Creating the coin on pump.fun…</span>'; return; }
    clearInterval(poll); try { localStorage.removeItem('tide:launch'); } catch {}
    if (r.state === 'live') { rail(3, 'live'); done(r); return; }
    rail(2, 'create', true);
    $('#flow').innerHTML = `<div class="card result badres"><span class="lbl">${esc(r.state)}</span><h3>The launch didn’t go through.</h3><p class="muted">${esc(r.message || '')}${r.refundSig ? ` Refund: <a href="${T.txUrl(r.refundSig)}" target="_blank" rel="noopener">${esc(T.short(r.refundSig, 6))}</a>` : ''}</p><div class="acts"><a class="btn sm" href="/launch">Try again</a></div></div>`;
  }
  function done(r) {
    const mint = r.mint;
    $('#flow').innerHTML = `<div class="card result">
      <span class="lbl hi">live · the engine is attached</span>
      <h3>$${esc(r.symbol || L.symbol)} is in the water.</h3>
      <p class="muted" style="margin:0">Its creator fees now pour back into its own pool, every minute, for as long as it trades.</p>
      <div class="addrbox"><code>${esc(mint)}</code><button class="copy" type="button" data-copy="${esc(mint)}" data-what="CA copied">copy CA</button></div>
      <div class="acts"><a class="btn sm" href="/coin?m=${encodeURIComponent(mint)}">Its tide page <span class="ar">→</span></a><a class="btn sm ghost" href="https://pump.fun/coin/${encodeURIComponent(mint)}" target="_blank" rel="noopener">pump.fun ↗</a></div></div>`;
    $('#go').innerHTML = 'Launched';
    if (T.water) T.water.fall({ big: true });
    T.toast('Live ✓');
  }

  function resume() { try { const s = JSON.parse(localStorage.getItem('tide:launch') || 'null'); if (s && s.id && Date.now() < s.expiresAt + 6 * 36e5) { L = s; $('#go').innerHTML = 'Waiting for deposit'; $('#go').disabled = true; rail(1, 'deposit'); depositCard(); poll = setInterval(status, 2500); status(); } } catch {} }
  function boot() {
    imageUi(); fieldsUi(); paintWallet(); resume();
    document.addEventListener('tide:wallet', () => { paintWallet(); $('#picker').hidden = true; });
    $('#form').addEventListener('submit', go);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
