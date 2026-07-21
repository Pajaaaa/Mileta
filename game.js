/* MILETA — křižovatková hra (paja.hkfree.org/mileta)
 * Pohled shora à la GTA2 na křižovatku Mileta v Hradci Králové.
 * Hráč přepíná semafory 4 ramen, cíl = propustit co nejvíc vozidel bez bouračky.
 * Rameno 0=S (Hradecká), 1=V (Sokolská), 2=J (Zborovská), 3=Z (Sokolská→FN).
 */
'use strict';

// ==================== konstanty ====================
const STREETS = ['Hradecká', 'Sokolská', 'Zborovská', 'Sokolská'];
const LANE = 28;          // šířka pruhu
const MED = 8;            // půlka středového pásu
const BOXR = 150;         // hranice křižovatky
const STOPY = -160;       // stopčára (lokálně, nájezd od severu)
const SPAWN = 1180;       // vzdálenost spawnu od středu
const DRAWR = 1560;       // dokud kreslíme silnice
const VIEW = 1400;        // kolik světa se vejde do menšího rozměru okna
const ROT = 38 * Math.PI / 180;  // natočení scény jako na fotce

// pruhy nájezdu (lokální x): 0=levé odbočení, 1+2=rovně, 3=bypass vpravo
const LX = [-24, -52, -80, -124];
// pruhy výjezdu: [z levých odbočení, rovně, rovně, bypass]
const EX = [24, 52, 80, 124];

const TYPES = {
  car:   { len: 42, wid: 19, vmax: 150, acc: 75,  brk: 170, p: 0.345 },
  carTrailer: { len: 78, wid: 19, vmax: 125, acc: 52, brk: 145, p: 0.06, trailer: true },
  tractorTrailer: { len: 100, wid: 23, vmax: 55, acc: 22, brk: 90, p: 0.02, tractorTrailer: true },
  van:   { len: 48, wid: 21, vmax: 140, acc: 65,  brk: 160, p: 0.15 },
  truck: { len: 74, wid: 24, vmax: 110, acc: 40,  brk: 120, p: 0.08 },
  tanker:  { len: 78, wid: 24, vmax: 105, acc: 38, brk: 118, p: 0.015 },
  garbage: { len: 70, wid: 24, vmax: 95,  acc: 36, brk: 115, p: 0.015 },
  tow:     { len: 64, wid: 23, vmax: 115, acc: 45, brk: 130, p: 0.015 },
  semi:  { len: 110, wid: 24, vmax: 105, acc: 34, brk: 115, p: 0.06, semi: true },
  bus:   { len: 86, wid: 24, vmax: 112, acc: 42,  brk: 125, p: 0.08 },
  moto:  { len: 26, wid: 11, vmax: 175, acc: 95,  brk: 190, p: 0.16 },
};
const FORCE_VEHICLE = new URLSearchParams(location.search).get('veh');
const CAR_COLORS = ['#c93a2e','#2e66c9','#39a04a','#d4a017','#7a4fb0','#c96b2e',
  '#3aa8a0','#b03a6e','#5b6770','#e0e0e0','#20242a','#8f2020','#1f4d8f','#d0c8b0'];

// ==================== pomůcky ====================
const TAU = Math.PI * 2;
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
let seed = 12345;
function srand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function rnd(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

// rotace bodu podle ramene: 0=identita(S), 1=V, 2=J, 3=Z
function armXform(k, x, y) {
  switch (k & 3) {
    case 0: return { x, y };
    case 1: return { x: -y, y: x };
    case 2: return { x: -x, y: -y };
    default: return { x: y, y: -x };
  }
}

// ==================== audio ====================
const AudioFX = {
  ctx: null,
  _master: null,
  init() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
      if (this.ctx) this.loadSamples();
    }
  },
  out() {
    if (!this._master) {
      this._master = this.ctx.createGain();
      this._master.gain.value = 1.15;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 6;
      this._master.connect(comp);
      comp.connect(this.ctx.destination);
    }
    return this._master;
  },
  beep(freq, dur, type, gain, when) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + (when || 0);
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type || 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(gain || 0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.out());
    o.start(t); o.stop(t + dur);
  },
  // --- reálné samply (mixkit, CC0): klaksony, start motoru, brzdy ---
  samples: {},
  _sampleDefs: {
    horn:      ['snd/horn1.mp3', 'snd/horn2.mp3', 'snd/horn3.mp3'],
    horntruck: ['snd/horn_truck.mp3'],
  },
  loadSamples() {
    if (!this.ctx || this._loading) return;
    this._loading = true;
    for (const [key, urls] of Object.entries(this._sampleDefs)) {
      this.samples[key] = [];
      urls.forEach(url => {
        fetch(url).then(r => r.arrayBuffer())
          .then(ab => this.ctx.decodeAudioData(ab))
          .then(buf => this.samples[key].push(buf))
          .catch(() => {});
      });
    }
  },
  // přehraj náhodný sampl z dané skupiny; offset/dur ořízne, rate mění výšku
  playSample(key, opts) {
    const arr = this.samples[key];
    if (!this.ctx || !arr || !arr.length) return false;
    opts = opts || {};
    const buf = arr[(Math.random() * arr.length) | 0];
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(); s.buffer = buf;
    s.playbackRate.value = opts.rate || 1;
    const g = this.ctx.createGain();
    const vol = opts.gain == null ? 0.6 : opts.gain;
    const dur = opts.dur || buf.duration;
    // krátký fade-in/out proti lupancům při ořezu
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.setValueAtTime(vol, t + Math.max(0.03, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(g); g.connect(this.out());
    s.start(t, opts.offset || 0, dur);
    return true;
  },
  click() { this.beep(880, 0.06, 'square', 0.04); },
  honk(heavy) {
    if (heavy && this.playSample('horntruck', { gain: 0.34, rate: rnd(0.95, 1.05) })) return;
    if (this.playSample('horn', { gain: 0.3, rate: rnd(0.92, 1.12) })) return;
    // fallback: syntéza
    const f = pick([340, 400, 440, 300]);
    this.beep(f, 0.18, 'sawtooth', 0.06);
    if (Math.random() < 0.5) this.beep(f, 0.22, 'sawtooth', 0.06, 0.26);
  },
  crash() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const len = 1.2, buf = this.ctx.createBuffer(1, this.ctx.sampleRate * len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
    const s = this.ctx.createBufferSource(); s.buffer = buf;
    const g = this.ctx.createGain(); g.gain.value = 0.5;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    s.connect(f); f.connect(g); g.connect(this.out()); s.start(t);
    this.beep(60, 0.9, 'sine', 0.25);
  },
  // ambientní hudba: music.mp3 (Kevin MacLeod – Floating Cities, CC BY),
  // při chybě načtení fallback na procedurální Am–F–G–Em smyčku
  musicOn: true,
  music: null,
  audioEl: null,
  musicStart() {
    if (!this.musicOn) return;
    if (!this.audioEl) {
      this.audioEl = document.getElementById('bgMusic');
      if (this.audioEl) {
        this.audioEl.volume = 0.28;
        this.audioEl.addEventListener('error', () => { this.audioEl = 'failed'; this.musicStart(); });
      }
    }
    if (this.audioEl && this.audioEl !== 'failed' && typeof this.audioEl.play === 'function') {
      const pr = this.audioEl.play();
      if (pr && pr.catch) pr.catch(() => {});
      return;
    }
    if (this.audioEl && this.audioEl !== 'failed' && typeof this.audioEl.play !== 'function') return;
    // fallback: procedurální smyčka
    if (!this.ctx || this.music) return;
    const g = this.ctx.createGain();
    g.gain.value = 1;
    g.connect(this.out());
    this.music = { gain: g, step: 0, iv: setInterval(() => this._musicBar(), 3600) };
    this._musicBar();
  },
  musicStop() {
    if (this.audioEl && this.audioEl !== 'failed' && typeof this.audioEl.pause === 'function') this.audioEl.pause();
    if (!this.music) return;
    clearInterval(this.music.iv);
    try { this.music.gain.disconnect(); } catch (e) {}
    this.music = null;
  },
  _musicBar() {
    if (!this.ctx || !this.music || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const CHORDS = [
      [220.00, 261.63, 329.63],   // Am
      [174.61, 261.63, 349.23],   // F
      [196.00, 246.94, 392.00],   // G
      [164.81, 246.94, 329.63],   // Em
    ];
    const ch = CHORDS[this.music.step % CHORDS.length];
    this.music.step++;
    ch.forEach(fq => {
      const o = this.ctx.createOscillator(), og = this.ctx.createGain();
      o.type = 'triangle'; o.frequency.value = fq;
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.022, t + 1.2);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 3.9);
      o.connect(og); og.connect(this.music.gain);
      o.start(t); o.stop(t + 4);
    });
    const b = this.ctx.createOscillator(), bg = this.ctx.createGain();
    b.type = 'sine'; b.frequency.value = ch[0] / 2;
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.035, t + 0.4);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 3.4);
    b.connect(bg); bg.connect(this.music.gain);
    b.start(t); b.stop(t + 3.6);
  },
  siren: null,
  sirenStart() {
    this.init();
    if (!this.ctx || this.siren) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    o.type = 'square'; o.frequency.value = 660;
    f.type = 'lowpass'; f.frequency.value = 1500;
    g.gain.value = 0.035;
    o.connect(f); f.connect(g); g.connect(this.out()); o.start();
    let hi = false;
    const iv = setInterval(() => {
      if (!this.ctx) return;
      hi = !hi;
      o.frequency.setTargetAtTime(hi ? 880 : 660, this.ctx.currentTime, 0.04);
    }, 700);
    this.siren = { o, iv };
  },
  sirenStop() {
    if (!this.siren) return;
    clearInterval(this.siren.iv);
    try { this.siren.o.stop(); } catch (e) {}
    this.siren = null;
  },
};

// ==================== stavba drah ====================
// Dráha = hustě navzorkovaná lomená čára s kumulativní délkou s.
function samplePts(raw) {
  const pts = [];
  for (let i = 0; i < raw.length - 1; i++) {
    const a = raw[i], b = raw[i + 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / 7));
    for (let j = 0; j < n; j++) pts.push({ x: lerp(a.x, b.x, j / n), y: lerp(a.y, b.y, j / n) });
  }
  pts.push(raw[raw.length - 1]);
  return pts;
}
function bezier(p0, p1, p2, p3, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({
      x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
      y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
    });
  }
  return out;
}
function arcPts(cx, cy, r, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = lerp(a0, a1, i / n);
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

function buildPath(arm, localPts, opts) {
  const pts = [];
  let s = 0;
  for (let i = 0; i < localPts.length; i++) {
    const w = armXform(arm, localPts[i].x, localPts[i].y);
    if (i > 0) s += Math.hypot(w.x - pts[i - 1].x, w.y - pts[i - 1].y);
    pts.push({ x: w.x, y: w.y, s });
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    pts[i].ang = Math.atan2(b.y - a.y, b.x - a.x);
  }
  const total = pts[pts.length - 1].s;
  // nejbližší bod ke středu + kde dráha opouští okolí křižovatky
  let sMin = 0, dMin = 1e9;
  for (const p of pts) { const d = Math.hypot(p.x, p.y); if (d < dMin) { dMin = d; sMin = p.s; } }
  let sClear = total;
  for (const p of pts) { if (p.s > sMin && Math.hypot(p.x, p.y) > 195) { sClear = p.s; break; } }
  return Object.assign({ arm, pts, total, sMin, sClear }, opts);
}
function pathPose(path, s) {
  const pts = path.pts;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (pts[m].s < s) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  const t = (s - a.s) / Math.max(0.001, b.s - a.s);
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), ang: a.ang + angDiff(a.ang, b.ang) * t };
}
function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }

// PATHS[arm][laneIdx]; standardně 0=levé, 1/2=rovně, 3=bypass.
// Výjimky podle reality: arm 2 (Zborovská) má 0+1=DVĚ levé a 2=jediný přímý
// (ústí do jednopruhové Hradecké); arm 3 levé ústí rovnou do téhož pruhu.
const PATHS = [];
(function buildAllPaths() {
  const sStopStraight = SPAWN + STOPY;   // 1020

  // levé odbočení z pruhu x0, končí v protilehlém pruhu endY
  function makeLeftPath(k, x0, endY) {
    const raw = samplePts([{ x: x0, y: -SPAWN }, { x: x0, y: STOPY }])
      .concat(bezier({ x: x0, y: STOPY }, { x: x0, y: endY + 5 }, { x: 35, y: endY }, { x: BOXR, y: endY }, 40))
      .concat(samplePts([{ x: BOXR, y: endY }, { x: 1300, y: endY }]));
    const p = buildPath(k, raw, { move: 'L', signal: true, sigKey: 'L', sStop: sStopStraight });
    // bod, kde vjíždí do protisměrných pruhů (pro rychlostní limit oblouku)
    let sy = p.sStop + 60;
    for (const q of p.pts) {
      const l = armXform((4 - k) & 3, q.x, q.y);
      if (q.s > p.sStop && l.x > 14) { sy = q.s; break; }
    }
    p.sYield = sy;
    p.curveCap = { from: p.sStop - 30, to: p.sYield + 170, v: 85 };
    return p;
  }

  for (let k = 0; k < 4; k++) {
    const lanes = [];
    // pruh 0: levé odbočení ústí do průběžného pruhu 52. U dvoupruhových cílů
    // (arm 0 → V, arm 1 → J) existuje i varianta do vnějšího pruhu 80 — vozidlo
    // si při spawnu vybere; obě varianty sdílejí nájezd (laneGroup)
    lanes.push(makeLeftPath(k, LX[0], 52));
    if (k === 0 || k === 1) {
      const alt = makeLeftPath(k, LX[0], 80);
      lanes[0].laneGroup = alt.laneGroup = 'L' + k;
      lanes[0].laneForkS = alt.laneForkS = alt.sStop;   // větví se za stopčárou
      lanes.leftAlt = alt;
    }
    if (k === 2) {
      // Zborovská: pruh 1 = DRUHÉ levé odbočení (do vnějšího pruhu 80 Sokolské)
      lanes.push(makeLeftPath(k, LX[1], 80));
      // pruh 2 = jediný přímý; v křižovatce se esíčkem srovná do pruhu 52 Hradecké
      const raw = samplePts([{ x: LX[2], y: -SPAWN }, { x: LX[2], y: STOPY }])
        .concat(bezier({ x: LX[2], y: STOPY }, { x: LX[2], y: -20 }, { x: -52, y: -10 }, { x: -52, y: 150 }, 30))
        .concat(samplePts([{ x: -52, y: 150 }, { x: -52, y: 1300 }]));
      lanes.push(buildPath(k, raw, { move: 'T', signal: true, sigKey: 'T', sStop: sStopStraight }));
    } else {
      // rovné pruhy
      for (const xi of [1, 2]) {
        const raw = samplePts([{ x: LX[xi], y: -SPAWN }, { x: LX[xi], y: 1300 }]);
        lanes.push(buildPath(k, raw, { move: 'T', signal: true, sigKey: 'T', sStop: sStopStraight }));
      }
    }
    // bypass vpravo: mimo řízenou křižovatku; do hlavního pruhu ústí ROVNOU
    // ze zatáčky, bez připojovacího pruhu — rizikové místo
    {
      // arm 1 bypass se vlévá přímo do jediného průběžného pruhu Hradecké (y=-52),
      // ostatní bypassy zůstávají ve vlastním výjezdovém pruhu (y=-80)
      const outY = (k === 1) ? -52 : -80;
      const raw = samplePts([{ x: LX[3], y: -SPAWN }, { x: LX[3], y: -190 }])
        .concat(arcPts(-190, -190, 66, 0, Math.PI / 2, 24))
        .concat(bezier({ x: -190, y: LX[3] }, { x: -228, y: LX[3] }, { x: -228, y: outY }, { x: -265, y: outY }, 20))
        .concat(samplePts([{ x: -265, y: outY }, { x: -1300, y: outY }]));
      const p = buildPath(k, raw, { move: 'R', signal: true, sigKey: 'R', outY });
      // stopčára bypassu je AŽ ZA zatáčkou, kousek před napojením
      p.sStop = nearestS(p, armXform(k, -218, LX[3]));
      p.curveCap = { from: SPAWN - 260, to: SPAWN - 40, v: 72 };
      lanes.push(p);
    }
    PATHS.push(lanes);
  }
  // reference bodů zaústění: každý vlévající se proud (bypass, u Hradecké i levé
  // odbočení) sdílí cílový pruh s hlavním proudem za svým bodem M. Přednost se
  // NEDÁVÁ — jen normální jízda za sebou ve sdíleném pruhu.
  // s dráhy v příčném řezu bodem M podél osy sdíleného pruhu u: najde první bod
  // dráhy ležící na ose pruhu a jeho s promítne k M. Vstupuje-li dráha do pruhu
  // až za M, extrapoluje se zpět — VŠECHNY dráhy téhož pruhu tak dostanou
  // vzájemně konzistentní souřadnice (nepřesné „nejbližší body" tvořily cykly
  // vzájemného čekání = zaseknutá levá odbočení)
  function laneS(path, M, u) {
    for (const p of path.pts) {
      const dx = p.x - M.x, dy = p.y - M.y;
      if (Math.abs(-u.y * dx + u.x * dy) < 4) return p.s - (dx * u.x + dy * u.y);
    }
    return nearestS(path, M);
  }
  function linkMerge(joiner, M, mains, followFrom) {
    const end = joiner.pts[joiner.pts.length - 1];
    const ul = Math.hypot(end.x - M.x, end.y - M.y);
    const u = { x: (end.x - M.x) / ul, y: (end.y - M.y) / ul };   // osa pruhu
    joiner.merge = {
      sSelf: laneS(joiner, M, u),
      // followFrom: partnery následuj až od této relativní vzdálenosti k bodu M
      // (u levých odbočení jinak „fantomově" brzdí o auta stojící na červené)
      followFrom: followFrom == null ? -1e9 : followFrom,
      partners: mains.map(m => ({ path: m, sPartner: laneS(m, M, u) })),
    };
    for (const m of mains) {
      (m.mergeFroms = m.mergeFroms || []).push({
        partner: joiner, sSelf: laneS(m, M, u), sPartner: laneS(joiner, M, u),
      });
    }
  }
  for (let k = 0; k < 4; k++) {
    const b = PATHS[k][3];
    const exitArm = (k + 1) % 4;
    const mains = [PATHS[exitArm][2]];
    if (k === 0) mains.push(PATHS[2][1]);   // západní vnější pruh sdílí i 2. levé ze Zborovské
    if (k === 1) mains.push(PATHS[3][0]);   // jednopruhovou Hradeckou sdílí i levé ze Sokolské
    if (k === 2) mains.push(PATHS[0].leftAlt);   // východní vnější sdílí levá varianta z Hradecké
    if (k === 3) mains.push(PATHS[1].leftAlt);   // jižní vnější sdílí levá varianta ze Sokolské V
    linkMerge(b, armXform(k, -265, b.outY), mains);
  }
  // levá odbočení ústí do sdílených průběžných pruhů (výjezdy bez vlastních pruhů)
  linkMerge(PATHS[3][0], armXform(3, 160, 52), [PATHS[2][2], PATHS[1][3]], -20);   // → Hradecká (1 pruh)
  linkMerge(PATHS[2][0], armXform(2, 160, 52), [PATHS[1][1]], -20);                // → Sokolská Z, vnitřní
  linkMerge(PATHS[2][1], armXform(2, 160, 80), [PATHS[1][2], PATHS[0][3]], -20);   // → Sokolská Z, vnější
  linkMerge(PATHS[0][0], armXform(0, 160, 52), [PATHS[3][1]], -20);                // → Sokolská V, vnitřní
  linkMerge(PATHS[1][0], armXform(1, 160, 52), [PATHS[0][1]], -20);                // → Zborovská, vnitřní
  linkMerge(PATHS[0].leftAlt, armXform(0, 160, 80), [PATHS[3][2], PATHS[2][3]], -20); // → Sokolská V, vnější
  linkMerge(PATHS[1].leftAlt, armXform(1, 160, 80), [PATHS[0][2], PATHS[3][3]], -20); // → Zborovská, vnější
})();
function nearestS(path, pt) {
  let best = 0, bd = 1e18;
  for (const p of path.pts) {
    const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
    if (d < bd) { bd = d; best = p.s; }
  }
  return best;
}
// body zaústění bypassů (pro detekci kolizí v jejich okolí); zaústění levých
// jsou u kraje křižovatky a pokrývá je základní filtr okolo středu
const MERGE_PTS = [0, 1, 2, 3].map(k => armXform(k, -265, PATHS[k][3].outY));

