/* TIDE fx: the motion layer on every page. Drops fall from wherever you click into the tide, the water stirs under
   the cursor and swells while you scroll, the mark drips now and then, motes drift up through the dark, a soft light
   follows the pointer, buttons fill like glass and ripple where pressed, headings draw a wave, sections surface line
   by line, cards tilt. Pure decoration: none of it is data. Everything here stays still under reduced motion. */
(function () {
  'use strict';
  const T = window.TIDE; if (!T || !T.$) return;
  const { $, $$ } = T;
  const html = document.documentElement;
  const RM = T.RM();
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const W = () => T.water;

  // the first-visit entrance is pure CSS; drop its class once it has played
  if (html.classList.contains('intro')) setTimeout(() => html.classList.remove('intro'), RM ? 0 : 3400);

  // ---------- headings get a wave that draws itself; sections surface child by child ----------
  const WAVE = 'M0 5 Q 6 1 12 5 T 24 5 T 36 5 T 48 5 T 60 5 T 72 5 T 84 5 T 96 5 T 108 5 T 120 5';
  $$('.sec h2').forEach(h => { if (!h.querySelector('.hw')) h.insertAdjacentHTML('beforeend', `<svg class="hw" viewBox="0 0 72 10" aria-hidden="true"><path d="${WAVE}"/></svg>`); });
  $$('.sec.rv').forEach(sec => { [...sec.children].forEach((el, i) => el.style.setProperty('--i', i)); $$('.prose > *', sec).forEach((p, k) => p.style.setProperty('--j', k)); });

  if (RM) return;                                                   // everything below moves

  // ---------- click anywhere quiet: a small drop falls from there into the tide ----------
  const QUIET = 'a,button,input,textarea,select,label,summary,[role=button],[data-copy],.v,.fig,.chart,.tcard,.form,.dz,.picker,.flow,.tip,.toast,.tankc,.sgrid,.ltable,.feed,.machine,.tabs,.search,.coin-head';
  let lastDrop = 0, falling = 0;
  document.addEventListener('click', e => {
    if (e.button !== 0 || e.defaultPrevented || !W()) return;
    if (e.target.closest && e.target.closest(QUIET)) return;
    const sel = window.getSelection && getSelection(); if (sel && String(sel).length) return;
    const t = performance.now(); if (t - lastDrop < 130 || falling > 5) return;
    lastDrop = t; falling++; setTimeout(() => falling--, 1500);
    W().fall({ x: e.clientX, y: e.clientY, small: true });
  });

  // ---------- the cursor trails through the water; scrolling makes the tide swell ----------
  if (fine) {
    let lx = -1, lt = 0;
    addEventListener('pointermove', e => {
      const w = W(); if (!w || e.pointerType !== 'mouse') return;
      const surf = w.cv.getBoundingClientRect().top + w.base();
      if (e.clientY < surf - 40) { lx = -1; return; }
      const t = performance.now(); if (t - lt < 60) return;
      const v = lx < 0 ? 0 : Math.abs(e.clientX - lx) / Math.max(16, t - lt);
      lx = e.clientX; lt = t;
      if (v > 0.04) w.stir(e.clientX, 0.7 + v * 1.4);
    }, { passive: true });
  }
  let sy = scrollY, st = performance.now();
  addEventListener('scroll', () => {
    const t = performance.now(), v = Math.abs(scrollY - sy) / Math.max(16, t - st); sy = scrollY; st = t;
    const w = W(); if (w && v > 0.2) w.surge(Math.min(0.04, v * 0.012));
  }, { passive: true });

  // ---------- the mark lets a drop go now and then, while it is on screen ----------
  const mark = $('.mast .mark');
  if (mark) {
    let seen = true;
    if ('IntersectionObserver' in window) new IntersectionObserver(es => { seen = es[es.length - 1].isIntersecting; }).observe(mark);
    const drip = () => {
      const w = W();
      if (w && seen && !document.hidden) {
        mark.classList.remove('drip'); void mark.offsetWidth; mark.classList.add('drip');
        setTimeout(() => { const r = mark.getBoundingClientRect(); w.fall({ x: r.left + r.width / 2, y: r.bottom - 8, small: true }); }, 240);
      }
      setTimeout(drip, 8000 + Math.random() * 6000);
    };
    setTimeout(drip, html.classList.contains('intro') ? 4600 : 3000);
  }

  // ---------- motes drifting up through the dark, nearer ones moving with the page ----------
  const mc = document.createElement('canvas'); mc.id = 'motes'; mc.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(mc, document.body.firstChild);
  const g = mc.getContext('2d'); let MW = 0, MH = 0; const motes = [];
  const mote = any => ({ x: Math.random() * MW, y: any ? Math.random() * MH : MH + 8, z: 0.3 + Math.random() * 0.7, v: 5 + Math.random() * 12, p: Math.random() * 6.283, r: 0.45 + Math.random() * 1.05 });
  function fit() {
    const dpr = Math.min(2, devicePixelRatio || 1); MW = innerWidth; MH = innerHeight;
    mc.width = Math.round(MW * dpr); mc.height = Math.round(MH * dpr); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(70, Math.max(18, MW * MH / 24000)));
    while (motes.length < n) motes.push(mote(true)); motes.length = n;
  }
  fit(); addEventListener('resize', fit);
  let mt = 0, msy = scrollY;
  T.addLoop && T.addLoop(t => {
    const dt = mt ? Math.min(0.05, t - mt) : 0, ds = scrollY - msy; mt = t; msy = scrollY;
    g.clearRect(0, 0, MW, MH);
    for (const m of motes) {
      m.y -= m.v * m.z * dt + ds * 0.14 * m.z;
      m.x += Math.sin(t * 0.55 + m.p) * 0.1 * m.z;
      if (m.y < -10) Object.assign(m, mote(false)); else if (m.y > MH + 10) { Object.assign(m, mote(false)); m.y = -6; }
      const a = (0.08 + 0.24 * m.z) * (0.6 + 0.4 * Math.sin(t * 1.2 + m.p * 3));
      g.fillStyle = `rgba(150,222,255,${a.toFixed(3)})`;
      g.beginPath(); g.arc(m.x, m.y, m.r * m.z + 0.25, 0, 6.2832); g.fill();
    }
  });

  // ---------- a soft light under the pointer ----------
  if (fine && T.addLoop) {
    const lamp = document.createElement('div'); lamp.className = 'lamp'; lamp.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(lamp, document.body.firstChild);
    let tx = innerWidth / 2, ty = innerHeight * 0.3, x = tx, y = ty;
    addEventListener('pointermove', e => { tx = e.clientX; ty = e.clientY; lamp.classList.add('on'); }, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => lamp.classList.remove('on'));
    T.addLoop(() => {
      if (Math.abs(tx - x) < 0.2 && Math.abs(ty - y) < 0.2) return;
      x += (tx - x) * 0.12; y += (ty - y) * 0.12;
      lamp.style.transform = `translate3d(${(x - 320).toFixed(1)}px,${(y - 320).toFixed(1)}px,0)`;
    });
  }

  // ---------- a ripple where a button is pressed (the liquid fill on hover is CSS) ----------
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest && e.target.closest('.btn, .chipbtn, .tabs button, .copy');
    if (!b || b.disabled) return;
    let box = b.querySelector(':scope > .rips');
    if (!box) { box = document.createElement('span'); box.className = 'rips'; box.setAttribute('aria-hidden', 'true'); b.appendChild(box); }
    const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height) * 2.3;
    const d = document.createElement('i');
    d.style.cssText = `left:${(e.clientX - r.left - s / 2).toFixed(1)}px;top:${(e.clientY - r.top - s / 2).toFixed(1)}px;width:${s.toFixed(1)}px;height:${s.toFixed(1)}px`;
    box.appendChild(d); setTimeout(() => d.remove(), 750);
  }, { passive: true });

  // ---------- cards lean toward the pointer, with a glint where it is ----------
  if (fine) {
    let cur = null;
    const off = () => { if (!cur) return; cur.classList.remove('tilt'); ['--rx', '--ry'].forEach(k => cur.style.removeProperty(k)); cur = null; };
    document.addEventListener('pointermove', e => {
      const c = e.target.closest && e.target.closest('.tcard:not(.skc)');
      if (c !== cur) off();
      if (!c) return; cur = c; c.classList.add('tilt');
      const r = c.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      c.style.setProperty('--rx', ((0.5 - py) * 6).toFixed(2) + 'deg'); c.style.setProperty('--ry', ((px - 0.5) * 8).toFixed(2) + 'deg');
      c.style.setProperty('--mx', (px * 100).toFixed(1) + '%'); c.style.setProperty('--my', (py * 100).toFixed(1) + '%');
    }, { passive: true });
    document.addEventListener('pointerleave', e => { if (e.target === cur) off(); }, true);
  }
})();
