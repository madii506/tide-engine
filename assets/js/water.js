/* TIDE water: one engine for the page's tide (fixed to the bottom of every page) and for the glass tanks.
   Layered sine swell, a crisp glowing surface line, light shafts, rising bubbles, falling drops with
   ripples and splash. One requestAnimationFrame for every canvas, paused when the tab is hidden,
   drawn once and left still under prefers-reduced-motion. */
(function () {
  'use strict';
  const T = window.TIDE = window.TIDE || {};
  const RMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const now = () => Date.now() / 1000;            // wall clock, so the swell continues across page loads
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---- one loop for every canvas ----
  const loops = new Set(); let raf = 0;
  function frame() {
    raf = 0; if (document.hidden) return;
    const t = now();
    for (const f of loops) f(t);
    if (loops.size) raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf && loops.size && !document.hidden) raf = requestAnimationFrame(frame); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else wake(); });
  // other effects (motes, cursor light) share the same frame
  T.addLoop = fn => { if (RMQ.matches) return false; loops.add(fn); wake(); return true; };
  T.removeLoop = fn => loops.delete(fn);

  // a soft vertical light shaft, drawn once and stretched
  let SHAFT = null;
  function shaftSprite() {
    if (SHAFT) return SHAFT;
    const c = document.createElement('canvas'); c.width = 64; c.height = 256;
    const g = c.getContext('2d'), im = g.createImageData(64, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 64; x++) {
      const h = Math.exp(-Math.pow((x - 32) / 13, 2)), v = Math.pow(1 - y / 256, 1.6);
      const a = h * v, i = (y * 64 + x) * 4;
      im.data[i] = 150; im.data[i + 1] = 224; im.data[i + 2] = 255; im.data[i + 3] = Math.round(a * 255);
    }
    g.putImageData(im, 0, 0); return (SHAFT = c);
  }

  class Water {
    /* opts: mode 'page' | 'tank'; level (0..1); amp (swell scale); bubbles (count); ticks (draw a gauge); pad (tank margins) */
    constructor(canvas, o = {}) {
      this.cv = canvas; this.g = canvas.getContext('2d');
      this.mode = o.mode || 'page';
      this.amp = o.amp != null ? o.amp : 1;
      this.level = o.level != null ? o.level : (this.mode === 'page' ? 0.07 : 0);
      this.target = this.level;
      this.ticks = !!o.ticks;
      this.nb = o.bubbles != null ? o.bubbles : null;
      this.padTop = o.padTop != null ? o.padTop : 0.14;
      this.rips = []; this.parts = []; this.drops = []; this.flashes = []; this.bubbles = [];
      this.shafts = Array.from({ length: o.shafts != null ? o.shafts : 5 }, (_, i) => ({ s: Math.random(), w: rand(26, 70), v: rand(4, 11) * (i % 2 ? 1 : -1), a: rand(.5, 1), p: rand(0, 6.28) }));
      this.seed = rand(0, 100);
      this.boost = 0;                                  // extra swell from scrolling and engine passes, decays
      this.visible = true; this.last = now(); this.dirty = true;
      this.tick = this.tick.bind(this);
      this.resize();
      if ('ResizeObserver' in window) { this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas); }
      else addEventListener('resize', () => this.resize());
      if (this.mode === 'tank' && 'IntersectionObserver' in window) {
        this.io = new IntersectionObserver(es => { this.visible = es[es.length - 1].isIntersecting; if (this.visible) this.draw(now()); }, { rootMargin: '80px' });
        this.io.observe(canvas);
      }
      this.draw(now());
      if (!RMQ.matches) { loops.add(this.tick); wake(); }
      RMQ.addEventListener && RMQ.addEventListener('change', () => { if (RMQ.matches) { loops.delete(this.tick); this.level = this.target; this.draw(now()); } else { loops.add(this.tick); wake(); } });
    }
    get still() { return RMQ.matches; }

    resize() {
      const r = this.cv.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (w === this.W && h === this.H && dpr === this.dpr) return;
      this.W = w; this.H = h; this.dpr = dpr;
      this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.A = (this.mode === 'page' ? Math.min(7, Math.max(3.5, w / 220)) : Math.min(5, Math.max(2.2, w / 120))) * this.amp;
      const n = this.nb != null ? this.nb : (this.mode === 'page' ? (w < 700 ? 8 : 15) : Math.round(Math.min(12, w / 40)));
      this.bubbles = Array.from({ length: n }, () => this.newBubble(true));
      this.gauge = null;
      this.draw(now());
    }

    // baseline of the surface, in canvas px
    base(level = this.level) {
      if (this.mode === 'page') return this.H - level * (this.H / 0.3);         // canvas is 30% of the viewport tall
      const top = this.H * this.padTop, bot = 4;
      return this.H - bot - level * (this.H - top - bot);
    }
    setLevel(frac, immediate) {
      this.target = Math.max(0, Math.min(1, frac));
      if (immediate || this.still) { this.level = this.target; this.draw(now()); }
    }
    // the page's tide: 7% of the viewport when empty, 22% at 1,000 SOL sealed, on a log scale
    setSol(sol, immediate) {
      const s = Math.max(0, Number(sol) || 0);
      const k = Math.min(1, Math.log10(1 + s) / Math.log10(1 + 1000));
      this.setLevel(0.07 + 0.15 * k, immediate);
    }

    surf(x, t) {
      const A = this.A * (1 + this.boost), sd = this.seed;
      let y = this.base()
        - A * 0.55 * Math.sin(x * 0.0102 + t * 0.62 + sd)
        - A * 0.32 * Math.sin(x * 0.0231 - t * 0.93 + 1.7 + sd)
        - A * 0.13 * Math.sin(x * 0.0513 + t * 1.41 + 0.4);
      for (const r of this.rips) {
        const age = t - r.t0; if (age < 0) continue;
        const dx = Math.abs(x - r.x), front = age * r.c;
        if (dx > front + 60) continue;
        const env = Math.exp(-age * 1.1) * Math.exp(-dx / r.L) * (dx < front ? 1 : Math.exp(-(dx - front) / 14));
        y += r.a * env * Math.sin(dx * r.k - age * 8.5);
        y += r.a * 1.3 * Math.exp(-age * 5) * Math.exp(-(dx * dx) / (r.L * 3));
      }
      return y;
    }

    newBubble(anywhere) {
      const W = this.W || 300, H = this.H || 200, b0 = this.base();
      return { x: rand(0, W), y: anywhere ? rand(b0 + 10, H + 20) : H + rand(4, 60), r: rand(.9, this.mode === 'page' ? 3 : 2.4), v: rand(10, 30), p: rand(0, 6.28) };
    }

    // something landed at x: ripples, rings, a splash
    splash(x, power = 1) {
      const t = now(), p = Math.max(.35, Math.min(3, power));
      this.rips.push({ x, t0: t, a: (this.mode === 'page' ? 4.2 : 3.2) * p, c: 170 + 60 * p, k: 0.075, L: 160 + 90 * p });
      if (this.rips.length > 14) this.rips.shift();
      this.flashes.push({ x, t0: t, p });
      const n = Math.round((this.mode === 'page' ? 9 : 7) * Math.min(2.2, p));
      const y = this.base();
      for (let i = 0; i < n; i++) this.parts.push({ x: x + rand(-3, 3), y: y - 1, vx: rand(-55, 55) * Math.sqrt(p), vy: -rand(70, 170) * Math.sqrt(p), r: rand(.8, 1.9) * Math.sqrt(p), t0: t });
      if (this.parts.length > 80) this.parts.splice(0, this.parts.length - 80);
      if (this.still) this.draw(t);
    }

    // a hand trailing through the water: a soft ripple, no splash
    stir(x, p = 1) {
      if (this.still) return;
      this.rips.push({ x, t0: now(), a: Math.min(2.4, 0.9 * p), c: 150, k: 0.08, L: 110, soft: true });
      if (this.rips.length > 14) this.rips.shift();
    }
    // the whole tide swells for a moment (scrolling, an engine pass)
    surge(k = 0.5) { if (!this.still) this.boost = Math.min(1.6, this.boost + k); }

    // tank mode: a drop falls inside the canvas. page mode: a glowing drop element falls from the top of the viewport.
    fall(o = {}) {
      if (this.still) return;
      const x = o.x != null ? o.x : rand(this.W * 0.12, this.W * 0.88);
      if (this.mode === 'tank') { this.drops.push({ x, y: -14, vy: 40, s: o.size || 1 }); return; }
      const big = !!o.big, sm = !big && !!o.small;
      const w = big ? 34 : sm ? 10 : 15, h = big ? 50 : sm ? 15 : 22;
      const vx = o.x != null ? o.x : rand(innerWidth * 0.08, innerWidth * 0.92);
      const top = this.cv.getBoundingClientRect().top;
      const y1 = top + this.base(this.target) - h * 0.82, y0 = o.y != null ? o.y - h * 0.6 : -h - 20;
      if (y0 >= y1 - 6) { this.splash(vx, sm ? 0.6 : 0.9); return; }     // already in the water
      const el = document.createElement('div');
      el.className = 'fdrop' + (big ? ' big' : sm ? ' sm' : ''); el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<img src="/assets/img/drop-192.png" alt="">';
      document.body.appendChild(el);
      const dur = Math.max(o.y != null ? 380 : 700, Math.sqrt(Math.max(100, y1 - y0)) * (big ? 50 : 40));
      const L = vx - w / 2;
      const a = el.animate([
        { transform: `translate3d(${L}px,${y0}px,0) scale(.75,.75)`, opacity: 0 },
        { transform: `translate3d(${L}px,${y0 + 30}px,0) scale(.9,1)`, opacity: 1, offset: .07 },
        { transform: `translate3d(${L}px,${y1}px,0) scale(.84,1.2)`, opacity: 1 }
      ], { duration: dur, easing: 'cubic-bezier(.45,0,.92,.55)', fill: 'forwards' });
      const land = () => { el.remove(); this.splash(vx, big ? 2.6 : sm ? 0.75 : 1); };
      a.onfinish = land; a.oncancel = () => el.remove();
    }

    tick(t) {
      if (!this.visible) { this.last = t; return; }
      const dt = Math.min(0.05, Math.max(0, t - this.last)); this.last = t;
      if (Math.abs(this.target - this.level) > 1e-5) this.level += (this.target - this.level) * (1 - Math.exp(-dt * 1.3));
      if (this.boost) { this.boost *= Math.exp(-dt * 1.25); if (this.boost < 0.002) this.boost = 0; }
      // bubbles
      for (const b of this.bubbles) {
        b.y -= b.v * dt; b.x += Math.sin(t * 1.7 + b.p) * 0.22;
        if (b.y < this.surf(b.x, t) + 3) Object.assign(b, this.newBubble(false));
      }
      // drops inside a tank
      for (const d of this.drops) {
        d.vy += 900 * dt; d.y += d.vy * dt;
        if (d.y >= this.surf(d.x, t) - 2) { d.done = true; this.splash(d.x, 0.8 + d.s * 0.6); }
      }
      if (this.drops.length) this.drops = this.drops.filter(d => !d.done);
      // splash droplets
      for (const p of this.parts) { p.vy += 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
      if (this.parts.length) this.parts = this.parts.filter(p => p.y < this.base() + 6 && t - p.t0 < 2.5);
      if (this.rips.length) this.rips = this.rips.filter(r => t - r.t0 < 4.5);
      if (this.flashes.length) this.flashes = this.flashes.filter(f => t - f.t0 < 1.2);
      this.draw(t);
    }

    draw(t) {
      const g = this.g, W = this.W, H = this.H; if (!W || !H) return;
      g.clearRect(0, 0, W, H);
      const step = W > 900 ? 6 : 5, page = this.mode === 'page';
      const b0 = this.base();
      // the surface, once
      const pts = new Float32Array(Math.ceil(W / step) + 2); let minY = H;
      for (let i = 0, x = 0; i < pts.length; i++, x += step) { const y = this.surf(Math.min(x, W), t); pts[i] = y; if (y < minY) minY = y; }
      const edge = new Path2D(); edge.moveTo(0, pts[0]);
      for (let i = 1, x = step; i < pts.length; i++, x += step) edge.lineTo(Math.min(x, W), pts[i]);
      const body = new Path2D(edge); body.lineTo(W, H + 2); body.lineTo(0, H + 2); body.closePath();

      // a faint haze above the water
      const hz = g.createLinearGradient(0, minY - (page ? 90 : 50), 0, b0 + 4);
      hz.addColorStop(0, 'rgba(76,196,242,0)'); hz.addColorStop(1, page ? 'rgba(76,196,242,0.075)' : 'rgba(76,196,242,0.09)');
      g.fillStyle = hz; g.fillRect(0, minY - (page ? 90 : 50), W, b0 - minY + (page ? 96 : 56));

      // back swell, a little higher and out of phase
      const back = new Path2D(); const sd = this.seed + 2.1;
      for (let x = 0; x <= W + step; x += step) {
        const xx = Math.min(x, W);
        const Ab = this.A * (1 + this.boost);
        const y = b0 - 3.5 - Ab * 0.6 * Math.sin(xx * 0.0083 - t * 0.47 + sd) - Ab * 0.3 * Math.sin(xx * 0.019 + t * 0.71 + sd * 2);
        x === 0 ? back.moveTo(xx, y) : back.lineTo(xx, y);
      }
      back.lineTo(W, H + 2); back.lineTo(0, H + 2); back.closePath();
      g.fillStyle = 'rgba(15,95,149,0.22)'; g.fill(back);

      // the body of the water
      const depth = Math.max(30, H - minY);
      const wg = g.createLinearGradient(0, minY, 0, H);
      wg.addColorStop(0, page ? 'rgba(83,200,243,0.40)' : 'rgba(83,200,243,0.46)');
      wg.addColorStop(Math.min(.5, 22 / depth), page ? 'rgba(25,120,180,0.40)' : 'rgba(25,120,180,0.5)');
      wg.addColorStop(Math.min(.85, 90 / depth), page ? 'rgba(12,70,115,0.50)' : 'rgba(12,70,115,0.62)');
      wg.addColorStop(1, page ? 'rgba(2,12,24,0.92)' : 'rgba(2,12,24,0.95)');
      g.fillStyle = wg; g.fill(body);

      // under the surface: light shafts and bubbles
      g.save(); g.clip(body);
      g.globalCompositeOperation = 'lighter';
      const sp = shaftSprite(), sh = H - minY + 10;
      for (const s of this.shafts) {
        const span = W + 240, x = ((s.s * span + t * s.v) % span + span) % span - 120;
        g.globalAlpha = (page ? .05 : .07) * s.a * (0.6 + 0.4 * Math.sin(t * 0.33 + s.p));
        g.setTransform(this.dpr, 0, 0.32 * this.dpr, this.dpr, x * this.dpr, minY * this.dpr);
        g.drawImage(sp, -s.w / 2, 0, s.w, sh);
      }
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.globalAlpha = 1;
      // a glow where something just landed
      for (const f of this.flashes) {
        const k = (t - f.t0) / 1.2, rr = 30 + 90 * k * f.p;
        const fg = g.createRadialGradient(f.x, b0, 0, f.x, b0, rr);
        fg.addColorStop(0, `rgba(143,220,255,${0.32 * (1 - k)})`); fg.addColorStop(1, 'rgba(143,220,255,0)');
        g.fillStyle = fg; g.fillRect(f.x - rr, b0 - rr, rr * 2, rr * 2);
      }
      g.globalCompositeOperation = 'source-over';
      g.lineWidth = 0.8;
      for (const b of this.bubbles) {
        const a = 0.18 + 0.22 * Math.min(1, (H - b.y) / 120);
        g.strokeStyle = `rgba(205,238,255,${a})`;
        g.beginPath(); g.arc(b.x, b.y, b.r, 0, 6.2832); g.stroke();
        if (b.r > 1.6) { g.fillStyle = `rgba(235,250,255,${a + .1})`; g.fillRect(b.x - b.r * .45, b.y - b.r * .55, 1, 1); }
      }
      g.restore();

      // the surface line: a wide soft glow, a tighter glow, a crisp core
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = 'rgba(76,196,242,0.10)'; g.lineWidth = 8; g.stroke(edge);
      g.strokeStyle = 'rgba(120,214,250,0.30)'; g.lineWidth = 2.6; g.stroke(edge);
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = 'rgba(228,248,255,0.92)'; g.lineWidth = 1.05; g.stroke(edge);

      // rings on the surface, seen from just above
      for (const r of this.rips) {
        if (r.soft) continue;
        const age = t - r.t0;
        for (let i = 0; i < 3; i++) {
          const a2 = age - i * 0.22; if (a2 <= 0) continue;
          const rx = 6 + a2 * (page ? 120 : 80) * (r.a / 4), ry = rx * 0.16, al = 0.55 * Math.exp(-a2 * 1.25) * (1 - i * 0.25);
          if (al < 0.02) continue;
          g.strokeStyle = `rgba(226,247,255,${al})`; g.lineWidth = 1;
          g.beginPath(); g.ellipse(r.x, b0 + 1.5, rx, ry, 0, 0, 6.2832); g.stroke();
        }
      }
      // splash droplets
      for (const p of this.parts) {
        const al = Math.max(0, 1 - (t - p.t0) / 1.6);
        g.fillStyle = `rgba(214,244,255,${0.85 * al})`;
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.2832); g.fill();
      }
      // drops falling inside a tank
      for (const d of this.drops) this.drawDrop(d.x, d.y, 4.2 + d.s * 2.2);
      if (this.ticks) this.drawGauge(b0);
      this.dirty = false;
    }

    drawDrop(x, y, r) {
      const g = this.g;
      const gl = g.createRadialGradient(x, y, 0, x, y, r * 5);
      gl.addColorStop(0, 'rgba(76,196,242,0.45)'); gl.addColorStop(1, 'rgba(76,196,242,0)');
      g.fillStyle = gl; g.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
      const bg = g.createLinearGradient(0, y - r * 2.9, 0, y + r);
      bg.addColorStop(0, '#1b6fae'); bg.addColorStop(1, '#8fdcff');
      g.fillStyle = bg;
      g.beginPath();
      g.moveTo(x, y - r * 2.9);
      g.bezierCurveTo(x + r * 0.35, y - r * 1.9, x + r, y - r * 0.9, x + r, y);
      g.arc(x, y, r, 0, Math.PI, false);
      g.bezierCurveTo(x - r, y - r * 0.9, x - r * 0.35, y - r * 1.9, x, y - r * 2.9);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.arc(x - r * 0.38, y - r * 0.3, r * 0.22, 0, 6.2832); g.fill();
    }

    // a tide gauge etched on the glass: ticks every 5%, labels every 25%, a marker at the level
    drawGauge(b0) {
      const g = this.g, W = this.W, H = this.H, top = H * this.padTop, bot = 4;
      if (!this.gauge || this.gauge.w !== W || this.gauge.h !== H) {
        const c = document.createElement('canvas'); c.width = Math.round(W * this.dpr); c.height = Math.round(H * this.dpr);
        const q = c.getContext('2d'); q.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        const gx = W - 14;
        q.strokeStyle = 'rgba(220,240,255,0.18)'; q.lineWidth = 1;
        q.beginPath(); q.moveTo(gx + .5, top); q.lineTo(gx + .5, H - bot); q.stroke();
        q.font = '9px JBM, ui-monospace, monospace'; q.textAlign = 'right'; q.textBaseline = 'middle';
        for (let k = 0; k <= 20; k++) {
          const y = Math.round(H - bot - k / 20 * (H - top - bot)) + .5, big = k % 5 === 0;
          q.strokeStyle = big ? 'rgba(220,240,255,0.32)' : 'rgba(220,240,255,0.14)';
          q.beginPath(); q.moveTo(gx - (big ? 10 : 5), y); q.lineTo(gx, y); q.stroke();
          if (big && k > 0) { q.fillStyle = 'rgba(200,225,245,0.42)'; q.fillText(String(k * 5), gx - 14, y); }
        }
        // glass edges
        const e1 = q.createLinearGradient(0, 0, 10, 0); e1.addColorStop(0, 'rgba(143,220,255,0.10)'); e1.addColorStop(1, 'rgba(143,220,255,0)');
        q.fillStyle = e1; q.fillRect(0, 0, 10, H);
        this.gauge = { c, w: W, h: H };
      }
      g.drawImage(this.gauge.c, 0, 0, W, H);
      const gx = W - 14, y = Math.max(top, Math.min(H - bot, b0));
      g.fillStyle = 'rgba(236,248,255,0.92)';
      g.beginPath(); g.moveTo(gx - 22, y); g.lineTo(gx - 30, y - 4.5); g.lineTo(gx - 30, y + 4.5); g.closePath(); g.fill();
    }

    destroy() { loops.delete(this.tick); this.ro && this.ro.disconnect(); this.io && this.io.disconnect(); }
  }

  T.Water = Water;
})();