// ==================== semafory ====================
// stavy: 'red' | 'redamber' | 'green' | 'amber'
// skupiny na každém rameni: T = rovně, L = vlevo, R = bypass vpravo
const AMBER_T = 2.2, REDAMBER_T = 0.9;
const SIG_KEYS = ['T', 'L', 'R'];
function makeSignals() {
  return [0, 1, 2, 3].map(() => ({
    T: { state: 'red', t: 0 },
    L: { state: 'red', t: 0 },
    R: { state: 'green', t: 0 },   // bypassy na startu volné
  }));
}
function signalToggle(sig) {
  if (sig.state === 'red') { sig.state = 'redamber'; sig.t = 0; AudioFX.click(); }
  else if (sig.state === 'green') { sig.state = 'amber'; sig.t = 0; AudioFX.click(); }
}
function signalUpdate(sig, dt) {
  sig.t += dt;
  if (sig.state === 'redamber' && sig.t >= REDAMBER_T) { sig.state = 'green'; sig.t = 0; }
  if (sig.state === 'amber' && sig.t >= AMBER_T) { sig.state = 'red'; sig.t = 0; }
}
// pozice návěstidel (lokálně): T na ostrůvku, L na středovém pásu, R u bypassu
const SIG_POS = {
  T: { x: -104, y: -184 },
  L: { x: -1,   y: -206 },
  R: { x: -218, y: -158 },
};
// klávesy a popisky
// sloupec klávesnice = rameno, řádek = pohyb (Q řada rovně, A řada vlevo,
// Z řada bypass; 'y' je alias 'z' pro české QWERTZ, čísla 1–4 alias pro rovně)
const KEYMAP = {
  'q': [0, 'T'], 'w': [1, 'T'], 'e': [2, 'T'], 'r': [3, 'T'],
  '1': [0, 'T'], '2': [1, 'T'], '3': [2, 'T'], '4': [3, 'T'],
  'a': [0, 'L'], 's': [1, 'L'], 'd': [2, 'L'], 'f': [3, 'L'],
  'z': [0, 'R'], 'x': [1, 'R'], 'c': [2, 'R'], 'v': [3, 'R'],
  'y': [0, 'R'],
};
const SIG_LABEL = { T: ['Q', 'W', 'E', 'R'], L: ['A', 'S', 'D', 'F'], R: ['Z', 'X', 'C', 'V'] };

// ==================== zásahová vozidla (IZS) ====================
const EMG_TYPES = {
  ambulance: { name: 'Sanitka', icon: '🚑', fail: 'SANITKA NEPROJELA!',
               len: 50, wid: 21, vmax: 170, acc: 85, brk: 190, body: '#f2f2f2' },
  police:    { name: 'Policie', icon: '🚓', fail: 'POLICIE NEPROJELA!',
               len: 44, wid: 19, vmax: 180, acc: 95, brk: 200, body: '#e9e9e9' },
  fire:      { name: 'Hasiči', icon: '🚒', fail: 'HASIČI NEPROJELI!',
               len: 72, wid: 24, vmax: 140, acc: 60, brk: 150, body: '#c8102e' },
};
const EMG_TIMEOUT = 25;    // sekund na propuštění IZS
const EMG_PENALTY = 60;    // pokuta za nepropuštěnou IZS
const EMGM_TIMEOUT = 60;   // hromadný výjezd: čas na propuštění všech tří vozidel
const EMGM_BONUS = 20;     // bonus za kompletní hromadný výjezd včas (nad rámec 3×10)
const EMG_DISABLED = /[?&]noemg/.test(location.search);   // vypne IZS i MHD mise (testy)

// ==================== MHD Hradec Králové ====================
const MHD_TYPES = {
  bus:     { name: 'Autobus MHD', icon: '🚌', len: 86, wid: 24, vmax: 115, acc: 44, brk: 130 },
  trolley: { name: 'Trolejbus MHD', icon: '🚎', len: 90, wid: 24, vmax: 110, acc: 46, brk: 130 },
  artic:   { name: 'Kloubový bus MHD', icon: '🚌', len: 118, wid: 24, vmax: 105, acc: 38, brk: 120, artic: true },
};
const MHD_LINES = [1, 2, 3, 5, 6, 7, 9, 24, 27, 28];
const MHD_TIMEOUT = 45;    // jízdní řád: do kdy má projet
const MHD_BONUS = 5;
const MHD_PENALTY = 30;

const START_SCORE = 30;    // startovní body; na 0 je konec
const WIN_SCORE = 1000;    // bodový strop — dosažením je hra dohrána (dál se hraje bez bodů)

// pravidla v2 (18. 7. 2026): dřív šlo obětovat vedlejší směry — ucpané rameno
// přestalo spawnovat (poptávka se vypařila) a mise si přelosovaly volný směr.
const STARVE_WARN = 60;    // s nepřetržitého stání kolony → varování
const STARVE_T = 80;       // s → začnou pokuty za neobsluhovaný směr
const STARVE_TICK = 5;     // pokuta à 5 s
const STARVE_PTS = 3;
const MISSION_JAM_T = 25;  // s: mise se kvůli plnému nájezdu nedostala na mapu → selhala
const BACKLOG_CAP = 25;    // aut čekajících „za mapou" na jedno rameno
const ARM_NAMES = ['Hradecká', 'Sokolská', 'Zborovská', 'Sokolská'];

// ==================== stav hry ====================
const G = {
  running: false, over: false, paused: false,
  won: false, winTime: 0,
  curQueue: 0, flowState: null, starveActive: false,
  time: 0, score: 0, signals: makeSignals(),
  vehicles: [], popups: [], explosions: [], smoke: [],
  shake: 0, slowmo: 1, crashAt: 0,
  spawnTimers: [1.5, 2.5, 2.0, 3.0],
  emg: null, nextEmgAt: 40,
  emgM: null, nextEmgMAt: 200,
  mhd: null, nextMhdAt: 25,
  backlog: [0, 0, 0, 0], pendCar: [null, null, null, null],
  pendEmg: null, pendEmgM: null, pendMhd: null,
  starveWarned: [false, false, false, false], starveNext: [0, 0, 0, 0],
  passed: 0,
  sndEngT: 0, sndBrkT: 0,
  stats: null, hist: [], replay: null, crashPos: null,
  wave: null, nextWaveAt: 90,
  weather: 'den', nextWeatherAt: 110, grip: 1,
  toastMsg: '', toastUntil: 0,
  // od v58 nový klíč: staré rekordy z éry bez stropu 1000 bodů už neplatí
  best: Math.min(WIN_SCORE, +(localStorage.getItem('mileta-best2') || 0)),
};
function freshStats() {
  return { maxQueue: 0, waitSum: 0, waitCnt: 0, emgOk: 0, emgFail: 0, mhdOk: 0, mhdFail: 0 };
}
G.stats = freshStats();
// nenápadné oznámení nahoře (špička, počasí) — bez setTimeout (testy)
function toast(msg) { G.toastMsg = msg; G.toastUntil = G.time + 4.5; }

// změna počasí a nástup špičky počkají, až neběží (ani nečeká) žádná mise —
// jinak by si hlášky přepisovaly jediný toast a události se vršily na hráče
function missionBusy() {
  return !!(G.emg || G.emgM || G.mhd || G.pendEmg || G.pendEmgM || G.pendMhd);
}

function resetGame() {
  G.running = true; G.over = false; G.paused = false;
  G.won = false; G.winTime = 0; G.winStats = null; lbSaved = false;
  G.curQueue = 0; G.flowState = null; G.starveActive = false;
  G.time = 0; G.score = START_SCORE; G.passed = 0;
  G.signals = makeSignals();
  G.vehicles = []; G.popups = []; G.explosions = []; G.smoke = [];
  G.shake = 0; G.slowmo = 1;
  G.spawnTimers = [rnd(0.5, 2), rnd(0.5, 2), rnd(0.5, 2), rnd(0.5, 2)];
  G.emg = null; G.nextEmgAt = rnd(35, 60);
  G.emgM = null; G.nextEmgMAt = rnd(100, 160);
  G.mhd = null; G.nextMhdAt = rnd(6, 14);
  G.backlog = [0, 0, 0, 0]; G.pendCar = [null, null, null, null];
  G.pendEmg = null; G.pendEmgM = null; G.pendMhd = null;
  G.starveWarned = [false, false, false, false]; G.starveNext = [0, 0, 0, 0];
  G.sndEngT = 0; G.sndBrkT = 0;
  G.stats = freshStats(); G.hist = []; G.replay = null; G.crashPos = null;
  G.wave = null; G.nextWaveAt = rnd(80, 120);
  G.weather = 'den'; G.nextWeatherAt = rnd(100, 150); G.grip = 1;
  G.toastMsg = ''; G.toastUntil = 0;
  document.getElementById('replayLbl').style.display = 'none';
  AudioFX.sirenStop();
  updateHud();
  document.getElementById('gameover').style.display = 'none';
  document.getElementById('emgBanner').style.display = 'none';
  document.getElementById('pauseOv').style.display = 'none';
  document.getElementById('btnPause').textContent = '⏸';
  if (typeof pingOnline === 'function') pingOnline();   // hráč se hned započítá
}

// ==================== vozidla ====================
let vehId = 0;
function buildVehicleSpec(arm) {
  // výběr manévru: rovně 55 %, vlevo 22 %, bypass 23 %
  // (Zborovská/arm 2: dva levé pruhy 0+1, jediný přímý 2)
  const r = Math.random();
  let laneIdx;
  if (arm === 2) {
    // Zborovská: dva levé pruhy (na hlavní tah po Sokolské), jeden přímý, bypass
    if (r < 0.34) laneIdx = Math.random() < 0.5 ? 0 : 1;
    else if (r < 0.77) laneIdx = 2;
    else laneIdx = 3;
  } else {
    if (r < 0.22) laneIdx = 0;
    else if (r < 0.77) laneIdx = Math.random() < 0.5 ? 1 : 2;
    else laneIdx = 3;
  }
  let path = PATHS[arm][laneIdx];
  // levé do dvoupruhového cíle: náhodně vnitřní/vnější pruh
  if (laneIdx === 0 && PATHS[arm].leftAlt && Math.random() < 0.5) path = PATHS[arm].leftAlt;
  // typ
  let tr = Math.random(), type = 'car';
  if (FORCE_VEHICLE && TYPES[FORCE_VEHICLE]) type = FORCE_VEHICLE;
  else for (const [name, def] of Object.entries(TYPES)) { tr -= def.p; if (tr <= 0) { type = name; break; } }
  const def = TYPES[type];
  return {
    id: vehId++, arm, laneIdx, path, type, def,
    s: 10, v: def.vmax * rnd(0.75, 0.95),
    color: type === 'tractorTrailer' ? pick(['#36783f','#b13b2f','#356b9c','#6b7834'])
         : type === 'bus' ? pick(['#3b6ea5', '#6e7784', '#2f7d5d', '#8a6d2f'])   // linkové, ne MHD
         : type === 'garbage' ? pick(['#2f7d4a','#38768a','#68753b'])
         : type === 'tow' ? pick(['#e49a1f','#d65c32','#3776a8'])
         : type === 'truck' || type === 'tanker' || type === 'semi'
           ? pick(['#3b4d63','#7d2f2f','#2f5d3a','#666','#8a6d2f']) : pick(CAR_COLORS),
    cargoColor: type === 'truck' || type === 'tanker' || type === 'semi'
      ? pick(['#e4e1d8','#c7c9c8','#9fa7aa','#d8c39f','#7e8f99','#b6b1a7']) : null,
    trailerLoad: type === 'carTrailer' ? pick(['empty', 'tarp', 'luggage']) : null,
    counted: false, crashed: false, wait: 0, honkT: rnd(8, 20),
    pose: pathPose(path, 10),
  };
}

// zkusí vozidlo umístit na mapu; false = nájezd obsazený (varianty levého
// sdílejí nájezdový pruh)
function placeVehicle(spec) {
  for (const v of G.vehicles) {
    const sameLane = v.path === spec.path ||
      (spec.path.laneGroup && v.path.laneGroup === spec.path.laneGroup);
    if (sameLane && v.s < 150 + spec.def.len) return false;
  }
  G.vehicles.push(spec);
  return true;
}

function updateVehicle(v, dt) {
  if (v.crashed) { v.v = 0; return; }
  const p = v.path, def = v.def;
  let vt = def.vmax;
  v._why = ''; v._whyV = null;      // ladicí: které omezení srazilo rychlost (a kdo)
  const lim = (val, tag, oid) => { if (val < vt) { vt = val; v._why = tag; v._whyV = oid == null ? null : oid; } };

  // rychlost v oblouku
  if (p.curveCap && v.s > p.curveCap.from && v.s < p.curveCap.to) lim(p.curveCap.v, 'curve');

  const brake = def.brk * 0.85 * G.grip;   // za deště delší brzdná dráha
  const nose = v.s + def.len / 2;
  if (v.commitT == null && p.sStop && nose > p.sStop + 3) v.commitT = G.time;

  // stopčára podle semaforu příslušné skupiny
  if (p.signal && nose < p.sStop + 3) {
    const st = G.signals[v.arm][p.sigKey].state;
    let mustStop = st !== 'green';
    if (st === 'amber') {
      const ds = p.sStop - nose;
      // když už to nejde ubrzdit, jede dál
      if (v.v * v.v / (2 * def.brk * G.grip) > ds - 6) mustStop = false;
    }
    // na zelenou (i žlutou!) nevjíždět, dokud křižovatku dojíždí vůz, který už
    // zelenou nemá (mezičas po přepnutí fáze); bypassů se netýká. Kontrola běží
    // i při žluté a PŘEBIJE amber-commit — jinak rychlé auto vletí do obsazené
    // křižovatky.
    if (!mustStop && (st === 'green' || st === 'amber') && p.move !== 'R' && nose > p.sStop - 220) {
      for (const o of G.vehicles) {
        if (o === v || o.crashed || o.path.move === 'R') continue;
        const perp = ((o.arm - v.arm) & 1) === 1;
        // protilehlé rameno je konflikt, když právě jeden z dvojice odbočuje
        // vlevo (levé kříží protisměr — oběma směry!)
        const opp = o.arm === ((v.arm + 2) & 3) &&
                    (p.move === 'L') !== (o.path.move === 'L');
        if (!perp && !opp) continue;
        if (G.signals[o.arm][o.path.sigKey].state === 'green') continue; // obě zelené = riziko hráče
        // dojíždějící = už přejel svou stopčáru a ještě neopustil křižovatku
        if (o.s + o.def.len / 2 > o.path.sStop + 3 && o.s < o.path.sClear) { mustStop = true; break; }
      }
    }
    if (mustStop) {
      const ds = p.sStop - 4 - nose;
      lim(ds < 2 ? 0 : Math.sqrt(2 * brake * Math.max(0, ds)), 'signal');
    }
  }

  // zaústění do sdíleného pruhu: ŽÁDNÉ dávání přednosti ani řazení — vozidla se
  // do pruhu cpou naslepo a hlavní proud pro ně nebrzdí; potkají-li se, je z toho
  // nehoda (jediné omezení je fyzikální rychlost těsného oblouku)
  if (p.merge) {
    const r = v.s - p.merge.sSelf;
    if (r > -140 && r < 10) lim(80, 'mouth');   // těsný oblouk zaústění
  }

  // jízda za vozidlem ve stejném pruhu (varianty levého sdílejí nájezd,
  // rozvětvené kusy za laneForkS už ne)
  let leader = null;
  for (const o of G.vehicles) {
    if (o === v || o.s <= v.s) continue;
    if (o.path !== v.path) {
      if (!(v.path.laneGroup && o.path.laneGroup === v.path.laneGroup &&
            o.s < o.path.laneForkS + 60)) continue;
    }
    if (!leader || o.s < leader.s) leader = o;
  }
  if (leader) {
    const gap = (leader.s - leader.def.len / 2) - nose - 10;
    const lv = leader.crashed ? 0 : leader.v;
    const safe = Math.sqrt(Math.max(0, lv * lv + 2 * brake * Math.max(0, gap)));
    lim(gap < 1 ? 0 : safe, 'lead', leader.id);
  }

  // náhodná reakční doba při rozjezdu: stojící auto se po uvolnění cesty
  // rozjede až po vlastní prodlevě — kolona se rozjíždí postupně jako v realitě
  if (!v.emg) {
    if (v.v < 0.5) {
      if (vt > 15) {
        if (v.reactT == null) v.reactT = rnd(0.35, 1.4);
        v.react = (v.react || 0) + dt;
        if (v.react < v.reactT) { vt = 0; v._why = 'react'; }
      } else v.react = 0;                  // stále blokován, reakce až od uvolnění
    } else { v.react = 0; v.reactT = null; }
  }

  // integrace
  const dv = vt - v.v;
  const applied = clamp(dv, -def.brk * G.grip * dt, def.acc * dt);
  v.v += applied;
  if (v.v < 0.3 && vt < 1) v.v = 0;
  v.s += v.v * dt;
  v.pose = pathPose(p, v.s);

  // lehký obláček kouře z výfuku při rozjezdu (trolejbus je elektrický — bez kouře)
  if (v.v < 2) v.puffReady = true;
  else if (v.puffReady && v.v > 6 && applied > 0) {
    v.puffReady = false;
    if (v.mhd !== 'trolley' && G.smoke.length < 300) {
      const c = Math.cos(v.pose.ang), s = Math.sin(v.pose.ang);
      const rx = v.pose.x - c * (v.def.len / 2 + 3);
      const ry = v.pose.y - s * (v.def.len / 2 + 3);
      const n = v.def.len >= 70 ? 5 : 3;    // těžká vozidla kouří o něco víc
      for (let i = 0; i < n; i++) {
        G.smoke.push({
          x: rx + rnd(-3, 3), y: ry + rnd(-3, 3),
          vx: -c * rnd(5, 14) + rnd(-5, 5), vy: -s * rnd(5, 14) + rnd(-5, 5),
          r: rnd(2.5, 4.5), t: 0, life: rnd(0.7, 1.1),
        });
      }
    }
  }

  // čekání + troubení — troubí se, jen když narůstá kolona (4+ stojících v pruhu)
  if (v.v < 2 && G.running && !G.over && !v.emg) {
    v.wait += dt;
    v.waitTotal = (v.waitTotal || 0) + dt;
    if (v.wait > v.honkT) {
      v.honkT += rnd(6, 15);
      const qLen = G.vehicles.filter(o => o.path === v.path && o.v < 2).length;
      if (qLen >= 10 && Math.random() < 0.6)
        AudioFX.honk(v.type === 'truck' || v.type === 'tanker' ||
          v.type === 'garbage' || v.type === 'tow' || v.type === 'semi' ||
          v.type === 'tractorTrailer' || v.type === 'bus');
    }
  } else v.wait = 0;

  // skóre
  if (!v.counted && v.s > p.sClear) {
    v.counted = true;
    G.passed++;
    if (!G.won) {
      G.score++;
      G.popups.push({ x: v.pose.x, y: v.pose.y, t: 0, txt: '+1' });
      updateHud();
      checkWin();
    }
  }
}

// ==================== kolize ====================
function cornersFor(pose, len, wid) {
  const c = Math.cos(pose.ang), s = Math.sin(pose.ang);
  const hl = len / 2 - 1, hw = wid / 2 - 0.5;
  return [
    { x: pose.x + c * hl - s * hw, y: pose.y + s * hl + c * hw },
    { x: pose.x + c * hl + s * hw, y: pose.y + s * hl - c * hw },
    { x: pose.x - c * hl + s * hw, y: pose.y - s * hl - c * hw },
    { x: pose.x - c * hl - s * hw, y: pose.y - s * hl + c * hw },
  ];
}
// kloubový bus = dva články podél dráhy; i ostatní DLOUHÁ vozidla (kamion,
// bus, trolejbus) se kolizně dělí na dva články, aby tuhý obdélník v oblouku
// „nesekal" rohy do vedlejších pruhů (nefér kolize)
const ARTIC_SEGS = [{ off: -31, len: 54 }, { off: 30, len: 58 }];
const CAR_TRAILER_SEGS = [
  { off: -24, len: 30, wid: 18 },
  { off: 18, len: 42, wid: 19 },
];
const SEMI_SEGS = [
  { off: -25, len: 62, wid: 24 },
  { off: 32, len: 44, wid: 23 },
];
const TRACTOR_TRAILER_SEGS = [
  { off: -26, len: 50, wid: 22 },
  { off: 27, len: 44, wid: 22 },
];
function vehicleObbs(v) {
  if (v.def.tractorTrailer) {
    return TRACTOR_TRAILER_SEGS.map(sg =>
      cornersFor(pathPose(v.path, v.s + sg.off), sg.len, sg.wid));
  }
  if (v.def.semi) {
    return SEMI_SEGS.map(sg =>
      cornersFor(pathPose(v.path, v.s + sg.off), sg.len, sg.wid));
  }
  if (v.def.trailer) {
    return CAR_TRAILER_SEGS.map(sg =>
      cornersFor(pathPose(v.path, v.s + sg.off), sg.len, sg.wid));
  }
  if (v.def.artic) {
    return ARTIC_SEGS.map(sg => cornersFor(pathPose(v.path, v.s + sg.off), sg.len, v.def.wid));
  }
  if (v.def.len >= 70) {
    const q = v.def.len / 4, h = v.def.len / 2 + 2;
    return [
      cornersFor(pathPose(v.path, v.s - q), h, v.def.wid),
      cornersFor(pathPose(v.path, v.s + q), h, v.def.wid),
    ];
  }
  return [cornersFor(v.pose, v.def.len, v.def.wid)];
}
function satOverlap(ca, cb) {
  for (const [corners, other] of [[ca, cb], [cb, ca]]) {
    for (let i = 0; i < 2; i++) {
      const e = { x: corners[(i + 1) % 4].x - corners[i].x, y: corners[(i + 1) % 4].y - corners[i].y };
      const ax = -e.y, ay = e.x;
      let amin = 1e9, amax = -1e9, bmin = 1e9, bmax = -1e9;
      for (const p of corners) { const d = p.x * ax + p.y * ay; amin = Math.min(amin, d); amax = Math.max(amax, d); }
      for (const p of other) { const d = p.x * ax + p.y * ay; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
      if (amax < bmin || bmax < amin) return false;
    }
  }
  return true;
}
function obbOverlap(a, b) {
  for (const ca of vehicleObbs(a))
    for (const cb of vehicleObbs(b))
      if (satOverlap(ca, cb)) return true;
  return false;
}

function checkCollisions() {
  const near = G.vehicles.filter(v => !v.crashed &&
    (Math.hypot(v.pose.x, v.pose.y) < 250 ||
     MERGE_PTS.some(m => Math.hypot(v.pose.x - m.x, v.pose.y - m.y) < 230)));
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const a = near[i], b = near[j];
      if (a.arm === b.arm) continue;   // proudy stejného ramene se geometricky nekříží
      // protijedoucí levá odbočení se objíždějí „za sebou" — fyzicky se nepotkají
      if (a.path.move === 'L' && b.path.move === 'L') continue;
      const dx = a.pose.x - b.pose.x, dy = a.pose.y - b.pose.y;
      if (dx * dx + dy * dy > 130 * 130) continue;
      if (obbOverlap(a, b)) {
        // ladicí info o poslední kolizi (viz konzole prohlížeče)
        window.__lastCrash = { t: G.time, sig: signalsSnapshot(), a: crashInfo(a), b: crashInfo(b) };
        a.crashed = b.crashed = true;
        const cx = (a.pose.x + b.pose.x) / 2, cy = (a.pose.y + b.pose.y) / 2;
        startCrash(cx, cy);
        return;
      }
    }
  }
}

function crashInfo(v) {
  return { arm: v.arm, lane: v.laneIdx, move: v.path.move, type: v.type,
           s: Math.round(v.s), v: Math.round(v.v),
           ct: v.commitT == null ? null : Math.round(v.commitT * 10) / 10,
           x: Math.round(v.pose.x), y: Math.round(v.pose.y) };
}
function signalsSnapshot() {
  return G.signals.map(g => SIG_KEYS.map(k => g[k].state[0]).join('')).join(' ');
}

function startCrash(x, y) {
  G.over = true; G.crashAt = G.time; G.slowmo = 0.25; G.shake = 22;
  G.emg = null;
  AudioFX.sirenStop();
  document.getElementById('emgBanner').style.display = 'none';
  AudioFX.crash();
  const ex = { x, y, t: 0, parts: [] };
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * TAU, sp = rnd(30, 260);
    ex.parts.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rnd(0.4, 1.6), t: 0, r: rnd(3, 12),
      kind: i < 26 ? 'fire' : 'smoke',
    });
  }
  G.explosions.push(ex);
  G.crashPos = { x, y };
  G.crashHistIdx = G.hist.length;         // odsud dál je v záznamu i náraz
  setTimeout(startReplay, 1400);
}

// ==================== replay nehody ====================
function startReplay() {
  if (!G.hist.length) { showGameOver(); return; }
  // uložit finální stav (vraky), kamera na místo nehody
  G.replaySave = G.vehicles.map(v => [v, v.s, v.crashed]);
  const from = Math.max(0, (G.crashHistIdx == null ? G.hist.length : G.crashHistIdx) - 180);
  G.replay = { frames: G.hist, idx: from };
  if (G.crashPos) {
    cam.x = G.crashPos.x; cam.y = G.crashPos.y;
    cam.z = Math.max(cam.z, 2.1); clampCam();
  }
  document.getElementById('replayLbl').style.display = 'block';
}
function endReplay() {
  if (!G.replay) return;
  G.replay = null;
  for (const [v, s, crashed] of G.replaySave || []) {
    v.s = s; v.crashed = crashed;
    v.pose = pathPose(v.path, s);
  }
  document.getElementById('replayLbl').style.display = 'none';
  showGameOver();
}

// dosažení bodového stropu = hra dohrána (vítězná obrazovka, dál lze jet bez bodů)
function checkWin() {
  if (G.won || G.over || G.score < WIN_SCORE) return;
  G.won = true; G.winTime = G.time; G.score = WIN_SCORE;
  // snímek statistik v okamžiku dohrání — do žebříčku se neposílá případná další jízda
  G.winStats = lbStatsPayload();
  G.running = false;
  AudioFX.sirenStop();
  document.getElementById('emgBanner').style.display = 'none';
  updateHud();
  showGameOver('win');
}

function showGameOver(reason) {
  const win = reason === 'win';
  const mins = G.time / 60;
  const rate = mins > 0.05 ? (G.passed / mins).toFixed(1) : '0';
  if (G.score > G.best) { G.best = G.score; localStorage.setItem('mileta-best2', G.best); }
  const titleEl = document.getElementById('goTitle');
  titleEl.textContent =
    win ? 'DOHRÁNO! 🏆' : reason === 'points' ? 'BODY VYČERPÁNY!' : 'DOPRAVNÍ NEHODA!';
  titleEl.className = win ? '' : 'crash';
  document.getElementById('goScore').textContent =
    win ? `${G.score} bodů za ${fmtTime(G.winTime)}` : `${G.score} bodů`;
  const st = G.stats;
  const avgW = st.waitCnt ? (st.waitSum / st.waitCnt).toFixed(1) : '0';
  document.getElementById('goStats').innerHTML =
    (win ? 'Blahopřejeme! Prokázali jste, že křižovatku Mileta dokážete řídit lépe než ' +
           'její stávající systém semaforů — a to zcela ručně.<br>' +
           'Služba je úspěšně dokončena, mezi vítězi rozhoduje v žebříčku ' +
           'nejkratší doba řízení.<br>' : '') +
    `Doba řízení: <b>${fmtTime(G.time)}</b> · ${G.passed} vozidel · <b>${rate} voz./min</b><br>` +
    `Nejdelší kolona: <b>${st.maxQueue}</b> vozidel · průměrné zdržení <b>${avgW} s</b><br>` +
    `Záchranné složky včas: <b>${st.emgOk}/${st.emgOk + st.emgFail}</b> · ` +
    `MHD podle jízdního řádu: <b>${st.mhdOk}/${st.mhdOk + st.mhdFail}</b>`;
  document.getElementById('goBest').textContent = `Váš osobní rekord: ${G.best} bodů`;
  document.getElementById('btnCont').style.display = win ? 'inline-block' : 'none';
  document.getElementById('flowSig').style.display = 'none';
  document.getElementById('gameover').style.display = 'flex';
  initLeaderboardUI();
}

// ==================== žebříček ====================
const API_SCORES = 'api/scores';
function lbEsc(el, txt) { el.textContent = txt; return el; }
// statistiky běhu pro žebříček (kompaktní klíče kvůli scores.json)
function lbStatsPayload() {
  if (G.won && G.winStats) return G.winStats;
  const st = G.stats;
  return { p: G.passed, q: st.maxQueue,
           w: +((st.waitCnt ? st.waitSum / st.waitCnt : 0).toFixed(1)),
           eo: st.emgOk, ef: st.emgFail, mo: st.mhdOk, mf: st.mhdFail };
}
// tooltip s plnou statistikou po najetí na řádek žebříčku
function lbTipText(e) {
  const head = `${e.s >= WIN_SCORE ? '⭐ ' : ''}${e.n} — ${e.s} bodů za ${fmtTime(e.t)}` +
               (e.d ? ` (${e.d})` : '');
  const x = e.x;
  if (!x) return head + '\nPodrobné statistiky u tohoto záznamu nejsou k dispozici.';
  const mins = e.t / 60;
  const rate = mins > 0.05 ? (x.p / mins).toFixed(1) : '0';
  return head +
    `\nDoba řízení: ${fmtTime(e.t)} · ${x.p} vozidel · ${rate} voz./min` +
    `\nNejdelší kolona: ${x.q} vozidel · průměrné zdržení ${x.w} s` +
    `\nZáchranné složky včas: ${x.eo}/${x.eo + x.ef}` +
    ` · MHD podle jízdního řádu: ${x.mo}/${x.mo + x.mf}`;
}
function lbTipShow(ev, e) {
  const tip = document.getElementById('lbTip');
  tip.textContent = lbTipText(e);
  tip.style.display = 'block';
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(ev.clientX + 14, innerWidth - w - 8)) + 'px';
  tip.style.top = Math.max(8, Math.min(ev.clientY - h - 14, innerHeight - h - 8)) + 'px';
}
function lbTipHide() { document.getElementById('lbTip').style.display = 'none'; }
function lbTipAttach(el, e) {
  el.addEventListener('mouseenter', ev => lbTipShow(ev, e));
  el.addEventListener('mousemove', ev => lbTipShow(ev, e));
  el.addEventListener('mouseleave', lbTipHide);
}
function renderLbTable(top, myRank) {
  renderLiveLb(top);
  const box = document.getElementById('lbTable');
  box.innerHTML = '';
  if (!top || !top.length) return;
  const tbl = document.createElement('table');
  top.slice(0, 10).forEach((e, i) => {
    const tr = document.createElement('tr');
    if (myRank === i + 1) tr.className = 'me';
    tr.appendChild(lbEsc(document.createElement('td'), `${i + 1}.`));
    // ⭐ = hráč dosáhl bodového stropu (hru dohrál); mezi nimi řadí čas
    tr.appendChild(lbEsc(document.createElement('td'), (e.s >= WIN_SCORE ? '⭐ ' : '') + e.n));
    tr.appendChild(lbEsc(document.createElement('td'), `${e.s} b`));
    tr.appendChild(lbEsc(document.createElement('td'), fmtTime(e.t)));
    lbTipAttach(tr, e);
    tbl.appendChild(tr);
  });
  box.appendChild(tbl);
}
// živý TOP 10 panel vpravo dole — obnova à 60 s + při každém překreslení tabulky
function renderLiveLb(top) {
  const box = document.getElementById('lbLive');
  box.innerHTML = '';
  lbTipHide();   // řádek pod kurzorem mohl zmizet, mouseleave už nepřijde
  if (!top || !top.length) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  const h = document.createElement('div');
  h.className = 'hdr'; h.textContent = '🏆 TOP 10';
  h.title = 'Klepnutím zobrazíte úplný žebříček';
  box.appendChild(h);   // klik řeší delegovaný listener na celém #lbLive
  top.slice(0, 10).forEach((e, i) => {
    const row = document.createElement('div');
    row.textContent = `${i + 1}. ${e.s >= WIN_SCORE ? '⭐ ' : ''}${e.n} · ${e.s} b`;
    lbTipAttach(row, e);
    box.appendChild(row);
  });
}
// úplný žebříček (overlay) — posledních 50 záznamů s detaily, otevírá klik na „TOP 10"
function lbFmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(d || '');
  return m ? `${+m[3]}.${+m[2]}. ${m[4]}` : (d || '—');
}
let lbFullPausedGame = false;   // pauzu vyvolal overlay → po zavření ji zas zruší
function openLbFull() {
  lbFullPausedGame = false;
  if (G.running && !G.over && !G.paused) { togglePause(); lbFullPausedGame = true; }
  document.getElementById('lbFull').style.display = 'flex';
  const msg = document.getElementById('lbFullMsg');
  const tb = document.getElementById('lbFullBody');
  tb.innerHTML = '';
  msg.textContent = 'Načítám…';
  fetch(API_SCORES + '/recent').then(r => r.json()).then(d => {
    msg.textContent = d.recent.length < d.total
      ? `Zobrazeno ${d.recent.length} nejnovějších záznamů z celkem ${d.total}.`
      : `Celkem záznamů: ${d.total}.`;
    d.recent.forEach(e => {
      const tr = document.createElement('tr');
      if (e.s >= WIN_SCORE) tr.className = 'fin';
      const x = e.x;
      [lbFmtDate(e.d), (e.s >= WIN_SCORE ? '⭐ ' : '') + e.n, `${e.s} b`, fmtTime(e.t),
       x ? String(x.p) : '—', x ? String(x.q) : '—', x ? `${x.w} s` : '—',
       x ? `${x.eo}/${x.eo + x.ef}` : '—', x ? `${x.mo}/${x.mo + x.mf}` : '—',
      ].forEach(t => tr.appendChild(lbEsc(document.createElement('td'), t)));
      tb.appendChild(tr);
    });
  }).catch(() => { msg.textContent = 'Žebříček je nedostupný.'; });
}
function closeLbFull() {
  document.getElementById('lbFull').style.display = 'none';
  if (lbFullPausedGame && G.paused) togglePause();
  lbFullPausedGame = false;
}
document.getElementById('btnLbClose').addEventListener('click', closeLbFull);
document.getElementById('lbFull').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeLbFull();   // klik mimo panel zavírá
});

function refreshLiveLb() {
  fetch(API_SCORES).then(r => r.json()).then(d => renderLiveLb(d.top)).catch(() => {});
}
refreshLiveLb();
setInterval(refreshLiveLb, 60000);

// počítadlo hráčů online: heartbeat na API à 30 s, když hra běží; jinak jen dotaz
const ONLINE_ID = Math.random().toString(36).slice(2, 14);
function renderOnline(n) {
  const el = document.getElementById('online');
  if (!Number.isFinite(n) || n < 1) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.textContent = `🎮 Právě hraje: ${n}`;
}
function pingOnline() {
  const playing = G.running && !G.over;
  const req = playing
    ? fetch('api/online', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: ONLINE_ID }) })
    : fetch('api/online');
  req.then(r => r.json()).then(d => renderOnline(d.online)).catch(() => {});
}
pingOnline();
setInterval(pingOnline, 30000);

let lbSaved = false;   // per běh hry (reset v resetGame) — po dohrání a pokračování se neukládá dvakrát
function initLeaderboardUI() {
  document.getElementById('lbSave').style.display = lbSaved ? 'none' : 'flex';
  if (!lbSaved) document.getElementById('lbMsg').textContent = '';
  document.getElementById('playerName').value = localStorage.getItem('mileta-name') || '';
  fetch(API_SCORES).then(r => r.json())
    .then(d => renderLbTable(d.top, 0))
    .catch(() => { document.getElementById('lbMsg').textContent = 'Žebříček je nedostupný.'; });
}
function saveScore() {
  if (lbSaved) return;
  const name = document.getElementById('playerName').value.trim().slice(0, 24);
  if (!name) { document.getElementById('lbMsg').textContent = 'Zadejte prosím jméno.'; return; }
  localStorage.setItem('mileta-name', name);
  lbSaved = true;
  document.getElementById('lbMsg').textContent = 'Ukládám…';
  fetch(API_SCORES, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // po dohrání se ukládá čas DOSAŽENÍ stropu, ne celková doba (fér pro speedrun řazení)
    body: JSON.stringify({ name, score: G.score, time: Math.round(G.won ? G.winTime : G.time),
                           stats: lbStatsPayload() }),
  }).then(r => r.json()).then(d => {
    document.getElementById('lbSave').style.display = 'none';
    document.getElementById('lbMsg').textContent = `Vaše umístění: ${d.rank}. z ${d.total}.`;
    renderLbTable(d.top, d.rank);
  }).catch(() => {
    lbSaved = false;
    document.getElementById('lbMsg').textContent = 'Uložení se nezdařilo, zkuste to prosím znovu.';
  });
}

function fmtTime(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}

// ==================== spawn a obtížnost ====================
function updateSpawning(dt) {
  // interval na rameno klesá s časem (obtížnost roste). Hlavní tah městem jde
  // po SOKOLSKÉ (V↔Z, k=1,3) — ta je nejhustší; Hradecká a Zborovská slabší
  const base = clamp(4.8 - G.time / 90, 1.2, 4.8);
  const ARM_MULT = [1.15, 0.6, 1.15, 0.6];
  // dopravní špičky: nárazová vlna z jednoho konce hlavního tahu
  if (!G.wave && G.time > G.nextWaveAt) {
    if (missionBusy()) G.nextWaveAt = G.time + rnd(4, 8);
    else {
      const type = Math.random() < 0.5 ? 'am' : 'pm';
      G.wave = { type, until: G.time + rnd(50, 75) };
      toast(type === 'am' ? '🌅 Ranní špička — silný proud po Sokolské od východu!'
                          : '🌆 Odpolední špička — silný proud po Sokolské od FN!');
    }
  } else if (G.wave && G.time > G.wave.until) {
    G.wave = null;
    G.nextWaveAt = G.time + rnd(70, 110);
    if (!missionBusy()) toast('Špička opadá.');
  }
  const WAVE_MULT = G.wave
    ? (G.wave.type === 'am' ? [1.15, 0.45, 1.15, 1.15] : [1.15, 1.15, 1.15, 0.45])
    : null;
  for (let k = 0; k < 4; k++) {
    G.spawnTimers[k] -= dt;
    if (G.spawnTimers[k] <= 0) {
      // poptávka nemizí: když je nájezd plný, auto čeká „za mapou" v backlogu
      if (G.backlog[k] < BACKLOG_CAP) G.backlog[k]++;
      let m = ARM_MULT[k];
      if (WAVE_MULT) m *= WAVE_MULT[k];
      G.spawnTimers[k] = base * m * rnd(0.55, 1.45);
    }
    // čelní auto virtuální fronty si drží vylosovaný pruh, dokud se tam
    // nevejde — neucpaná objízdná pravá (bypass) frontu nepředbíhá
    if (!G.pendCar[k] && G.backlog[k] > 0) { G.pendCar[k] = buildVehicleSpec(k); G.backlog[k]--; }
    if (G.pendCar[k] && placeVehicle(G.pendCar[k])) G.pendCar[k] = null;
  }

  // neobsluhovaný směr: vozidlo (mimo volný bypass) stojící bez hnutí přes
  // STARVE_WARN s → varování, přes STARVE_T s → pokuta à STARVE_TICK s
  const mw = [0, 0, 0, 0], mp = [null, null, null, null];
  for (const v of G.vehicles) {
    if (v.laneIdx === 3 || v.crashed || v.emg) continue;
    if (v.wait > mw[v.arm]) { mw[v.arm] = v.wait; mp[v.arm] = v.pose; }
  }
  for (let k = 0; k < 4; k++) {
    if (mw[k] > STARVE_WARN) {
      if (!G.starveWarned[k]) {
        G.starveWarned[k] = true;
        G.starveNext[k] = G.time + (STARVE_T - STARVE_WARN);
        toast(`🚗 ${ARM_NAMES[k]}: kolona stojí přes minutu — pusť i tenhle směr, jinak jdou body dolů!`);
      }
      if (G.time >= G.starveNext[k]) {
        G.starveNext[k] = G.time + STARVE_TICK;
        applyPenalty(STARVE_PTS, mp[k].x, mp[k].y);
      }
    } else if (mw[k] < 10) G.starveWarned[k] = false;
  }
  // některé rameno stojí tak dlouho, že už tikají pokuty → semafor průtoku bliká
  G.starveActive = mw.some(w => w > STARVE_T);
  // mise: zásahové vozidlo + MHD (s rostoucí obtížností jezdí častěji).
  // Mise si při naplánování vylosuje rameno a DRŽÍ ho — dřív si při plném
  // nájezdu přelosovala jiný směr, takže ucpání ramene nic nestálo. Když se
  // mise na mapu nedostane do MISSION_JAM_T s, selže jako zmeškaná.
  if (!EMG_DISABLED && !G.emg && !G.emgM && G.time > G.nextEmgAt) {
    if (!G.pendEmg) G.pendEmg = { arm: (Math.random() * 4) | 0, since: G.time, warned: false };
    const pe = G.pendEmg;
    if (spawnMission('emg', pe.arm)) G.pendEmg = null;
    else if (G.time - pe.since > MISSION_JAM_T) {
      G.pendEmg = null;
      G.stats.emgFail++;
      toast(`🚑 Vozidlo IZS se kvůli koloně (${ARM_NAMES[pe.arm]}) vůbec nedostalo ke křižovatce! −${EMG_PENALTY}`);
      applyPenalty(EMG_PENALTY, 0, 0);
      G.nextEmgAt = G.time + rnd(40, 70) * missionDiff();
    } else {
      if (!pe.warned && G.time - pe.since > 5) {
        pe.warned = true;
        toast(`🚑 Vozidlo IZS přijíždí: ${ARM_NAMES[pe.arm]} — uvolni nájezd!`);
      }
      G.nextEmgAt = G.time + 1.5;
    }
  }
  // hromadný výjezd IZS — vzácná událost, neběží souběžně s běžnou IZS misí
  if (!EMG_DISABLED && !G.emg && !G.emgM && G.time > G.nextEmgMAt) {
    if (spawnMultiEmg()) G.pendEmgM = null;
    else {
      if (!G.pendEmgM) G.pendEmgM = { since: G.time, warned: false };
      else if (G.time - G.pendEmgM.since > MISSION_JAM_T) {
        G.pendEmgM = null;
        G.stats.emgFail++;
        toast(`🚨 Hromadný výjezd IZS se kvůli kolonám vůbec nedostal ke křižovatce! −${EMG_PENALTY}`);
        applyPenalty(EMG_PENALTY, 0, 0);
        G.nextEmgMAt = G.time + rnd(140, 240) * missionDiff();
      } else if (!G.pendEmgM.warned && G.time - G.pendEmgM.since > 6) {
        G.pendEmgM.warned = true;
        toast('🚨 Hromadný výjezd IZS čeká na volné nájezdy!');
      }
      if (G.pendEmgM) G.nextEmgMAt = G.time + 2;
    }
  }
  if (!EMG_DISABLED && !G.mhd && G.time > G.nextMhdAt) {
    if (!G.pendMhd) G.pendMhd = { arm: (Math.random() * 4) | 0, since: G.time, warned: false };
    const pm = G.pendMhd;
    if (spawnMission('mhd', pm.arm)) G.pendMhd = null;
    else if (G.time - pm.since > MISSION_JAM_T) {
      G.pendMhd = null;
      G.stats.mhdFail++;
      toast(`🚌 Spoj MHD kvůli koloně (${ARM_NAMES[pm.arm]}) vůbec nevyjel na křižovatku! −${MHD_PENALTY}`);
      applyPenalty(MHD_PENALTY, 0, 0);
      G.nextMhdAt = G.time + rnd(10, 22) * Math.max(missionDiff(), 0.65);
    } else {
      if (!pm.warned && G.time - pm.since > 5) {
        pm.warned = true;
        toast(`🚌 MHD přijíždí: ${ARM_NAMES[pm.arm]} — uvolni nájezd!`);
      }
      G.nextMhdAt = G.time + 1.5;
    }
  }
}

// s časem se mise objevují častěji
function missionDiff() { return clamp(1 - G.time / 1400, 0.45, 1); }

function spawnMission(which, forcedArm) {
  const arm = forcedArm == null ? (Math.random() * 4) | 0 : forcedArm;
  // mise: 25 % vpravo bypassem, 30 % vlevo, 45 % rovně (přímý pruh s menší frontou;
  // Zborovská má průběžný proud jen v pruhu 1)
  const cnt = i => G.vehicles.filter(o => o.path === PATHS[arm][i]).length;
  let laneIdx;
  const rl = Math.random();
  if (rl < 0.25) laneIdx = 3;        // mise (IZS i MHD) i vpravo bypassem
  else if (rl < 0.55) laneIdx = 0;
  else laneIdx = arm === 2 ? 2 : (cnt(1) <= cnt(2) ? 1 : 2);
  let path = PATHS[arm][laneIdx];
  if (laneIdx === 0 && PATHS[arm].leftAlt && Math.random() < 0.5) path = PATHS[arm].leftAlt;
  let def, veh;
  if (which === 'emg') {
    const kind = pick(['ambulance', 'police', 'fire']);
    def = EMG_TYPES[kind];
    veh = { type: 'emg', emg: kind, color: def.body, counted: true, deadline: G.time + EMG_TIMEOUT };
  } else {
    const kind = pick(['bus', 'bus', 'artic', 'trolley']);
    def = MHD_TYPES[kind];
    veh = { type: 'mhd', mhd: kind, line: pick(MHD_LINES), color: '#d21f26',
            counted: false, deadline: G.time + MHD_TIMEOUT };
  }
  for (const o of G.vehicles) if (o.path === path && o.s < 200 + def.len) return false;
  G.vehicles.push(Object.assign({
    id: vehId++, arm, laneIdx, path, def,
    s: 10, v: def.vmax * 0.9,
    crashed: false, wait: 0, honkT: 1e9, missionDone: false,
    pose: pathPose(path, 10),
  }, veh));
  if (which === 'emg') {
    G.emg = { arm, deadline: G.time + EMG_TIMEOUT, kind: veh.emg, move: path.move };
    AudioFX.sirenStart();
  } else {
    G.mhd = { arm, deadline: G.time + MHD_TIMEOUT, kind: veh.mhd, move: path.move };
  }
  return true;
}

// hromadný výjezd IZS: sanitka + policie + hasiči ze TŘÍ směrů najednou, všichni
// míří na JEDEN výjezd (rovně z protějšího ramene, levým odbočením a bypassem —
// jediné tři cesty, které na daný výjezd vedou; vzájemně se kříží, hráč je musí
// propouštět postupně)
function spawnMultiEmg() {
  const exit = (Math.random() * 4) | 0;
  const srcT = (exit + 2) % 4;   // rovně: T(k) ústí na k+2
  const srcL = (exit + 3) % 4;   // vlevo: L(k) ústí na k+1
  const srcR = (exit + 1) % 4;   // bypass: R(k) ústí na k+3
  const cnt = i => G.vehicles.filter(o => o.path === PATHS[srcT][i]).length;
  const tLane = srcT === 2 ? 2 : (cnt(1) <= cnt(2) ? 1 : 2);
  const arms = [srcT, srcL, srcR], lanes = [tLane, 0, 3];
  const paths = [PATHS[srcT][tLane], PATHS[srcL][0], PATHS[srcR][3]];
  const kinds = ['ambulance', 'police', 'fire'].sort(() => Math.random() - 0.5);
  // místo musí být na VŠECH třech vjezdech naráz, jinak zkusit později
  for (let i = 0; i < 3; i++) {
    const def = EMG_TYPES[kinds[i]];
    for (const o of G.vehicles) if (o.path === paths[i] && o.s < 200 + def.len) return false;
  }
  const deadline = G.time + EMGM_TIMEOUT;
  for (let i = 0; i < 3; i++) {
    const def = EMG_TYPES[kinds[i]];
    G.vehicles.push({
      id: vehId++, arm: arms[i], laneIdx: lanes[i], path: paths[i], def,
      s: 10, v: def.vmax * 0.9,
      crashed: false, wait: 0, honkT: 1e9, missionDone: false,
      pose: pathPose(paths[i], 10),
      type: 'emg', emg: kinds[i], emgM: true, color: def.body, counted: true, deadline,
    });
  }
  G.emgM = { exit, deadline, done: 0 };
  AudioFX.sirenStart();
  toast(`🚨 Hromadný výjezd IZS — všechna vozidla míří na ${STREETS[exit]}!`);
  return true;
}

function endEmgM() {
  G.emgM = null;
  if (!G.emg) AudioFX.sirenStop();
  G.nextEmgMAt = G.time + rnd(140, 240) * missionDiff();
}

// odečtení bodů; na nule je konec hry (po dohrání ani po konci se skóre nemění —
// hromadný výjezd umí dát víc pokut v jednom snímku)
function applyPenalty(pts, x, y) {
  if (G.won || G.over) return;
  G.score -= pts;
  G.popups.push({ x, y, t: 0, txt: `−${pts}`, bad: true });
  if (G.score <= 0 && !G.over) {
    G.score = 0;
    G.over = true;
    AudioFX.sirenStop();
    document.getElementById('emgBanner').style.display = 'none';
    setTimeout(() => showGameOver('points'), 600);
  }
  updateHud();   // až po clampu — jinak v HUD zůstane viset záporné číslo
}

function updateMissions() {
  // hromadný výjezd IZS — každé vozidlo se vyhodnocuje zvlášť, bonus za komplet
  if (G.emgM) {
    for (const v of G.vehicles) {
      if (!v.emgM || v.missionDone || v.crashed) continue;
      if (v.s > v.path.sClear) {
        v.missionDone = true;
        G.stats.emgOk++; G.emgM.done++;
        if (!G.won) {
          G.score += 10;
          G.popups.push({ x: v.pose.x, y: v.pose.y, t: 0, txt: '+10' });
          updateHud(); checkWin();
        }
      }
    }
    if (G.emgM && !G.vehicles.some(o => o.emgM && !o.missionDone && !o.crashed)) {
      if (G.emgM.done === 3 && !G.won) {
        G.score += EMGM_BONUS;
        G.popups.push({ x: 0, y: 0, t: 0, txt: `VÝJEZD KOMPLETNÍ +${EMGM_BONUS}` });
        updateHud(); checkWin();
      }
      endEmgM();
    } else if (G.emgM && G.time > G.emgM.deadline) {
      for (const v of G.vehicles) {
        if (v.emgM && !v.missionDone) {
          v.missionDone = true;
          G.stats.emgFail++;
          applyPenalty(EMG_PENALTY, v.pose.x, v.pose.y);
        }
      }
      endEmgM();
    }
  }
  // IZS
  if (G.emg) {
    const veh = G.vehicles.find(o => o.emg && !o.emgM && !o.missionDone);
    if (!veh) { G.emg = null; AudioFX.sirenStop(); }
    else if (!veh.crashed) {
      if (veh.s > veh.path.sClear) {
        veh.missionDone = true;
        G.stats.emgOk++;
        if (!G.won) {
          G.score += 10;
          G.popups.push({ x: veh.pose.x, y: veh.pose.y, t: 0, txt: '+10' });
          updateHud();
          checkWin();
        }
        AudioFX.sirenStop();
        G.emg = null;
        G.nextEmgAt = G.time + rnd(40, 70) * missionDiff();
        document.getElementById('emgBanner').style.display = 'none';
      } else if (G.time > G.emg.deadline) {
        veh.missionDone = true;
        G.stats.emgFail++;
        AudioFX.sirenStop();
        G.emg = null;
        G.nextEmgAt = G.time + rnd(40, 70) * missionDiff();
        document.getElementById('emgBanner').style.display = 'none';
        applyPenalty(EMG_PENALTY, veh.pose.x, veh.pose.y);
      }
    }
  }
  // MHD — jízdní řád
  if (G.mhd) {
    const veh = G.vehicles.find(o => o.mhd && !o.missionDone);
    if (!veh) { G.mhd = null; }
    else if (!veh.crashed) {
      if (veh.s > veh.path.sClear) {
        veh.missionDone = true;
        G.stats.mhdOk++;
        if (!G.won) {
          G.score += MHD_BONUS;
          G.popups.push({ x: veh.pose.x, y: veh.pose.y, t: 0, txt: `MHD včas +${MHD_BONUS}` });
          updateHud();
          checkWin();
        }
        G.mhd = null;
        G.nextMhdAt = G.time + rnd(10, 22) * Math.max(missionDiff(), 0.65);
      } else if (G.time > G.mhd.deadline) {
        veh.missionDone = true;
        G.stats.mhdFail++;
        G.mhd = null;
        G.nextMhdAt = G.time + rnd(10, 22) * Math.max(missionDiff(), 0.65);
        applyPenalty(MHD_PENALTY, veh.pose.x, veh.pose.y);
      }
    }
  }
}

// ==================== canvas / pohled ====================
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let cw = 0, ch = 0, dpr = 1, scale = 1;

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = window.innerWidth; ch = window.innerHeight;
  canvas.width = cw * dpr; canvas.height = ch * dpr;
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  scale = Math.min(cw, ch) / VIEW;
}
window.addEventListener('resize', resize);
resize();

// kamera: zoom kolečkem, posun pravým tlačítkem; ladicí ?cam=z,x,y
const cam = { x: 0, y: 0, z: 1 };
// na malých displejích začni přiblíženě na střed křižovatky
if (Math.min(cw, ch) < 560) cam.z = 1.4;
{
  const cm = location.search.match(/[?&]cam=([\d.]+),(-?\d+),(-?\d+)/);
  if (cm) { cam.z = +cm[1]; cam.x = +cm[2]; cam.y = +cm[3]; }
}
function camScale() { return scale * cam.z; }
function clampCam() {
  const lim = 60 + 1100 * (1 - 1 / cam.z);
  cam.x = clamp(cam.x, -lim, lim);
  cam.y = clamp(cam.y, -lim, lim);
}
function worldTransform(shakeX, shakeY) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(cw / 2 + shakeX, ch / 2 + shakeY);
  ctx.scale(camScale(), camScale());
  ctx.rotate(ROT);
  ctx.translate(-cam.x, -cam.y);
}
function worldToScreen(x, y) {
  const c = Math.cos(ROT), s = Math.sin(ROT);
  const dx = x - cam.x, dy = y - cam.y;
  return { x: (dx * c - dy * s) * camScale() + cw / 2, y: (dx * s + dy * c) * camScale() + ch / 2 };
}
function screenToWorld(sx, sy) {
  const c = Math.cos(-ROT), s = Math.sin(-ROT);
  const x = (sx - cw / 2) / camScale(), y = (sy - ch / 2) / camScale();
  return { x: x * c - y * s + cam.x, y: x * s + y * c + cam.y };
}

// ==================== statické pozadí ====================
const BG_HALF = 1600;
const bg = document.createElement('canvas');
bg.width = bg.height = BG_HALF * 2;
(function renderBackground() {
  const g = bg.getContext('2d');
  g.translate(BG_HALF, BG_HALF);

  // tráva + šum
  g.fillStyle = '#4a7c43';
  g.fillRect(-BG_HALF, -BG_HALF, BG_HALF * 2, BG_HALF * 2);
  seed = 987;
  for (let i = 0; i < 5200; i++) {
    const x = (srand() * 2 - 1) * BG_HALF, y = (srand() * 2 - 1) * BG_HALF;
    g.fillStyle = srand() < 0.5 ? 'rgba(38,74,34,0.35)' : 'rgba(110,160,90,0.28)';
    g.fillRect(x, y, srand() * 26 + 4, srand() * 26 + 4);
  }

  // ---- chodníky/stezky podél silnic + diagonální (podchodové rampy v rozích)
  g.strokeStyle = '#a8a396'; g.lineCap = 'round';
  g.lineWidth = 14;
  for (let k = 0; k < 4; k++) {
    const p1 = armXform(k, -160, -1600), p2 = armXform(k, -160, -235);
    const p3 = armXform(k, 160, -1600), p4 = armXform(k, 160, -235);
    g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y);
    g.moveTo(p3.x, p3.y); g.lineTo(p4.x, p4.y); g.stroke();
  }
  // rohové propojky (podchody – naznačené rampy)
  for (let k = 0; k < 4; k++) {
    const a = armXform(k, -160, -260), b = armXform(k, -260, -160);
    g.beginPath(); g.moveTo(a.x, a.y);
    const m = armXform(k, -250, -250);
    g.quadraticCurveTo(m.x, m.y, b.x, b.y); g.stroke();
  }

  // ---- asfalt: dva křížové pásy + zaoblené rohy
  g.fillStyle = '#3a3d40';
  const RW = 138;
  g.fillRect(-RW, -BG_HALF, RW * 2, BG_HALF * 2);
  g.fillRect(-BG_HALF, -RW, BG_HALF * 2, RW * 2);
  for (let k = 0; k < 4; k++) {   // výplň rohů mezi pásy (fillet bypassu)
    g.beginPath();
    const c = armXform(k, -190, -190);
    const s0 = armXform(k, -138, -190), s1 = armXform(k, -190, -138);
    g.moveTo(s0.x, s0.y);
    g.arc(c.x, c.y, 44, k * Math.PI / 2, k * Math.PI / 2 + Math.PI / 2);
    const cor = armXform(k, -138, -138);
    g.lineTo(cor.x, cor.y);
    g.closePath(); g.fill();
  }
  // šum asfaltu
  seed = 555;
  for (let i = 0; i < 2600; i++) {
    const x = (srand() * 2 - 1) * BG_HALF, y = (srand() * 2 - 1) * BG_HALF;
    if (Math.abs(x) > RW + 60 && Math.abs(y) > RW + 60) continue;
    g.fillStyle = srand() < 0.5 ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.05)';
    g.fillRect(x, y, srand() * 15 + 3, srand() * 15 + 3);
  }
  // na výjezdech se pruh bypassu napojuje do hlavního — za klínem uždibnout asfalt trávou
  for (let k = 0; k < 4; k++) {
    g.save();
    g.rotate(k * Math.PI / 2);
    g.fillStyle = '#4a7c43';
    g.beginPath();
    g.moveTo(96, -1600);
    g.lineTo(152, -1600);
    g.lineTo(152, -196);
    g.lineTo(146, -196);
    g.quadraticCurveTo(124, -252, 96, -295);   // ctrl shodný s bílou hranou v drawRoad — jinak zelený lem přetéká přes čáru
    g.closePath();
    g.fill();
    g.restore();
  }

  // ---- prstence bypassových zatáček: explicitní asfaltový pás (r44–88),
  // aby do rozšířeného oblouku nezasahovaly travnaté klíny výjezdů
  g.strokeStyle = '#3a3d40';
  g.lineWidth = 44;
  g.lineCap = 'butt';
  for (let k = 0; k < 4; k++) {
    const c = armXform(k, -190, -190);
    g.beginPath();
    g.arc(c.x, c.y, 66, k * Math.PI / 2, k * Math.PI / 2 + Math.PI / 2);
    g.stroke();
  }

  // ---- ostrůvky (kapkovité, mezi rovnými pruhy a bypassem) + rohové trojúhelníky
  for (let k = 0; k < 4; k++) {
    g.save();
    g.setTransform(1, 0, 0, 1, BG_HALF, BG_HALF);
    g.rotate(k * Math.PI / 2);
    g.fillStyle = '#9d998c';
    g.beginPath();
    g.moveTo(-102, -470);
    g.lineTo(-96, -165);
    g.quadraticCurveTo(-96, -96, -165, -96);
    g.lineTo(-190, -102);   // špička končí na hraně oblouku, do bypassu nezasahuje
    g.arc(-190, -190, 88, Math.PI / 2, 0, true);
    g.lineTo(-102, -460);
    g.closePath();
    g.fill();
    // tráva uvnitř velkého rohu ostrůvku (drží se uvnitř, pruh sahá do r88)
    g.fillStyle = '#557f4a';
    g.beginPath();
    g.moveTo(-100, -170);
    g.quadraticCurveTo(-104, -104, -170, -100);
    g.arc(-190, -190, 96, Math.PI / 2 - 0.30, 0.30, true);   // ořez ±0.30: konce oblouku nesmí přečnívat přes dlážděný lem
    g.closePath();
    g.fill();
    // střední dělicí pás
    g.fillStyle = '#9d998c';
    g.beginPath(); g.moveTo(-7, -440); g.lineTo(7, -440); g.lineTo(7, -180);
    g.arc(0, -180, 7, 0, Math.PI); g.closePath(); g.fill();
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(0, -180, 6, 0, TAU); g.fill();
    g.restore();
  }
  g.setTransform(1, 0, 0, 1, BG_HALF, BG_HALF);

  // ---- vodorovné značení
  for (let k = 0; k < 4; k++) {
    g.save();
    g.rotate(k * Math.PI / 2);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineCap = 'butt';
    // čáry mezi pruhy nájezdu (x=-38,-66): přerušovaná po celé délce
    g.lineWidth = 2.5;
    g.setLineDash([14, 14]);
    for (const x of [-38, -66]) {
      g.beginPath(); g.moveTo(x, -1600); g.lineTo(x, -164); g.stroke();
    }
    g.setLineDash([]);
    // čáry výjezdu: jen dělicí čára dvou pruhů (Hradecká k=0 je jednopruhová)
    g.setLineDash([14, 14]);
    for (const x of (k === 0 ? [] : [66])) {
      g.beginPath(); g.moveTo(x, -1600); g.lineTo(x, -170); g.stroke();
    }
    g.setLineDash([]);
    // oddělení pravého odbočovacího (bypassového) pruhu: přerušovaná čára
    g.lineWidth = 2.5;
    g.setLineDash([14, 14]);
    g.beginPath(); g.moveTo(-94, -1600); g.lineTo(-94, -480); g.stroke();
    g.setLineDash([]);
    // okraj vozovky na výjezdové straně
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(94, -1600); g.lineTo(94, -300); g.stroke();
    // hraniční čáry nájezdového třípruhu: plná u středového pásu…
    g.beginPath(); g.moveTo(-10, -1600); g.lineTo(-10, -164); g.stroke();
    // …a vnější okraj podél bypassu, přecházející tečně do křivky po vnější
    // straně bypassové zatáčky (k trávě; roh -190,-190, tráva uvnitř r44).
    // Konec sedí PŘESNĚ na začátek hrany zúžení výjezdu sousedního ramene:
    // v tomto frame (146,-196)→(-196,-146); bypass k=1 ústí na Hradeckou,
    // jejíž hrana (146,-190) je v tomto frame (-190,-146).
    g.beginPath();
    g.moveTo(-136, -1600);
    g.lineTo(-136, -215);
    if (k === 1) g.bezierCurveTo(-136, -175, -155, -150, -190, -146);
    else g.bezierCurveTo(-136, -175, -150, -146, -196, -146);
    g.stroke();
    // hrana zúžení výjezdu podél skutečné travnaté hrany (Hradecká má vlastní)
    if (k !== 0) {
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(146, -196); g.quadraticCurveTo(124, -252, 96, -295); g.stroke();
    }
    // stopčára přes L+T1+T2 a zvlášť přes bypass
    g.lineWidth = 8;
    g.beginPath(); g.moveTo(-92, -164); g.lineTo(-12, -164); g.stroke();
    g.beginPath(); g.moveTo(-218, -142); g.lineTo(-218, -106); g.stroke();
    // šipky v pruzích (Zborovská k=2: dvě levé + jeden přímý)
    drawArrow(g, -24, -200, 'left');
    drawArrow(g, -52, -200, k === 2 ? 'left' : 'up');
    drawArrow(g, -80, -200, 'up');
    drawArrow(g, -24, -290, 'left');
    drawArrow(g, -52, -290, k === 2 ? 'left' : 'up');
    drawArrow(g, -80, -290, 'up');
    drawArrow(g, -115, -300, 'right');   // střed bypassového pruhu (-94..-136)
    // vodicí čáry levých odbočení křižovatkou (dle cílových pruhů) — jen decentní
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.setLineDash([10, 12]);
    const guides = k === 2 ? [[-24, 52], [-52, 80]] : k === 3 ? [[-24, 52]] : [[-24, 52], [-24, 80]];
    for (const [gx0, gey] of guides) {
      g.beginPath();
      g.moveTo(gx0, -160);
      g.bezierCurveTo(gx0, gey + 5, 35, gey, 150, gey);
      g.stroke();
    }
    g.setLineDash([]);

    // Výjezdy se zúženým profilem: k=0 Hradecká (JEDEN pruh — vnitřní i vnější
    // tráva), k=1 a k=3 Sokolská (DVA pruhy — vnitřní tráva místo třetího pruhu,
    // do vnějšího se dál napojuje bypass)
    {
      g.fillStyle = '#4a7c43';
      // vnitřní tráva všech výjezdů (hned od rohu křižovatky)
      g.beginPath();
      g.moveTo(8, -172);
      g.quadraticCurveTo(28, -195, 38, -240);
      g.lineTo(38, -1600); g.lineTo(8, -1600); g.closePath(); g.fill();
      seed = 33 + k;
      for (let i = 0; i < 110; i++) {
        const gx = 10 + srand() * 28, gy = -1600 + srand() * 1330;
        const gw = Math.min(srand() * 18 + 4, 36 - gx);   // zrnka nesmí přesáhnout hranu pásu (x=38) do pruhu
        if (gy > -260 || gw <= 0) continue;
        g.fillStyle = srand() < 0.5 ? 'rgba(38,74,34,0.35)' : 'rgba(110,160,90,0.25)';
        g.fillRect(gx, gy, gw, srand() * 18 + 4);
      }
      g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineCap = 'butt'; g.setLineDash([]);
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(8, -172);
      g.quadraticCurveTo(28, -195, 38, -240);
      g.lineTo(38, -1600); g.stroke();
    }
    if (k === 0) {
      // vnější tráva Hradecké: hrana kopíruje oblouk bypassu od rohu přímo na
      // hranu jediného pruhu — žádný záliv ani vykousnutí
      g.fillStyle = '#4a7c43';
      g.beginPath();
      g.moveTo(146, -190);
      g.quadraticCurveTo(110, -236, 66, -272);
      g.lineTo(66, -1600); g.lineTo(152, -1600); g.lineTo(152, -190);
      g.closePath(); g.fill();
      seed = 77;
      for (let i = 0; i < 130; i++) {
        const gx = 66 + srand() * 54, gy = -1600 + srand() * 1350;
        if (gy > -285) continue;
        g.fillStyle = srand() < 0.5 ? 'rgba(38,74,34,0.35)' : 'rgba(110,160,90,0.25)';
        g.fillRect(gx, gy, srand() * 18 + 4, srand() * 18 + 4);
      }
      g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineCap = 'butt'; g.setLineDash([]);
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(146, -190);
      g.quadraticCurveTo(110, -236, 66, -272);
      g.lineTo(66, -1600); g.stroke();
      for (const ay of [-620, -1000]) {
        g.save(); g.translate(52, ay); g.rotate(Math.PI); drawArrow(g, 0, 0, 'up'); g.restore();
      }
    }
    g.restore();
  }

  // ---- okolí podle reality (OSM data v buildings.js)
  // areál FN (jihozápad podél Zborovské) srovnat rovnoběžně s ulicí:
  // polygon se otočí kolem těžiště tak, aby nejdelší hrana byla v ose ulice
  function polyCenter(pts) {
    let cx = 0, cy = 0;
    for (const [x, y] of pts) { cx += x; cy += y; }
    return [cx / pts.length, cy / pts.length];
  }
  function snapPoly(pts) {
    let bi = 0, bl = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
      const l = dx * dx + dy * dy;
      if (l > bl) { bl = l; bi = i; }
    }
    const ang = Math.atan2(pts[bi + 1][1] - pts[bi][1], pts[bi + 1][0] - pts[bi][0]);
    const rot = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2) - ang;
    const [cx, cy] = polyCenter(pts);
    const c = Math.cos(rot), s = Math.sin(rot);
    return pts.map(([x, y]) =>
      [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
  }
  const inFN = pts => { const [cx, cy] = polyCenter(pts); return cy > 140 && cx < -60; };
  const builds = (window.REAL_BUILDINGS || []).map(b =>
    inFN(b.p) ? Object.assign({}, b, { p: snapPoly(b.p) }) : b);
  const parking = (window.REAL_PARKING || []).map(p => inFN(p) ? snapPoly(p) : p);
  // parkoviště pod budovami
  for (const pts of parking) {
    g.fillStyle = '#54575a';
    polyPath(g, pts); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.15)'; g.lineWidth = 2;
    polyPath(g, pts); g.stroke();
  }
  // budovy: stín, fasáda, střecha (styl podle typu a podlažnosti)
  builds.forEach((b, i) => drawRealBuilding(g, b, i));
  // stromy (vyhýbají se budovám)
  const bboxes = builds.map(b => {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of b.p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0 - 20, y0 - 20, x1 + 20, y1 + 20];
  });
  seed = 4242;
  for (let i = 0; i < 70; i++) {
    const x = (srand() * 2 - 1) * 1550, y = (srand() * 2 - 1) * 1550;
    const r = srand() * 16 + 14;
    if (Math.abs(x) < 195 || Math.abs(y) < 195) continue;
    if (Math.hypot(x, y) > 1600) continue;
    if (bboxes.some(bb => x > bb[0] && x < bb[2] && y > bb[1] && y < bb[3])) continue;
    drawTree(g, x, y, r);
  }
  // názvy ulic
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.font = 'italic bold 30px Georgia';
  for (let k = 0; k < 4; k++) {
    g.save();
    g.rotate(k * Math.PI / 2);
    g.translate(-215, -640);
    g.rotate(k === 1 ? -Math.PI / 2 : Math.PI / 2);  // ať text není vzhůru nohama
    g.textAlign = 'center';
    g.fillText(STREETS[k], 0, 0);
    g.restore();
  }
})();

function polyPath(g, pts) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
}
function drawRealBuilding(g, b, i) {
  const BUILD_ACCENTS = ['#c23b3b', '#3bb0c2', '#e0a13c', '#7fb069'];
  const pts = b.p;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length; cy /= pts.length;
  let st;
  if (b.l >= 7) st = { wall: '#a9a69e', roof: '#cfccc4', acc: BUILD_ACCENTS[i % BUILD_ACCENTS.length] };
  else if (b.t === 'school' || b.t === 'civic' || b.t === 'university' || b.t === 'dormitory')
    st = { wall: '#a89878', roof: '#d0c4a4' };
  else if (b.t === 'industrial' || b.t === 'warehouse' || b.t === 'commercial')
    st = { wall: '#8d939a', roof: '#b4bac0' };
  else if (b.l <= 1) st = { wall: '#84807a', roof: '#9c9890' };
  else st = { wall: '#93887c', roof: '#ac5a40' };            // rodinné domy: cihlová střecha
  const sh = 4 + b.l * 1.4;                                  // stín podle výšky
  g.save();
  g.translate(sh, sh * 1.15);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  polyPath(g, pts); g.fill();
  g.restore();
  g.fillStyle = st.wall;
  polyPath(g, pts); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 2.5;
  polyPath(g, pts); g.stroke();
  // střecha = polygon smrsklý ke středu
  const roof = pts.map(([x, y]) => [cx + (x - cx) * 0.8, cy + (y - cy) * 0.8]);
  g.fillStyle = st.roof;
  polyPath(g, roof); g.fill();
  if (st.acc) {                                              // barevný pruh panelák
    g.strokeStyle = st.acc; g.globalAlpha = 0.65; g.lineWidth = 7;
    polyPath(g, roof); g.stroke();
    g.globalAlpha = 1;
  }
}

// chevronové šrafování (V-značky) podél svislé osy od (x0,y0) k (x1,y1)
function drawChevrons(g, x0, y0, x1, y1, spacing, halfW) {
  g.save();
  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.lineWidth = 2.5; g.lineCap = 'round'; g.setLineDash([]);
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / spacing));
  for (let i = 0; i <= n; i++) {
    const x = lerp(x0, x1, i / n), y = lerp(y0, y1, i / n);
    // hrot chevronu míří ve směru jízdy (nahoru, tj. -y)
    g.beginPath();
    g.moveTo(x - halfW, y + halfW * 0.7);
    g.lineTo(x, y - halfW * 0.5);
    g.lineTo(x + halfW, y + halfW * 0.7);
    g.stroke();
  }
  g.restore();
}

function drawArrow(g, x, y, dir) {
  // kreslí se v lokálních souřadnicích nájezdu: vozidla jedou směrem +y
  g.save();
  g.translate(x, y);
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = 5; g.lineCap = 'butt';
  if (dir === 'up') {
    g.beginPath(); g.moveTo(0, -18); g.lineTo(0, 8); g.stroke();
    g.beginPath(); g.moveTo(0, 18); g.lineTo(-7, 4); g.lineTo(7, 4); g.closePath(); g.fill();
  } else {
    const sgn = dir === 'left' ? 1 : -1;   // vlevo = k mediánu (+x), bypass vpravo = od něj
    g.translate(-sgn * 7, 0);              // ohyb i hlava míří na jednu stranu — vycentrovat na osu pruhu
    g.beginPath(); g.moveTo(0, -18); g.lineTo(0, 0); g.stroke();
    g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(0, 10, sgn * 10, 10); g.stroke();
    g.beginPath(); g.moveTo(sgn * 16, 10); g.lineTo(sgn * 6, 16); g.lineTo(sgn * 6, 4); g.closePath(); g.fill();
  }
  g.restore();
}
function drawTree(g, x, y, r) {
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.beginPath(); g.arc(x + r * 0.3, y + r * 0.35, r, 0, TAU); g.fill();
  const grad = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.15, x, y, r);
  grad.addColorStop(0, '#6fa055'); grad.addColorStop(1, '#2f5c2a');
  g.fillStyle = grad;
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
}

// ==================== kreslení vozidel ====================
// kloubový bus: dva články sledující dráhu + harmonika mezi nimi
function drawWheelsLocal(W, axles, wheelLen = 7) {
  ctx.fillStyle = '#171a1d';
  for (const x of axles) {
    rr(ctx, x - wheelLen / 2, -W / 2 - 1.4, wheelLen, 3.6, 1); ctx.fill();
    rr(ctx, x - wheelLen / 2, W / 2 - 2.2, wheelLen, 3.6, 1); ctx.fill();
  }
}

function drawVehicleLightsLocal(L, W, braking) {
  ctx.fillStyle = '#fff0a8';
  ctx.fillRect(L / 2 - 2, -W / 2 + 1.2, 2.2, 4);
  ctx.fillRect(L / 2 - 2, W / 2 - 5.2, 2.2, 4);
  ctx.fillStyle = braking ? '#ff3d32' : '#8e2723';
  ctx.fillRect(-L / 2 - 0.2, -W / 2 + 1.2, 2.2, 4);
  ctx.fillRect(-L / 2 - 0.2, W / 2 - 5.2, 2.2, 4);
}

function drawIndicatorsLocal(v, L, W, front = true, rear = true) {
  if (!v.path || v.path.move === 'T' || v.crashed || Math.floor(G.time * 3.2) % 2) return;
  const y = v.path.move === 'L' ? -W / 2 + 0.7 : W / 2 - 3.2;
  ctx.save();
  ctx.fillStyle = '#ffb000';
  ctx.shadowColor = '#ffb000'; ctx.shadowBlur = 5;
  if (front) ctx.fillRect(L / 2 - 3.2, y, 3, 2.6);
  if (rear) ctx.fillRect(-L / 2 + 0.2, y, 3, 2.6);
  ctx.restore();
}

function drawMirrorsLocal(W, x) {
  ctx.fillStyle = '#20252a';
  ctx.fillRect(x, -W / 2 - 2.2, 3.5, 2.2);
  ctx.fillRect(x, W / 2, 3.5, 2.2);
}

function drawArticBus(v) {
  const W = v.def.wid;
  // harmonika (pod články)
  const pj = pathPose(v.path, v.s);
  ctx.save();
  ctx.translate(pj.x, pj.y); ctx.rotate(pj.ang);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(-8 + 3, -W / 2 + 5, 16, W - 2);
  ctx.fillStyle = '#3a3d41';
  rr(ctx, -8, -W / 2 + 1, 16, W - 2, 2); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.2;
  for (const jx of [-4, 0, 4]) {
    ctx.beginPath(); ctx.moveTo(jx, -W / 2 + 2); ctx.lineTo(jx, W / 2 - 1); ctx.stroke();
  }
  ctx.restore();
  // články
  for (const sg of ARTIC_SEGS) {
    const front = sg.off > 0;
    const p = pathPose(v.path, v.s + sg.off);
    const L = sg.len;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.ang);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(-L / 2 + 3, -W / 2 + 4, L, W);
    drawWheelsLocal(W, front ? [-L * 0.3, L * 0.31] : [-L * 0.28]);
    if (v.crashed) {
      ctx.fillStyle = '#222';
      rr(ctx, -L / 2, -W / 2, L, W, 4); ctx.fill();
      ctx.restore();
      continue;
    }
    ctx.fillStyle = '#d21f26';
    rr(ctx, -L / 2, -W / 2, L, W, 4); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1.5;
    rr(ctx, -L / 2, -W / 2, L, W, 4); ctx.stroke();
    ctx.fillStyle = '#f0e6d2';
    ctx.fillRect(-L / 2 + 3, -3, L - 6, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    for (let wx = -L / 2 + 8; wx < L / 2 - 10; wx += 11) {
      ctx.fillRect(wx, -W / 2 + 1.5, 7, 2.5);
      ctx.fillRect(wx, W / 2 - 4, 7, 2.5);
    }
    if (front) {
      ctx.fillStyle = 'rgba(25,35,55,0.9)';
      ctx.fillRect(L / 2 - 7, -W / 2 + 2, 4, W - 4);
      ctx.fillStyle = '#fff';
      ctx.fillRect(L * 0.1, -5.5, 12, 11);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 9px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.save();
      ctx.translate(L * 0.1 + 6, 0); ctx.rotate(Math.PI / 2);
      ctx.fillText(String(v.line), 0, 0);
      ctx.restore();
      ctx.fillStyle = '#ffe9a0';
      ctx.fillRect(L / 2 - 2, -W / 2 + 1, 2, 4);
      ctx.fillRect(L / 2 - 2, W / 2 - 5, 2, 4);
      drawMirrorsLocal(W, L / 2 - 10);
    } else {
      ctx.fillStyle = v.v < 2 ? '#ff3d32' : '#8e2723';
      ctx.fillRect(-L / 2, -W / 2 + 1, 2, 4);
      ctx.fillRect(-L / 2, W / 2 - 5, 2, 4);
    }
    drawIndicatorsLocal(v, L, W, front, !front);
    ctx.restore();
  }
}

// Osobní auto s jednonápravovým přívěsem. Auto i vozík mají vlastní pozici
// na dráze, takže se souprava v oblouku přirozeně zalamuje jako kloubový bus.
function drawCarTrailer(v) {
  const carSeg = CAR_TRAILER_SEGS[1], trailerSeg = CAR_TRAILER_SEGS[0];
  const carPose = pathPose(v.path, v.s + carSeg.off);
  const trailerPose = pathPose(v.path, v.s + trailerSeg.off);

  // Tažná oj se kreslí pod oběma karoseriemi.
  const carHitch = {
    x: carPose.x - Math.cos(carPose.ang) * (carSeg.len / 2 + 1),
    y: carPose.y - Math.sin(carPose.ang) * (carSeg.len / 2 + 1),
  };
  const trailerHitch = {
    x: trailerPose.x + Math.cos(trailerPose.ang) * (trailerSeg.len / 2 + 1),
    y: trailerPose.y + Math.sin(trailerPose.ang) * (trailerSeg.len / 2 + 1),
  };
  ctx.save();
  ctx.strokeStyle = v.crashed ? '#222' : '#4c5054';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(carHitch.x, carHitch.y);
  ctx.lineTo(trailerHitch.x, trailerHitch.y);
  ctx.stroke();
  ctx.restore();

  // Přívěsný vozík.
  ctx.save();
  ctx.translate(trailerPose.x, trailerPose.y); ctx.rotate(trailerPose.ang);
  const TL = trailerSeg.len, TW = trailerSeg.wid;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(-TL / 2 + 3, -TW / 2 + 4, TL, TW);
  ctx.fillStyle = v.crashed ? '#222' : '#7b858d';
  rr(ctx, -TL / 2, -TW / 2, TL, TW, 2); ctx.fill();
  ctx.strokeStyle = v.crashed ? '#111' : '#3f474d'; ctx.lineWidth = 1.5;
  rr(ctx, -TL / 2, -TW / 2, TL, TW, 2); ctx.stroke();
  if (!v.crashed) {
    // lem korby a jednoduchý náklad, aby byl vozík shora dobře čitelný
    ctx.strokeStyle = '#c1c7cb'; ctx.lineWidth = 2;
    rr(ctx, -TL / 2 + 3, -TW / 2 + 3, TL - 6, TW - 6, 1); ctx.stroke();
    if (v.trailerLoad === 'tarp') {
      ctx.fillStyle = '#4f7653';
      rr(ctx, -TL / 2 + 5, -TW / 2 + 4, TL - 10, TW - 8, 3); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-TL / 2 + 7, 0); ctx.lineTo(TL / 2 - 7, 0); ctx.stroke();
    } else if (v.trailerLoad === 'luggage') {
      ctx.fillStyle = '#9a6c3f';
      ctx.fillRect(-8, -6, 10, 7); ctx.fillRect(3, -5, 9, 9);
      ctx.strokeStyle = '#5e4027'; ctx.lineWidth = 1;
      ctx.strokeRect(-8, -6, 10, 7); ctx.strokeRect(3, -5, 9, 9);
    } else {
      ctx.fillStyle = '#343a3e';
      ctx.fillRect(-TL / 2 + 5, -TW / 2 + 5, TL - 10, TW - 10);
    }
    // kola a zadní světla
    ctx.fillStyle = '#1d2023';
    ctx.fillRect(-5, -TW / 2 - 1, 8, 3); ctx.fillRect(-5, TW / 2 - 2, 8, 3);
    ctx.fillStyle = v.v < 2 ? '#ff5540' : '#a03028';
    ctx.fillRect(-TL / 2, -TW / 2 + 2, 2, 4);
    ctx.fillRect(-TL / 2, TW / 2 - 6, 2, 4);
    drawIndicatorsLocal(v, TL, TW, false, true);
  }
  ctx.restore();

  // Tažné osobní auto.
  ctx.save();
  ctx.translate(carPose.x, carPose.y); ctx.rotate(carPose.ang);
  const L = carSeg.len, W = carSeg.wid;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(-L / 2 + 3, -W / 2 + 4, L, W);
  drawWheelsLocal(W, [-L * 0.3, L * 0.3], 6.5);
  ctx.fillStyle = v.crashed ? '#222' : v.color;
  rr(ctx, -L / 2, -W / 2, L, W, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5;
  rr(ctx, -L / 2, -W / 2, L, W, 4); ctx.stroke();
  if (!v.crashed) {
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    rr(ctx, -L * 0.23, -W / 2 + 2, L * 0.48, W - 4, 4); ctx.fill();
    ctx.fillStyle = 'rgba(25,35,55,0.85)';
    ctx.fillRect(L * 0.16, -W / 2 + 2.5, 4.5, W - 5);
    ctx.fillRect(-L * 0.21, -W / 2 + 2.5, 3.5, W - 5);
    ctx.strokeStyle = 'rgba(0,0,0,0.32)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L * 0.32, -W / 2 + 2); ctx.lineTo(L * 0.32, W / 2 - 2); ctx.stroke();
    drawMirrorsLocal(W, L * 0.11);
    drawVehicleLightsLocal(L, W, v.v < 2);
    drawIndicatorsLocal(v, L, W, true, false);
  }
  ctx.restore();
}

function drawTractorTrailer(v) {
  const trailerSeg = TRACTOR_TRAILER_SEGS[0], tractorSeg = TRACTOR_TRAILER_SEGS[1];
  const trailerPose = pathPose(v.path, v.s + trailerSeg.off);
  const tractorPose = pathPose(v.path, v.s + tractorSeg.off);

  // Zemědělský valník se dvěma nápravami a plnou vrstvou balíků slámy.
  ctx.save();
  ctx.translate(trailerPose.x, trailerPose.y); ctx.rotate(trailerPose.ang);
  const TL = trailerSeg.len, TW = trailerSeg.wid;
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fillRect(-TL / 2 + 4, -TW / 2 + 5, TL, TW);
  drawWheelsLocal(TW, [-TL * 0.22, -TL * 0.02], 8);
  ctx.fillStyle = v.crashed ? '#222' : '#674727';
  rr(ctx, -TL / 2, -TW / 2, TL, TW, 2); ctx.fill();
  ctx.strokeStyle = v.crashed ? '#111' : '#342515'; ctx.lineWidth = 1.5;
  rr(ctx, -TL / 2, -TW / 2, TL, TW, 2); ctx.stroke();
  if (!v.crashed) {
    // Osm hranatých balíků ve dvou řadách, každý se stahovacím provázkem.
    const baleXs = [-18, -6, 6, 18];
    for (const bx of baleXs) {
      for (const by of [-5.2, 5.2]) {
        ctx.fillStyle = '#d6a632';
        rr(ctx, bx - 5, by - 4.5, 10, 9, 2); ctx.fill();
        ctx.strokeStyle = '#8b6720'; ctx.lineWidth = 1;
        rr(ctx, bx - 5, by - 4.5, 10, 9, 2); ctx.stroke();
        ctx.strokeStyle = '#5c4930'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,235,145,0.65)';
        ctx.beginPath(); ctx.moveTo(bx - 3.5, by - 2.5); ctx.lineTo(bx + 3.5, by - 2.5); ctx.stroke();
      }
    }
    // horní dva balíky vytvářejí dojem plně naloženého vozu
    for (const bx of [-7, 7]) {
      ctx.fillStyle = '#e0b33e';
      rr(ctx, bx - 5, -4.5, 10, 9, 2); ctx.fill();
      ctx.strokeStyle = '#8b6720'; ctx.lineWidth = 1;
      rr(ctx, bx - 5, -4.5, 10, 9, 2); ctx.stroke();
      ctx.strokeStyle = '#5c4930'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(bx, -4); ctx.lineTo(bx, 4); ctx.stroke();
    }
    ctx.fillStyle = v.v < 2 ? '#ff3d32' : '#8e2723';
    ctx.fillRect(-TL / 2, -TW / 2 + 1, 2.5, 4.5);
    ctx.fillRect(-TL / 2, TW / 2 - 5.5, 2.5, 4.5);
    drawIndicatorsLocal(v, TL, TW, false, true);
  }
  ctx.restore();

  // Oj mezi valníkem a traktorem.
  const trailerFront = {
    x: trailerPose.x + Math.cos(trailerPose.ang) * (TL / 2 + 1),
    y: trailerPose.y + Math.sin(trailerPose.ang) * (TL / 2 + 1),
  };
  const tractorRear = {
    x: tractorPose.x - Math.cos(tractorPose.ang) * (tractorSeg.len / 2 + 1),
    y: tractorPose.y - Math.sin(tractorPose.ang) * (tractorSeg.len / 2 + 1),
  };
  ctx.save();
  ctx.strokeStyle = v.crashed ? '#222' : '#3d3428'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(trailerFront.x, trailerFront.y); ctx.lineTo(tractorRear.x, tractorRear.y); ctx.stroke();
  ctx.restore();

  // Traktor: velká zadní kola, malá řiditelná přední kola, kabina a kapota.
  ctx.save();
  ctx.translate(tractorPose.x, tractorPose.y); ctx.rotate(tractorPose.ang);
  const L = tractorSeg.len, W = tractorSeg.wid;
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fillRect(-L / 2 + 4, -W / 2 + 5, L, W);
  drawWheelsLocal(W, [-L * 0.24], 11);
  drawWheelsLocal(W - 3, [L * 0.31], 6.5);
  ctx.fillStyle = v.crashed ? '#222' : '#2c3030';
  rr(ctx, -L / 2 + 2, -W / 2 + 2, L - 4, W - 4, 3); ctx.fill();
  ctx.fillStyle = v.crashed ? '#222' : v.color;
  rr(ctx, L * 0.04, -W / 2 + 2, L * 0.46, W - 4, 5); ctx.fill();
  rr(ctx, -L * 0.27, -W / 2, L * 0.34, W, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5;
  rr(ctx, -L * 0.27, -W / 2, L * 0.34, W, 4); ctx.stroke();
  if (!v.crashed) {
    ctx.fillStyle = 'rgba(28,43,53,0.9)';
    ctx.fillRect(L * 0.01, -W / 2 + 3, 4.5, W - 6);
    ctx.fillStyle = 'rgba(190,220,230,0.34)';
    rr(ctx, -L * 0.22, -W / 2 + 3, L * 0.19, W - 6, 2); ctx.fill();
    drawMirrorsLocal(W, L * 0.01);
    drawVehicleLightsLocal(L, W, v.v < 2);
    drawIndicatorsLocal(v, L, W, true, false);
    // výfuk a oranžový maják
    ctx.fillStyle = '#272b2d';
    ctx.fillRect(L * 0.05, -W / 2 - 2, 3, 4);
    ctx.fillStyle = '#ffad22';
    ctx.beginPath(); ctx.arc(-L * 0.11, 0, 2.3, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function drawSemiTruck(v) {
  const trailerSeg = SEMI_SEGS[0], tractorSeg = SEMI_SEGS[1];
  const trailerPose = pathPose(v.path, v.s + trailerSeg.off);
  const tractorPose = pathPose(v.path, v.s + tractorSeg.off);

  // Návěs: dlouhá skříň se zesíleným rámem, zadními vraty a dvěma nápravami.
  ctx.save();
  ctx.translate(trailerPose.x, trailerPose.y); ctx.rotate(trailerPose.ang);
  const TL = trailerSeg.len, TW = trailerSeg.wid;
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fillRect(-TL / 2 + 4, -TW / 2 + 5, TL, TW);
  drawWheelsLocal(TW, [-TL * 0.31, -TL * 0.17], 8);
  ctx.fillStyle = v.crashed ? '#222' : v.cargoColor;
  rr(ctx, -TL / 2, -TW / 2, TL, TW, 3); ctx.fill();
  ctx.strokeStyle = v.crashed ? '#111' : '#646b6f'; ctx.lineWidth = 1.5;
  rr(ctx, -TL / 2, -TW / 2, TL, TW, 3); ctx.stroke();
  if (!v.crashed) {
    // podélné střešní prolisy a boční rám
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;
    for (const y of [-TW * 0.27, 0, TW * 0.27]) {
      ctx.beginPath(); ctx.moveTo(-TL / 2 + 3, y); ctx.lineTo(TL / 2 - 3, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(50,55,58,0.55)';
    ctx.beginPath(); ctx.moveTo(-TL / 2 + 4, -TW / 2 + 3); ctx.lineTo(-TL / 2 + 4, TW / 2 - 3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-TL / 2 + 8, -TW / 2 + 3); ctx.lineTo(-TL / 2 + 8, TW / 2 - 3); ctx.stroke();
    ctx.fillStyle = '#d9dde0';
    ctx.fillRect(-TL / 2 + 1, -2.2, 2, 4.4);
    ctx.fillStyle = v.v < 2 ? '#ff3d32' : '#8e2723';
    ctx.fillRect(-TL / 2, -TW / 2 + 1, 2.3, 4.5);
    ctx.fillRect(-TL / 2, TW / 2 - 5.5, 2.3, 4.5);
    drawIndicatorsLocal(v, TL, TW, false, true);
  }
  ctx.restore();

  // Točna a rám mezi návěsem a tahačem.
  const trailerFront = {
    x: trailerPose.x + Math.cos(trailerPose.ang) * (TL / 2 - 2),
    y: trailerPose.y + Math.sin(trailerPose.ang) * (TL / 2 - 2),
  };
  const tractorRear = {
    x: tractorPose.x - Math.cos(tractorPose.ang) * (tractorSeg.len / 2 - 3),
    y: tractorPose.y - Math.sin(tractorPose.ang) * (tractorSeg.len / 2 - 3),
  };
  ctx.save();
  ctx.strokeStyle = '#252a2e'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(trailerFront.x, trailerFront.y); ctx.lineTo(tractorRear.x, tractorRear.y); ctx.stroke();
  ctx.restore();

  // Evropský tahač s krátkou kabinou a lůžkovou nástavbou.
  ctx.save();
  ctx.translate(tractorPose.x, tractorPose.y); ctx.rotate(tractorPose.ang);
  const L = tractorSeg.len, W = tractorSeg.wid;
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fillRect(-L / 2 + 4, -W / 2 + 5, L, W);
  drawWheelsLocal(W, [-L * 0.28, L * 0.28], 8);
  ctx.fillStyle = v.crashed ? '#222' : '#30363a';
  rr(ctx, -L / 2, -W / 2 + 2, L * 0.4, W - 4, 2); ctx.fill();
  ctx.fillStyle = v.crashed ? '#222' : v.color;
  rr(ctx, -L * 0.1, -W / 2, L * 0.6, W, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5;
  rr(ctx, -L * 0.1, -W / 2, L * 0.6, W, 5); ctx.stroke();
  if (!v.crashed) {
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    rr(ctx, -L * 0.02, -W / 2 + 3, L * 0.24, W - 6, 3); ctx.fill();
    ctx.fillStyle = 'rgba(18,31,43,0.92)';
    ctx.fillRect(L / 2 - 7, -W / 2 + 3, 4.5, W - 6);
    ctx.fillStyle = '#15191c';
    ctx.fillRect(L / 2 - 1.5, -W / 2 + 5, 1.5, W - 10);
    drawMirrorsLocal(W, L / 2 - 10);
    drawVehicleLightsLocal(L, W, v.v < 2);
    drawIndicatorsLocal(v, L, W, true, false);
    // střešní světla a výfuk za kabinou
    ctx.fillStyle = '#ffcf68';
    for (const y of [-6, 0, 6]) ctx.fillRect(L / 2 - 2, y - 0.8, 1.5, 1.6);
    ctx.fillStyle = '#303438';
    ctx.fillRect(-L * 0.1, -W / 2 - 1, 5, 2.5);
  }
  ctx.restore();
}

function drawVehicle(v) {
  if (v.def.tractorTrailer) { drawTractorTrailer(v); return; }
  if (v.def.semi) { drawSemiTruck(v); return; }
  if (v.def.trailer) { drawCarTrailer(v); return; }
  if (v.def.artic) { drawArticBus(v); return; }
  const { x, y, ang } = v.pose;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  const L = v.def.len, W = v.def.wid;
  // stín
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(-L / 2 + 3, -W / 2 + 4, L, W);
  if (v.crashed) {
    ctx.fillStyle = '#222';
    rr(ctx, -L / 2, -W / 2, L, W, 4); ctx.fill();
    ctx.restore();
    return;
  }
  if (v.emg) {
    drawWheelsLocal(W, [-L * 0.3, L * 0.3], L >= 65 ? 8 : 6.5);
    drawEmergencyBody(v, L, W);
    ctx.restore();
    return;
  }
  if (v.mhd) {
    drawWheelsLocal(W, [-L * 0.34, L * 0.34], 8);
    drawMhdBody(v, L, W);
    ctx.restore();
    return;
  }
  if (v.type === 'moto') {
    ctx.fillStyle = '#111518';
    ctx.beginPath(); ctx.ellipse(-L * 0.32, 0, 5, 3.2, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(L * 0.34, 0, 5, 3.2, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#2c3034';
    rr(ctx, -L / 2 + 4, -2.2, L - 8, 4.4, 2); ctx.fill();
    ctx.fillStyle = v.color;
    rr(ctx, -3, -4, 10, 8, 3); ctx.fill();
    ctx.fillStyle = '#202b36';
    ctx.beginPath(); ctx.arc(1, 0, 4, 0, TAU); ctx.fill();
    ctx.fillStyle = v.color;
    ctx.beginPath(); ctx.arc(5, 0, 3.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#30363b'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(L * 0.25, -4); ctx.lineTo(L * 0.25, 4); ctx.stroke();
    ctx.fillStyle = '#fff0a8'; ctx.fillRect(L / 2 - 3, -1.4, 2.5, 2.8);
    ctx.fillStyle = v.v < 2 ? '#ff3d32' : '#8e2723'; ctx.fillRect(-L / 2 + 1, -1.3, 2, 2.6);
    drawIndicatorsLocal(v, L, W);
    ctx.restore();
    return;
  }

  const heavyRigid = v.type === 'truck' || v.type === 'tanker' || v.type === 'garbage';
  const axles = heavyRigid ? [-L * 0.36, -L * 0.2, L * 0.31]
    : v.type === 'bus' ? [-L * 0.34, L * 0.34]
    : [-L * 0.3, L * 0.3];
  drawWheelsLocal(W, axles, heavyRigid || v.type === 'tow' || v.type === 'bus' ? 8 : 6.5);
  // karoserie
  ctx.fillStyle = v.color;
  rr(ctx, -L / 2, -W / 2, L, W, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5;
  rr(ctx, -L / 2, -W / 2, L, W, 4); ctx.stroke();
  if (v.type === 'truck') {
    // Pevný nákladní vůz: samostatná skříň a krátká kabina.
    ctx.fillStyle = v.cargoColor;
    rr(ctx, -L / 2 + 2, -W / 2 + 1, L * 0.63, W - 2, 2); ctx.fill();
    ctx.strokeStyle = 'rgba(45,50,54,0.5)'; ctx.lineWidth = 1;
    for (let x = -L / 2 + 9; x < L * 0.08; x += 10) {
      ctx.beginPath(); ctx.moveTo(x, -W / 2 + 2); ctx.lineTo(x, W / 2 - 2); ctx.stroke();
    }
    ctx.fillStyle = v.color;
    rr(ctx, L * 0.14, -W / 2, L * 0.36, W, 4); ctx.fill();
    ctx.fillStyle = 'rgba(20,32,44,0.92)';
    ctx.fillRect(L / 2 - 7, -W / 2 + 3, 4.5, W - 6);
    drawMirrorsLocal(W, L / 2 - 10);
  } else if (v.type === 'tanker') {
    // Cisterna: válcová lesklá nádrž, plnicí víko a výstražný kosočtverec.
    ctx.fillStyle = '#32383c';
    rr(ctx, -L / 2 + 1, -W / 2 + 3, L * 0.68, W - 6, 3); ctx.fill();
    ctx.fillStyle = v.cargoColor || '#b8bec1';
    rr(ctx, -L / 2 + 3, -W / 2 + 2, L * 0.63, W - 4, W / 2 - 2); ctx.fill();
    ctx.strokeStyle = 'rgba(55,62,66,0.65)'; ctx.lineWidth = 1.2;
    for (let x = -L / 2 + 13; x < L * 0.08; x += 13) {
      ctx.beginPath(); ctx.moveTo(x, -W / 2 + 3); ctx.lineTo(x, W / 2 - 3); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.58)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-L / 2 + 8, -W * 0.22); ctx.lineTo(L * 0.08, -W * 0.22); ctx.stroke();
    ctx.fillStyle = '#343a3e';
    ctx.beginPath(); ctx.arc(-L * 0.12, 0, 3.2, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f4a62a';
    ctx.save(); ctx.translate(-L / 2 + 7, 0); ctx.rotate(Math.PI / 4); ctx.fillRect(-3, -3, 6, 6); ctx.restore();
    ctx.fillStyle = v.color;
    rr(ctx, L * 0.15, -W / 2, L * 0.35, W, 4); ctx.fill();
    ctx.fillStyle = 'rgba(20,32,44,0.92)';
    ctx.fillRect(L / 2 - 7, -W / 2 + 3, 4.5, W - 6);
    drawMirrorsLocal(W, L / 2 - 10);
  } else if (v.type === 'garbage') {
    // Popelářský vůz: žebrovaný lis, zadní násypka a oranžové pracovní majáky.
    ctx.fillStyle = '#253b31';
    rr(ctx, -L / 2 + 1, -W / 2 + 1, L * 0.68, W - 2, 3); ctx.fill();
    ctx.fillStyle = v.color;
    ctx.beginPath();
    ctx.moveTo(-L / 2 + 3, -W / 2 + 4); ctx.lineTo(L * 0.12, -W / 2 + 1);
    ctx.lineTo(L * 0.12, W / 2 - 1); ctx.lineTo(-L / 2 + 3, W / 2 - 4); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(220,235,225,0.35)'; ctx.lineWidth = 1.2;
    for (let x = -L / 2 + 10; x < L * 0.07; x += 9) {
      ctx.beginPath(); ctx.moveTo(x, -W / 2 + 4); ctx.lineTo(x, W / 2 - 4); ctx.stroke();
    }
    ctx.fillStyle = '#202629';
    ctx.fillRect(-L / 2 + 1, -W / 2 + 5, 5, W - 10);
    ctx.strokeStyle = '#c7c9c8'; ctx.lineWidth = 1.8;
    ctx.strokeRect(-L / 2 - 1, -6, 5, 12);
    ctx.fillStyle = v.color;
    rr(ctx, L * 0.14, -W / 2, L * 0.36, W, 4); ctx.fill();
    ctx.fillStyle = 'rgba(20,32,44,0.92)';
    ctx.fillRect(L / 2 - 7, -W / 2 + 3, 4.5, W - 6);
    ctx.fillStyle = '#ffad22';
    ctx.beginPath(); ctx.arc(L * 0.1, -6, 1.9, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(L * 0.1, 6, 1.9, 0, TAU); ctx.fill();
    drawMirrorsLocal(W, L / 2 - 10);
  } else if (v.type === 'tow') {
    // Odtahovka: sklopná plošina s navijákem, vodicími lištami a hákem.
    ctx.fillStyle = '#555d62';
    rr(ctx, -L / 2 + 1, -W / 2 + 2, L * 0.66, W - 4, 2); ctx.fill();
    ctx.strokeStyle = '#c6ccd0'; ctx.lineWidth = 1;
    for (const y of [-W * 0.27, W * 0.27]) {
      ctx.beginPath(); ctx.moveTo(-L / 2 + 4, y); ctx.lineTo(L * 0.1, y); ctx.stroke();
    }
    ctx.strokeStyle = '#f3b52c'; ctx.lineWidth = 2;
    for (let x = -L / 2 + 5; x < -L * 0.2; x += 7) {
      ctx.beginPath(); ctx.moveTo(x, -W / 2 + 3); ctx.lineTo(x + 5, W / 2 - 3); ctx.stroke();
    }
    ctx.fillStyle = '#24292d';
    ctx.beginPath(); ctx.arc(L * 0.04, 0, 3.5, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#272c30'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(L * 0.04, 0); ctx.lineTo(-L * 0.22, 0); ctx.lineTo(-L * 0.3, 3); ctx.stroke();
    ctx.fillStyle = v.color;
    rr(ctx, L * 0.15, -W / 2, L * 0.35, W, 4); ctx.fill();
    ctx.fillStyle = 'rgba(20,32,44,0.92)';
    ctx.fillRect(L / 2 - 7, -W / 2 + 3, 4.5, W - 6);
    ctx.fillStyle = '#ffad22';
    ctx.beginPath(); ctx.arc(L * 0.12, 0, 2.1, 0, TAU); ctx.fill();
    drawMirrorsLocal(W, L / 2 - 10);
  } else if (v.type === 'bus') {
    // Linkový autobus: střešní panel, okna, dveře a čelní sklo.
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    rr(ctx, -L * 0.28, -W / 2 + 4, L * 0.55, W - 8, 3); ctx.fill();
    ctx.fillStyle = 'rgba(220,235,245,0.34)';
    for (let wx = -L / 2 + 8; wx < L / 2 - 10; wx += 10) ctx.fillRect(wx, -W / 2 + 1.5, 6, 2.5);
    for (let wx = -L / 2 + 8; wx < L / 2 - 10; wx += 10) ctx.fillRect(wx, W / 2 - 4, 6, 2.5);
    ctx.fillStyle = 'rgba(20,32,44,0.92)';
    ctx.fillRect(L / 2 - 7, -W / 2 + 2, 4, W - 4);
    ctx.strokeStyle = 'rgba(20,25,30,0.65)'; ctx.lineWidth = 1;
    ctx.strokeRect(L * 0.05, W / 2 - 4.5, 13, 3.5);
    drawMirrorsLocal(W, L / 2 - 10);
  } else if (v.type === 'van') {
    // Dodávka má vysokou souvislou střechu, krátkou kapotu a zadní vrata.
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    rr(ctx, -L * 0.32, -W / 2 + 2, L * 0.58, W - 4, 3); ctx.fill();
    ctx.fillStyle = 'rgba(20,32,44,0.9)';
    ctx.fillRect(L * 0.22, -W / 2 + 2, 4.5, W - 4);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-L * 0.28, -W / 2 + 2); ctx.lineTo(-L * 0.28, W / 2 - 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-L / 2 + 4, 0); ctx.lineTo(-L * 0.28, 0); ctx.stroke();
    drawMirrorsLocal(W, L * 0.18);
  } else {
    // Osobní auto: kapota, kabina se skly, kufr, zrcátka a spáry karoserie.
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    rr(ctx, -L * 0.23, -W / 2 + 2, L * 0.48, W - 4, 4); ctx.fill();
    ctx.fillStyle = 'rgba(18,31,43,0.9)';
    ctx.fillRect(L * 0.16, -W / 2 + 2.5, 4.5, W - 5);
    ctx.fillRect(-L * 0.21, -W / 2 + 2.5, 3.5, W - 5);
    ctx.strokeStyle = 'rgba(0,0,0,0.32)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L * 0.32, -W / 2 + 2); ctx.lineTo(L * 0.32, W / 2 - 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-L * 0.34, -W / 2 + 2); ctx.lineTo(-L * 0.34, W / 2 - 2); ctx.stroke();
    if (v.id % 4 === 0) {
      ctx.fillStyle = 'rgba(18,31,43,0.55)';
      rr(ctx, -4, -W * 0.22, 10, W * 0.44, 2); ctx.fill();
    }
    drawMirrorsLocal(W, L * 0.11);
  }
  drawVehicleLightsLocal(L, W, v.v < 2);
  drawIndicatorsLocal(v, L, W);
  ctx.restore();
}
// sanitka / policie / hasiči — karoserie s pruhem a blikajícími majáky
function drawEmergencyBody(v, L, W) {
  // výrazné pulzující halo, dokud mise běží — ať je vozidlo na mapě vidět
  if (!v.missionDone && !v.crashed) {
    const ph2 = Math.floor(G.time * 6) % 2 === 0;
    const pr = 40 + 12 * Math.sin(G.time * 8);
    const col = ph2 ? '42,127,255' : '255,59,48';
    const grd = ctx.createRadialGradient(0, 0, 5, 0, 0, pr);
    grd.addColorStop(0, `rgba(${col},0.6)`);
    grd.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(0, 0, pr, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = v.color;
  rr(ctx, -L / 2, -W / 2, L, W, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1.5;
  rr(ctx, -L / 2, -W / 2, L, W, 4); ctx.stroke();
  // podélný pruh: sanitka červený, policie tmavý, hasiči bílý
  ctx.fillStyle = v.emg === 'ambulance' ? '#d21f26' : v.emg === 'police' ? '#20242a' : '#f0f0f0';
  ctx.fillRect(-L / 2 + 4, -2.5, L - 8, 5);
  // čelní sklo
  ctx.fillStyle = 'rgba(25,35,55,0.85)';
  ctx.fillRect(L / 2 - L * 0.3, -W / 2 + 2, 4.5, W - 4);
  drawMirrorsLocal(W, L / 2 - L * 0.34);
  // označení na střeše: kříž sanitky, policejní panel nebo hasičské skříně
  if (v.emg === 'ambulance') {
    ctx.fillStyle = '#d21f26';
    ctx.fillRect(-L * 0.14, -2, 13, 4); ctx.fillRect(-L * 0.14 + 4.5, -6.5, 4, 13);
  } else if (v.emg === 'fire') {
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 2;
    ctx.strokeRect(-L * 0.27, -W * 0.29, L * 0.34, W * 0.58);
  } else {
    ctx.fillStyle = 'rgba(25,35,55,0.42)';
    rr(ctx, -L * 0.2, -W * 0.3, L * 0.34, W * 0.6, 3); ctx.fill();
  }
  // majáky: střídavě modrá/červená
  const ph = Math.floor(G.time * 6) % 2 === 0;
  const cols = v.emg === 'police' ? ['#2a7fff', '#2a7fff'] : ['#2a7fff', '#ff3b30'];
  [[-4, ph], [4, !ph]].forEach(([dx, on], i) => {
    ctx.beginPath(); ctx.arc(L * 0.12 + dx, 0, 2.6, 0, TAU);
    ctx.fillStyle = on ? cols[i] : '#555';
    ctx.fill();
    if (on) {
      ctx.save();
      ctx.globalAlpha = 0.6; ctx.shadowColor = cols[i]; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(L * 0.12 + dx, 0, 4, 0, TAU); ctx.fillStyle = cols[i]; ctx.fill();
      ctx.restore();
    }
  });
  drawVehicleLightsLocal(L, W, v.v < 2);
  drawIndicatorsLocal(v, L, W);
}

// autobus / trolejbus MHD Hradec Králové — červená s krémovým pruhem
function drawMhdBody(v, L, W) {
  // trolejbusové sběrače (pod karoserií, míří dozadu)
  if (v.mhd === 'trolley') {
    ctx.strokeStyle = '#2a2d31'; ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(L * 0.1, -3); ctx.lineTo(-L / 2 - 16, -5);
    ctx.moveTo(L * 0.1, 3); ctx.lineTo(-L / 2 - 16, 5);
    ctx.stroke();
  }
  ctx.fillStyle = '#d21f26';
  rr(ctx, -L / 2, -W / 2, L, W, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1.5;
  rr(ctx, -L / 2, -W / 2, L, W, 5); ctx.stroke();
  // krémový podélný pruh
  ctx.fillStyle = '#f0e6d2';
  ctx.fillRect(-L / 2 + 4, -3, L - 8, 6);
  // střešní klimatizace a servisní kryty
  ctx.fillStyle = 'rgba(245,238,220,0.5)';
  rr(ctx, -L * 0.22, -W * 0.25, L * 0.38, W * 0.5, 3); ctx.fill();
  ctx.fillStyle = 'rgba(40,45,50,0.35)';
  rr(ctx, -5, -4, 13, 8, 2); ctx.fill();
  // okna po stranách
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  for (let wx = -L / 2 + 10; wx < L / 2 - 12; wx += 11) {
    ctx.fillRect(wx, -W / 2 + 1.5, 7, 2.5);
    ctx.fillRect(wx, W / 2 - 4, 7, 2.5);
  }
  // čelní sklo + terč s číslem linky
  ctx.fillStyle = 'rgba(25,35,55,0.9)';
  ctx.fillRect(L / 2 - 7, -W / 2 + 2, 4, W - 4);
  drawMirrorsLocal(W, L / 2 - 10);
  ctx.strokeStyle = 'rgba(25,30,35,0.7)'; ctx.lineWidth = 1;
  ctx.strokeRect(L * 0.03, W / 2 - 4.5, 13, 3.5);
  ctx.fillStyle = '#fff';
  ctx.fillRect(L * 0.28, -5.5, 12, 11);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 9px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.save();
  ctx.translate(L * 0.28 + 6, 0); ctx.rotate(Math.PI / 2);
  ctx.fillText(String(v.line), 0, 0);
  ctx.restore();
  drawVehicleLightsLocal(L, W, v.v < 2);
  drawIndicatorsLocal(v, L, W);
}

function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ==================== kreslení semaforů ====================
// podbarvené pruhy u stopčar (lokálně): T přes přímé pruhy, L přes levý, R přes bypass
const GLOW_RECT = { T: [-92, -170, 54, 8], L: [-36, -170, 26, 8], R: [-222, -142, 8, 36] };
function glowColor(st) {
  return st === 'green' ? 'rgba(60,220,90,0.45)'
       : st === 'amber' || st === 'redamber' ? 'rgba(255,190,40,0.45)'
       : 'rgba(255,60,50,0.45)';
}
function drawSignalHead(sig, small) {
  const w = small ? 18 : 22, h = small ? 52 : 60, r = small ? 5.5 : 7;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  rr(ctx, -w / 2 + 3, -h / 2 + 4, w, h, 5); ctx.fill();
  ctx.fillStyle = '#1c1e22';
  rr(ctx, -w / 2, -h / 2, w, h, 5); ctx.fill();
  ctx.strokeStyle = '#ffd23a'; ctx.lineWidth = 2;
  rr(ctx, -w / 2, -h / 2, w, h, 5); ctx.stroke();
  // pořadí komor opticky prohozené (přání: zelená a červená naopak než dřív)
  const lamps = [
    ['#3ddc55', sig.state === 'green'],
    ['#ffb320', sig.state === 'amber' || sig.state === 'redamber'],
    ['#ff3b30', sig.state === 'red' || sig.state === 'redamber'],
  ];
  const step = h / 3.4;
  lamps.forEach(([col, on], i) => {
    ctx.beginPath(); ctx.arc(0, (i - 1) * step, r, 0, TAU);
    ctx.fillStyle = on ? col : '#3a3d42';
    ctx.fill();
    if (on) {
      ctx.save();
      ctx.globalAlpha = 0.5; ctx.shadowColor = col; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(0, (i - 1) * step, r + 2, 0, TAU); ctx.fillStyle = col; ctx.fill();
      ctx.restore();
    }
  });
}
// kompletní matice konfliktních zelených — všechna zapojená návěstidla blikají:
//  • bypass k × přímý k+1 (cpe se mu do pruhu)
//  • kolmé přímé směry (kříží se v křižovatce)
//  • levá k × přímý kteréhokoli jiného ramene (protisměr v křižovatce,
//    kolmé u vjezdu, k+3 ve sdíleném výjezdovém pruhu)
//  • levá k × bypass k+2 (sdílený výjezdový pruh)
function conflictSet() {
  const s = new Set();
  const g = (k, key) => G.signals[k][key].state === 'green';
  const mark = (a, b) => { s.add(a); s.add(b); };
  for (let k = 0; k < 4; k++) {
    if (g(k, 'R') && g((k + 1) % 4, 'T')) mark(k + 'R', ((k + 1) % 4) + 'T');
    if (g(k, 'T') && g((k + 1) % 4, 'T')) mark(k + 'T', ((k + 1) % 4) + 'T');
    if (g(k, 'L')) {
      for (const o of [1, 2, 3]) {
        const b = (k + o) % 4;
        if (g(b, 'T')) mark(k + 'L', b + 'T');
      }
      if (g((k + 2) % 4, 'R')) mark(k + 'L', ((k + 2) % 4) + 'R');
    }
  }
  return s;
}
function drawSignalGlows() {
  for (let k = 0; k < 4; k++) {
    for (const key of SIG_KEYS) {
      const sig = G.signals[k][key];
      ctx.save();
      ctx.rotate(k * Math.PI / 2);
      ctx.fillStyle = glowColor(sig.state);
      ctx.fillRect(...GLOW_RECT[key]);
      ctx.restore();
    }
  }
}
function drawSignals() {
  const confl = conflictSet();
  const blink = Math.floor(G.time * 3) % 2 === 0;
  for (let k = 0; k < 4; k++) {
    for (const key of SIG_KEYS) {
      const sig = G.signals[k][key];
      const pos = armXform(k, SIG_POS[key].x, SIG_POS[key].y);
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate(k * Math.PI / 2 + (key === 'R' ? Math.PI / 3 : 0));   // bypass zarovnán s pruhem u napojení
      drawSignalHead(sig, key !== 'T');
      // varování: konfliktní zelené (riziko srážky v zaústění)
      if (confl.has(k + key) && blink) {
        ctx.strokeStyle = '#ff8c1a'; ctx.lineWidth = 4;
        const w2 = key === 'T' ? 22 : 18, h2 = key === 'T' ? 60 : 52;
        rr(ctx, -w2 / 2 - 4, -h2 / 2 - 4, w2 + 8, h2 + 8, 8); ctx.stroke();
      }
      ctx.restore();
    }
  }
}
// popisky kláves kreslíme v rovině obrazovky (aby se daly číst)
const LABEL_OFF = { T: { x: -144, y: -184 }, L: { x: -1, y: -246 }, R: { x: -218, y: -196 } };
function drawSignalLabels() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = 'bold 15px Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const confl2 = conflictSet();
  for (let k = 0; k < 4; k++) {
    for (const key of SIG_KEYS) {
      const pos = armXform(k, LABEL_OFF[key].x, LABEL_OFF[key].y);
      const sp = worldToScreen(pos.x, pos.y);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 11, 0, TAU); ctx.fill();
      const warn2 = confl2.has(k + key) && Math.floor(G.time * 3) % 2 === 0;
      ctx.strokeStyle = warn2 ? '#ff8c1a' : key === 'T' ? '#ffd23a' : key === 'L' ? '#7fc4ff' : '#9fe08a';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 11, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(SIG_LABEL[key][k], sp.x, sp.y + 1);
    }
  }
}

// ==================== kouř z výfuku ====================
function drawSmoke(dt) {
  for (let i = G.smoke.length - 1; i >= 0; i--) {
    const p = G.smoke[i];
    p.t += dt;
    if (p.t > p.life) { G.smoke.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.92; p.vy *= 0.92;
    const k = p.t / p.life;
    ctx.fillStyle = `rgba(130,130,135,${(0.3 * (1 - k)).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + k * 1.8), 0, TAU); ctx.fill();
  }
}

// ==================== exploze / popupy ====================
function drawExplosions(dt) {
  for (const ex of G.explosions) {
    ex.t += dt;
    // ohnivá koule
    if (ex.t < 0.6) {
      const r = 20 + ex.t * 130;
      const grad = ctx.createRadialGradient(ex.x, ex.y, 2, ex.x, ex.y, r);
      grad.addColorStop(0, 'rgba(255,240,180,' + (1 - ex.t / 0.6) + ')');
      grad.addColorStop(0.5, 'rgba(255,120,30,' + 0.8 * (1 - ex.t / 0.6) + ')');
      grad.addColorStop(1, 'rgba(60,20,10,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, TAU); ctx.fill();
    }
    for (const p of ex.parts) {
      p.t += dt;
      if (p.t > p.life) continue;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.96; p.vy *= 0.96;
      const k = 1 - p.t / p.life;
      if (p.kind === 'fire') {
        ctx.fillStyle = `rgba(${255},${(140 * k) | 0},20,${k})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * k, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = `rgba(60,60,60,${0.5 * k})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1.6 - k * 0.6), 0, TAU); ctx.fill();
      }
    }
    // doutnání po výbuchu
    if (ex.t > 0.5) {
      const fl = 6 + Math.sin(ex.t * 22) * 3;
      ctx.fillStyle = 'rgba(255,120,20,0.7)';
      ctx.beginPath(); ctx.arc(ex.x + rnd(-3, 3), ex.y + rnd(-3, 3), fl, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(70,70,70,0.35)';
      ctx.beginPath(); ctx.arc(ex.x + rnd(-6, 6), ex.y - 10 - ex.t * 12, 14 + ex.t * 8, 0, TAU); ctx.fill();
    }
  }
}
function drawPopups(dt) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center';
  for (let i = G.popups.length - 1; i >= 0; i--) {
    const p = G.popups[i];
    p.t += dt;
    const life = p.bad ? 1.8 : 1;
    if (p.t > life) { G.popups.splice(i, 1); continue; }
    const sp = worldToScreen(p.x, p.y);
    ctx.globalAlpha = 1 - p.t / life;
    ctx.font = p.bad ? 'bold 26px Arial' : 'bold 18px Arial';
    ctx.fillStyle = p.bad ? '#ff5540' : '#ffd23a';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
    ctx.strokeText(p.txt, sp.x, sp.y - 20 - p.t * 30);
    ctx.fillText(p.txt, sp.x, sp.y - 20 - p.t * 30);
  }
  ctx.globalAlpha = 1;
}
// odpočty nad misijními vozidly (IZS + MHD)
function drawMissionBadges() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = 'bold 15px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const v of G.vehicles) {
    if (v.missionDone || v.crashed || (!v.emg && !v.mhd)) continue;
    const mission = v.emgM ? G.emgM : v.emg ? G.emg : G.mhd;
    if (!mission) continue;
    const left = Math.max(0, Math.ceil(mission.deadline - G.time));
    const icon = v.emg ? EMG_TYPES[v.emg].icon : MHD_TYPES[v.mhd].icon;
    const txt = `${icon}${v.path.move === 'L' ? '↰' : v.path.move === 'R' ? '↱' : ''} ${left} s`;
    const sp = worldToScreen(v.pose.x, v.pose.y);
    const w = ctx.measureText(txt).width + 14;
    const warn = left <= 10;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    rr(ctx, sp.x - w / 2, sp.y - 42, w, 20, 6); ctx.fill();
    ctx.strokeStyle = warn ? '#ff5540' : v.emg ? '#7fc4ff' : '#ffd23a';
    ctx.lineWidth = 1.5;
    rr(ctx, sp.x - w / 2, sp.y - 42, w, 20, 6); ctx.stroke();
    ctx.fillStyle = warn && Math.floor(G.time * 4) % 2 === 0 ? '#ff5540' : '#fff';
    ctx.fillText(txt, sp.x, sp.y - 31);
  }
  // misijní vozidlo mimo obrazovku: blikající terč se šipkou na okraji
  // (IZS modro-červený, MHD žlutý)
  for (const ev of G.vehicles) {
    if (ev.missionDone || ev.crashed) continue;
    const isEmg = ev.emg && (ev.emgM ? G.emgM : G.emg), isMhd = ev.mhd && G.mhd;
    if (!isEmg && !isMhd) continue;
    const sp = worldToScreen(ev.pose.x, ev.pose.y);
    if (sp.x < -10 || sp.x > cw + 10 || sp.y < -10 || sp.y > ch + 10) {
      const cx2 = cw / 2, cy2 = ch / 2;
      const dx = sp.x - cx2, dy = sp.y - cy2;
      const m = 52;
      const t = Math.min((cx2 - m) / Math.max(1e-9, Math.abs(dx)),
                         (cy2 - m) / Math.max(1e-9, Math.abs(dy)));
      const ax = cx2 + dx * t, ay = cy2 + dy * t;
      const blink = Math.floor(G.time * 6) % 2 === 0;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.beginPath(); ctx.arc(0, 0, 23, 0, TAU);
      ctx.fillStyle = isEmg
        ? (blink ? 'rgba(42,127,255,0.92)' : 'rgba(255,59,48,0.92)')
        : (blink ? 'rgba(255,210,58,0.95)' : 'rgba(210,31,38,0.95)');
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 23, 0, TAU); ctx.stroke();
      ctx.font = '21px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(isEmg ? EMG_TYPES[ev.emg].icon : MHD_TYPES[ev.mhd].icon, 0, 1);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.beginPath(); ctx.moveTo(34, 0); ctx.lineTo(23, -8); ctx.lineTo(23, 8); ctx.closePath();
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.restore();
    }
  }
}

// ==================== HUD ====================
function updateHud() {
  const el = document.getElementById('score');
  el.firstChild.textContent = G.score;
  el.querySelector('small').textContent = G.won ? '🏆 DOHRÁNO' : `bodů z ${WIN_SCORE}`;
}
// semafor průtoku vlevo dole — podle nejdelší aktuální kolony (vzorkuje se à 2 s ve step).
// Limity: zelená ≤ 4 vozidla, žlutá 5–9, červená ≥ 10 (od 10 řidiči troubí = zácpa).
// Hystereze proti blikání na hraně: zpět na lepší stav až při ≤ 3 / ≤ 7.
const FLOW_CAP = { g: 'průtok: plynulý', a: 'průtok: houstne', r: 'průtok: ZÁCPA',
                   p: 'průtok: KOLONA STOJÍ, body dolů!' };
function updateFlowSig() {
  const q = G.curQueue;
  let st = G.flowState || 'g';
  if (st === 'g') st = q >= 10 ? 'r' : q >= 5 ? 'a' : 'g';
  else if (st === 'a') st = q >= 10 ? 'r' : q <= 3 ? 'g' : 'a';
  else st = q <= 3 ? 'g' : q <= 7 ? 'a' : 'r';
  G.flowState = st;
  // fáze pokut za stojící kolonu přebíjí běžné stavy blikající červenou
  const shown = G.starveActive ? 'p' : st;
  const el = document.getElementById('flowSig');
  el.style.display = 'block';
  if (shown !== el.dataset.state) {
    el.dataset.state = shown;
    el.querySelector('.cap').textContent = FLOW_CAP[shown];
  }
}
function updateStats() {
  updateFlowSig();
  const mins = G.time / 60;
  const rate = mins > 0.05 ? (G.passed / mins).toFixed(1) : '–';
  // obtížnost má strop (~13. minuta jsou všechny křivky na maximu) → úroveň nejvýš 9
  const lvl = Math.min(9, 1 + Math.floor(G.time / 90));
  document.getElementById('stats').innerHTML =
    `⏱ ${fmtTime(G.time)} · úroveň ${lvl}${lvl >= 9 ? ' (max)' : ''}<br>` +
    `🚗 ${G.passed} vozidel (${rate}/min)<br>🏆 osobní rekord ${G.best}`;
  const tEl = document.getElementById('toast');
  if (G.toastMsg && G.time < G.toastUntil && !G.over) {
    tEl.style.display = 'block';
    tEl.textContent = G.toastMsg;
  } else tEl.style.display = 'none';
  const banner = document.getElementById('emgBanner');
  if (G.emgM && !G.over) {
    const left = Math.max(0, Math.ceil(G.emgM.deadline - G.time));
    const rem = G.vehicles.filter(o => o.emgM && !o.missionDone && !o.crashed);
    const labs = rem.map(o => `${EMG_TYPES[o.emg].icon} ${SIG_LABEL[o.path.move][o.arm]}`);
    banner.style.display = 'block';
    banner.textContent = `🚨 HROMADNÝ VÝJEZD IZS na výjezd ${G.emgM.exit + 1} `
      + `(${STREETS[G.emgM.exit]})! Trasy se kříží — uvolňujte postupně: `
      + `${labs.join(' · ')} ⏱ ${left} s`;
  } else if (G.emg && !G.over) {
    const d = EMG_TYPES[G.emg.kind];
    const left = Math.max(0, Math.ceil(G.emg.deadline - G.time));
    banner.style.display = 'block';
    const dir = G.emg.move === 'L'
      ? `odbočuje vlevo — uvolněte ${SIG_LABEL.L[G.emg.arm]}`
      : G.emg.move === 'R'
      ? `odbočuje vpravo bypassem — uvolněte ${SIG_LABEL.R[G.emg.arm]}`
      : `jede přímo — uvolněte ${SIG_LABEL.T[G.emg.arm]}`;
    banner.textContent = `${d.icon} ${d.name} ze směru ${G.emg.arm + 1} (${STREETS[G.emg.arm]}) ${dir}! ⏱ ${left} s`;
  } else banner.style.display = 'none';
}

// ==================== vstup ====================
// jednotné ovládání myší i dotykem: klepnutí = semafor, tažení = posun,
// dva prsty = pinch zoom, pravé/prostřední tlačítko = posun
const pointers = new Map();
let tapCand = null, pinchPrev = null;
function panBy(dx, dy) {
  const c = Math.cos(-ROT), s = Math.sin(-ROT);
  cam.x -= (dx * c - dy * s) / camScale();
  cam.y -= (dx * s + dy * c) / camScale();
  clampCam();
}
function tryToggleAt(sx, sy, touch) {
  let best = null, bestD = 1e9;
  for (let k = 0; k < 4; k++) {
    for (const key of SIG_KEYS) {
      const pos = armXform(k, SIG_POS[key].x, SIG_POS[key].y);
      const sp = worldToScreen(pos.x, pos.y);
      const d = Math.hypot(sp.x - sx, sp.y - sy);
      if (d < bestD) { bestD = d; best = [k, key]; }
    }
  }
  const rad = Math.max(30, 42 * camScale()) * (touch ? 1.7 : 1);
  if (best && bestD < rad) signalToggle(G.signals[best[0]][best[1]]);
}
canvas.addEventListener('pointerdown', e => {
  AudioFX.init();
  if (G.replay) { endReplay(); return; }            // klepnutí přeskočí záznam
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinchPrev = null;
  if (pointers.size === 1) {
    tapCand = (e.button === 0)
      ? { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false,
          touch: e.pointerType === 'touch', pan: e.button !== 0 }
      : { id: e.pointerId, x: e.clientX, y: e.clientY, moved: true, pan: true };
  } else tapCand = null;                            // druhý prst ruší tap
});
canvas.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size >= 2) {
    // pinch zoom kolem středu prstů
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (pinchPrev) {
      const rect = canvas.getBoundingClientRect();
      const mx = mid.x - rect.left, my = mid.y - rect.top;
      const before = screenToWorld(mx, my);
      cam.z = clamp(cam.z * (dist / pinchPrev.dist), 1, 3.2);
      const after = screenToWorld(mx, my);
      cam.x += before.x - after.x; cam.y += before.y - after.y;
      panBy(mid.x - pinchPrev.x, mid.y - pinchPrev.y);
      clampCam();
    }
    pinchPrev = { dist, x: mid.x, y: mid.y };
    return;
  }
  if (tapCand && tapCand.id === e.pointerId) {
    const dx = e.clientX - tapCand.x, dy = e.clientY - tapCand.y;
    if (tapCand.moved || Math.hypot(dx, dy) > 12) {
      if (!tapCand.moved && !tapCand.pan) { tapCand.moved = true; tapCand.px = tapCand.x; tapCand.py = tapCand.y; }
      tapCand.moved = true;
      panBy(e.clientX - (tapCand.px == null ? tapCand.x : tapCand.px),
            e.clientY - (tapCand.py == null ? tapCand.y : tapCand.py));
      tapCand.px = e.clientX; tapCand.py = e.clientY;
    }
  }
});
canvas.addEventListener('pointerup', e => {
  const t = tapCand;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchPrev = null;
  if (t && t.id === e.pointerId) {
    tapCand = null;
    if (!t.moved && !t.pan && G.running && !G.over) {
      const rect = canvas.getBoundingClientRect();
      tryToggleAt(e.clientX - rect.left, e.clientY - rect.top, t.touch);
    }
  }
});
canvas.addEventListener('pointercancel', e => {
  pointers.delete(e.pointerId);
  if (tapCand && tapCand.id === e.pointerId) tapCand = null;
  if (pointers.size < 2) pinchPrev = null;
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const before = screenToWorld(mx, my);
  cam.z = clamp(cam.z * Math.exp(-e.deltaY * 0.0013), 1, 3.2);
  const after = screenToWorld(mx, my);
  cam.x += before.x - after.x; cam.y += before.y - after.y;
  clampCam();
}, { passive: false });
window.addEventListener('keydown', e => {
  if (document.getElementById('lbFull').style.display === 'flex') {
    if (e.key === 'Escape' || e.key === 'Enter') closeLbFull();
    return;   // při otevřeném žebříčku klávesy neovládají hru
  }
  const km = KEYMAP[e.key.toLowerCase()];
  if (km) {
    AudioFX.init();
    if (G.running && !G.over) signalToggle(G.signals[km[0]][km[1]]);
  } else if (e.key === 'p' || e.key === 'P') {
    togglePause();
  } else if (e.key === 'm' || e.key === 'M') {
    toggleMusic();
  } else if (e.key === '0') {
    cam.x = 0; cam.y = 0; cam.z = 1;                // reset pohledu
  } else if (e.key === ' ' && G.replay) {
    endReplay();
  } else if (e.key === 'Enter') {
    if (G.replay) { endReplay(); return; }
    const goShown = document.getElementById('gameover').style.display === 'flex';
    if ((G.over || G.won) && goShown) resetGame();
    else if (!G.running) startGame();
  }
});
// pokračování po dohrání — hra jede dál, skóre už se nemění
function continueGame() {
  document.getElementById('gameover').style.display = 'none';
  G.running = true;
}
// ==================== sdílení ====================
const SHARE_URL = 'https://izovan.cz/mileta/';
function shareText() {
  if (G.won) return `Křižovatka Mileta DOHRÁNA 🏆 1000 bodů za ${fmtTime(G.winTime)}. Zvládnete službu rychleji?`;
  if (G.over) return `Řízení semaforů na křižovatce Mileta: ${G.score} bodů za ${fmtTime(G.time)} 🚦 Zvládnete to lépe?`;
  return 'Zvládnete řídit semafory na skutečné křižovatce Mileta v Hradci Králové? 🚦';
}
document.querySelectorAll('.shareBtn').forEach(b => {
  const kind = b.dataset.share;
  if (kind === 'native' && navigator.share) b.style.display = 'flex';
  b.addEventListener('click', async () => {
    const text = shareText(), url = SHARE_URL;
    if (kind === 'native') {
      try { await navigator.share({ title: 'KŘIŽOVATKA MILETA', text, url }); } catch (e) {}
    } else if (kind === 'fb') {
      window.open('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url) +
                  '&quote=' + encodeURIComponent(text), '_blank', 'noopener');
    } else if (kind === 'x') {
      window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) +
                  '&url=' + encodeURIComponent(url), '_blank', 'noopener');
    } else if (kind === 'wa') {
      window.open('https://wa.me/?text=' + encodeURIComponent(text + ' ' + url), '_blank', 'noopener');
    } else if (kind === 'copy') {
      const ok = b.parentElement.querySelector('.shareOk');
      try {
        await navigator.clipboard.writeText(text + ' ' + url);
        ok.textContent = 'Odkaz zkopírován ✔';
      } catch (e) { ok.textContent = url; }
      ok.classList.remove('show'); void ok.offsetWidth; ok.classList.add('show');
    }
    b.blur();                                 // ať Enter po kliknutí nerestartuje hru
  });
});
// klik kamkoli do TOP 10 panelu = rovnou úplný žebříček (tooltip jen na hover)
document.getElementById('lbLive').addEventListener('click', () => { lbTipHide(); openLbFull(); });
document.getElementById('btnStart').addEventListener('click', startGame);
document.getElementById('btnRestart').addEventListener('click', resetGame);
document.getElementById('btnCont').addEventListener('click', continueGame);
document.getElementById('btnPause').addEventListener('click', togglePause);
document.getElementById('btnSaveScore').addEventListener('click', saveScore);
document.getElementById('playerName').addEventListener('keydown', e => {
  e.stopPropagation();                      // ať psaní jména nepřepíná semafory
  if (e.key === 'Enter') saveScore();
});
function togglePause() {
  if (!G.running || G.over) return;
  G.paused = !G.paused;
  document.getElementById('pauseOv').style.display = G.paused ? 'flex' : 'none';
  document.getElementById('btnPause').textContent = G.paused ? '▶' : '⏸';
  if (AudioFX.ctx) { G.paused ? AudioFX.ctx.suspend() : AudioFX.ctx.resume(); }
  if (AudioFX.audioEl && AudioFX.audioEl !== 'failed' && typeof AudioFX.audioEl.pause === 'function') {
    if (G.paused) AudioFX.audioEl.pause();
    else if (AudioFX.musicOn) { const pr = AudioFX.audioEl.play(); if (pr && pr.catch) pr.catch(() => {}); }
  }
}
function startGame() {
  AudioFX.init();
  AudioFX.musicOn = localStorage.getItem('mileta-music') !== '0';
  AudioFX.musicStart();
  document.getElementById('btnMusic').style.opacity = AudioFX.musicOn ? 1 : 0.4;
  document.getElementById('intro').style.display = 'none';
  resetGame();
}
function toggleMusic() {
  AudioFX.musicOn = !AudioFX.musicOn;
  localStorage.setItem('mileta-music', AudioFX.musicOn ? '1' : '0');
  if (AudioFX.musicOn) { AudioFX.init(); AudioFX.musicStart(); } else AudioFX.musicStop();
  document.getElementById('btnMusic').style.opacity = AudioFX.musicOn ? 1 : 0.4;
}
document.getElementById('btnMusic').addEventListener('click', toggleMusic);
window.__game = G;   // ladicí přístup ke stavu hry

// ==================== hlavní smyčka ====================
// ladicí autostart: ?autostart nebo ?autostart=13 (zelená rovně+vlevo na ramenech 1 a 3)
if (/[?&]autostart/.test(location.search)) {
  const m = location.search.match(/autostart=(\d+)/);
  startGame();
  // jen přímé směry — vlevo + protilehlý přímý by se podle pravidel srazily
  if (m) for (const ch of m[1]) signalToggle(G.signals[+ch - 1].T);
}

// dekorativní chodci u podchodů (inicializace jednou)
const PEDS = [];
for (let k = 0; k < 4; k++) {
  for (let i = 0; i < 3; i++) {
    PEDS.push({ k, t: Math.random(), dir: Math.random() < 0.5 ? 1 : -1,
                speed: rnd(0.025, 0.05), off: rnd(-5, 5),
                color: pick(['#c9b394', '#7a8ba6', '#a67a7a', '#6f8f6f', '#b8a05a']) });
  }
}
function pedPos(p) {
  // kvadratická křivka rohového chodníku (-160,-260) -> ctrl (-250,-250) -> (-260,-160)
  const t = p.t, u = 1 - t;
  const x = u * u * -160 + 2 * u * t * -250 + t * t * -260 + p.off;
  const y = u * u * -260 + 2 * u * t * -250 + t * t * -160 + p.off;
  return armXform(p.k, x, y);
}
function updatePeds(dt) {
  for (const p of PEDS) {
    p.t += p.dir * p.speed * dt;
    if (p.t > 1.08 || p.t < -0.08) {         // „zmizel v podchodu" → nový chodec
      p.dir *= -1;
      p.t = clamp(p.t, -0.08, 1.08);
      p.speed = rnd(0.025, 0.05); p.off = rnd(-5, 5);
    }
  }
}

function step(dt, rawDt) {
  if (!G.running || G.paused) return;
  updatePeds(dt);
  if (G.replay) return;                       // během záznamu nehody svět stojí
  if (!G.over) {
    G.time += dt;
    updateSpawning(dt);
    updateMissions();
    for (const g of G.signals) for (const key of SIG_KEYS) signalUpdate(g[key], dt);
    // počasí: den / déšť — změna vyčká na klid mezi misemi
    if (G.time > G.nextWeatherAt) {
      if (missionBusy()) G.nextWeatherAt = G.time + rnd(4, 8);
      else {
        const next = G.weather === 'den' ? 'déšť' : 'den';
        G.weather = next;
        G.grip = next === 'déšť' ? 0.72 : 1;
        G.nextWeatherAt = G.time + (next === 'den' ? rnd(100, 150) : rnd(60, 95));
        toast(next === 'déšť' ? '🌧️ Začíná pršet — pozor, delší brzdná dráha!' : '☀️ Vyjasnilo se.');
      }
    }
    // statistika nejdelší kolony (vzorkování à ~2 s)
    if ((G.time * 30 | 0) % 60 === 0) {
      const qs = new Map();
      for (const v of G.vehicles) {
        if (v.v < 2) {
          const key = v.path.laneGroup || v.path;
          qs.set(key, (qs.get(key) || 0) + 1);
        }
      }
      let cq = 0;
      for (const n of qs.values()) {
        if (n > cq) cq = n;
        if (n > G.stats.maxQueue) G.stats.maxQueue = n;
      }
      G.curQueue = cq;
    }
  }
  for (const v of G.vehicles) updateVehicle(v, dt);
  if (!G.over) checkCollisions();
  // úklid dojetých
  for (let i = G.vehicles.length - 1; i >= 0; i--) {
    const v = G.vehicles[i];
    if (v.s > v.path.total - 8) {
      G.stats.waitSum += v.waitTotal || 0;
      G.stats.waitCnt++;
      G.vehicles.splice(i, 1);
    }
  }
  G.shake = Math.max(0, G.shake - rawDt * 30);
  if (G.over) G.slowmo = Math.min(1, G.slowmo + rawDt * 0.5);
  // záznam posledních ~8 s pro replay nehody (včetně okamžiku nárazu)
  if (dt > 0) {
    G.hist.push(G.vehicles.map(v => [v, v.s]));
    if (G.hist.length > 480) {
      G.hist.shift();
      if (G.crashHistIdx != null) G.crashHistIdx--;
    }
  }
}

// ladicí rychloposuv: ?ff=15 odsimuluje 15 s před prvním vykreslením
{
  const m = location.search.match(/[?&]ff=(\d+)/);
  if (m) for (let i = 0; i < +m[1] * 60; i++) step(1 / 60, 1 / 60);
}

// chodci (kreslí se ve světových souřadnicích, pod HUD vrstvami)
function drawPeds() {
  for (const p of PEDS) {
    if (p.t < 0 || p.t > 1) continue;        // „v podchodu"
    const w = pedPos(p);
    ctx.beginPath(); ctx.arc(w.x + 1, w.y + 1.5, 3, 0, TAU);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(w.x, w.y, 2.6, 0, TAU);
    ctx.fillStyle = p.color; ctx.fill();
  }
}

// noc a déšť — overlay v rovině obrazovky + světlomety ve světě
let rainSeed = 0;
function drawWeather(rawDt) {
  if (G.weather === 'déšť') {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(30,40,55,0.18)';
    ctx.fillRect(0, 0, cw, ch);
    // šikmé kapky
    rainSeed += rawDt * 900;
    ctx.strokeStyle = 'rgba(200,215,235,0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < 110; i++) {
      const x = ((i * 137 + rainSeed * 0.6) % (cw + 60)) - 30;
      const y = ((i * 71 + rainSeed) % (ch + 40)) - 20;
      ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 13);
    }
    ctx.stroke();
  }
}

let lastT = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.05, (ts - lastT) / 1000 || 0);
  lastT = ts;
  const dt = G.paused ? 0 : rawDt * G.slowmo;
  step(dt, rawDt);

  // ---- render
  const shx = G.shake > 0 ? rnd(-G.shake, G.shake) : 0;
  const shy = G.shake > 0 ? rnd(-G.shake, G.shake) : 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#2c4a26';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  worldTransform(shx, shy);
  ctx.drawImage(bg, -BG_HALF, -BG_HALF);
  drawPeds();
  if (G.running && G.replay) {
    // přehrávání záznamu nehody (poloviční rychlost)
    const last = G.replay.frames.length - 1;
    const fi = Math.min(Math.floor(G.replay.idx), last);
    const fr = G.replay.frames[fi];
    if (!fr) { endReplay(); }
    else {
      for (const [v, s] of fr) {
        v.crashed = false;
        v.s = s;
        v.pose = pathPose(v.path, s);
      }
      drawSignalGlows();
      for (const [v] of fr) drawVehicle(v);
      // v okamžiku nárazu ukázat výbuch
      if (G.crashHistIdx != null && G.replay.idx >= G.crashHistIdx - 1 && G.crashPos) {
        const tt = clamp((G.replay.idx - G.crashHistIdx + 1) / 25, 0, 1);
        const rr2 = 16 + tt * 95;
        const grad = ctx.createRadialGradient(G.crashPos.x, G.crashPos.y, 2, G.crashPos.x, G.crashPos.y, rr2);
        grad.addColorStop(0, `rgba(255,240,180,${0.95 * (1 - tt * 0.55)})`);
        grad.addColorStop(0.5, `rgba(255,120,30,${0.75 * (1 - tt * 0.55)})`);
        grad.addColorStop(1, 'rgba(60,20,10,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(G.crashPos.x, G.crashPos.y, rr2, 0, TAU); ctx.fill();
      }
      drawSignals();
      if (!G.paused) {
        if (G.replay.idx < last) G.replay.idx += 0.6;
        else {
          G.replay.hold = (G.replay.hold || 0) + 1;   // podrž náraz ~1,2 s
          if (G.replay.hold > 90) endReplay();
        }
      }
    }
  } else if (G.running) {
    drawSignalGlows();
    drawSmoke(dt);
    for (const v of G.vehicles) drawVehicle(v);
    drawExplosions(dt);
    drawSignals();
    drawSignalLabels();
    drawMissionBadges();
    drawPopups(rawDt);
  } else {
    // demo pozadí pod intrem – jen semafory
    drawSignalGlows();
    drawSignals();
  }
  drawWeather(rawDt);
  if (G.running) updateStats();
}
requestAnimationFrame(frame);
