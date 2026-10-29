// Sound of the river, all synthesised with the Web Audio API (no samples):
// * the paddlers' chant: a soloist calls on strokes 1–2, the crew answers on 3–4, a deep
//   ngoma drum on every catch (blade in the water) and a quiet likembe (thumb piano)
//   ostinato between them. It keeps the stroke rhythm, so it can drive a rhythm game:
//   beat() / judge() tell where the boat is in the stroke cycle.
// * the lokolé, the slit drum the riverside villages talk with: two wooden tongues,
//   high and low, heard across the water with a little echo;
// * ambience beds (water, forest, city, rain, wind, night) with random birds, frogs, horns;
//   thunder; the drone of an outboard.
// Voices are formant synthesis: sawtooth sources with vibrato through three band-pass
// filters at the vowel's formants. Events are scheduled ahead of time by a lookahead
// scheduler (pump), so the rhythm stays tight whatever the frame rate.

const LOOKAHEAD = 0.15, TICK = 25;
const PENTA = [0, 2, 4, 7, 9];
// formants (Hz) and their relative levels
const VOWEL = {
  a: [[730, 1], [1090, 0.5], [2440, 0.22]],
  e: [[480, 1], [1900, 0.42], [2550, 0.2]],
  i: [[290, 1], [2250, 0.3], [3000, 0.15]],
  o: [[540, 1], [860, 0.55], [2400, 0.15]],
  u: [[320, 1], [800, 0.4], [2250, 0.1]],
  m: [[250, 1], [1000, 0.08], [2200, 0.03]],
};
// call-and-response phrases over 4 strokes: [beat, length in beats, pentatonic degree, syllable];
// the call sits on beats 0–2 (soloist), the response on beats 2–4 (chorus)
const PHRASES = [
  { call: [[0, 0.5, 7, 'é'], [0.5, 1.4, 5, 'ya']], resp: [[2, 0.5, 5, 'o'], [2.5, 1.4, 3, 'hé']] },
  { call: [[0, 0.75, 8, 'ya'], [0.75, 0.45, 7, 'mbo'], [1.25, 0.7, 5, 'yé']], resp: [[2, 0.6, 5, 'ya'], [2.6, 0.5, 4, 'mbo'], [3.1, 0.8, 2, 'é']] },
  { call: [[0, 1, 9, 'hé'], [1, 0.9, 7, 'é']], resp: [[2, 0.45, 7, 'o'], [2.45, 0.45, 5, 'hé'], [2.9, 1, 5, 'é']] },
  { call: [[0, 0.5, 5, 'é'], [0.5, 0.5, 7, 'ya'], [1, 0.9, 8, 'o']], resp: [[2, 0.5, 7, 'o'], [2.5, 0.5, 5, 'ya'], [3, 0.9, 2, 'mbo']] },
  { call: [[0, 0.4, 10, 'ha'], [0.4, 0.4, 9, 'yé'], [0.8, 1.1, 7, 'é']], resp: [[2, 0.9, 5, 'yo'], [2.9, 1, 4, 'hé']] },
];
// likembe ostinato: two plucks per stroke, on the off-beats
const LIKEMBE = [[10, 12], [12, 10], [11, 13], [10, 9], [12, 14], [13, 12]];
// chorus: octave, detune (cents), side
const CHORUS = [[0, -9, -1], [0, 7, 1], [1, -5, -1], [1, 6, 1], [-1, 3, 1], [1, 11, -1]];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function rng(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function parseSyllable(s) {
  const m = /^(mb|y|h)?(.)$/.exec(s.normalize('NFD').replace(/[̀-ͯ]/g, '')) ?? [];
  return { on: m[1] ?? '', v: VOWEL[m[2]] ? m[2] : 'a' };
}

export class RiverAudio {
  // opts.context: an (Offline)AudioContext to use instead of creating one (tests)
  constructor(opts = {}) {
    this.ctx = null;
    this.injected = opts.context ?? null;
    this.onBeat = null;
    this.st = { master: 0.8, amb: { water: 0, forest: 0, city: 0, rain: 0, wind: 0, night: 0 }, chantLevel: 0.6, engine: { on: false, load: 0.5 } };
    this.chant = null;
    this.beats = [];
    this.timeouts = new Set();
    this.rand = rng(99);
  }

  resume() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!this.injected && !AC) return Promise.resolve();
      this.ctx = this.injected ?? new AC({ latencyHint: 'interactive' });
      this.offline = typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext;
      this.build();
      if (!this.offline) this.timer = setInterval(() => this.pump(this.ctx.currentTime + LOOKAHEAD), TICK);
    }
    if (this.offline || this.ctx.state === 'running') return Promise.resolve();
    return this.ctx.resume().catch(() => {});
  }

  get ready() { return !!this.ctx && (this.offline || this.ctx.state === 'running'); }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }
  // seconds between scheduling a sound and hearing it
  get latency() { return this.ctx && !this.offline ? (this.ctx.outputLatency || this.ctx.baseLatency || 0) : 0; }

  setMaster(v) {
    this.st.master = clamp(v, 0, 1);
    if (this.ctx) this.master.gain.setTargetAtTime(this.st.master, this.ctx.currentTime, 0.1);
  }

  setAmbience(levels) {
    for (const k of Object.keys(this.st.amb)) if (levels[k] != null) this.st.amb[k] = clamp(levels[k], 0, 1);
    if (this.ctx) this.applyAmbience(0.8);
  }

  // --- the chant ------------------------------------------------------------------------------
  startChant({ bpm = 48, seed = 1 } = {}) {
    const r = rng(seed * 7919 + 1);
    this.chant = { bpm: clamp(bpm, 30, 80), pending: null, index: 0, next: 0, rand: r, phrase: null, root: 146.83 * 2 ** ([-2, 0, 2, 3][Math.floor(r() * 4)] / 12) };
    this.beats = [];
  }

  setTempo(bpm) { if (this.chant) this.chant.pending = clamp(bpm, 30, 80); }

  stopChant() {
    this.chant = null;
    this.beats = [];
    for (const id of this.timeouts) clearTimeout(id);
    this.timeouts.clear();
  }

  setChantLevel(v) {
    this.st.chantLevel = clamp(v, 0, 1);
    if (this.ctx) this.chantBus.gain.setTargetAtTime(0.55 + 0.45 * this.st.chantLevel, this.ctx.currentTime, 0.3);
  }

  // where we are in the stroke cycle, as heard (phase 0 = the catch, on the drum)
  beat() {
    const period = this.chant ? 60 / this.chant.bpm : 1;
    if (!this.ctx || !this.beats.length) return { phase: 0, next: 0, period, index: 0 };
    const now = this.ctx.currentTime - this.latency;
    let k = -1;
    for (let i = 0; i < this.beats.length; i++) if (this.beats[i].t <= now) k = i;
    if (k < 0) return { phase: 0, next: this.beats[0].t, period: this.beats[0].p, index: this.beats[0].i };
    const b = this.beats[k], next = this.beats[k + 1]?.t ?? b.t + b.p;
    return { phase: clamp((now - b.t) / (next - b.t), 0, 0.9999), next, period: next - b.t, index: b.i };
  }

  // grade a stroke made now against the nearest catch: { quality, offset (s, < 0 early) }
  judge() {
    if (!this.ctx || !this.beats.length) return { quality: 'miss', offset: 0 };
    const now = this.ctx.currentTime - this.latency;
    let best = null;
    for (const b of this.beats) if (!best || Math.abs(now - b.t) < Math.abs(now - best.t)) best = b;
    const off = now - best.t, a = Math.abs(off);
    return { quality: a < Math.min(0.09, best.p * 0.11) ? 'perfect' : a < Math.min(0.2, best.p * 0.24) ? 'good' : 'miss', offset: off };
  }

  // the player's own stroke
  stroke(quality = 'good') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.005;
    if (quality === 'miss') {
      this.noise(t, 0.25, { type: 'lowpass', f: 380, q: 0.7 }, 0.35, 0.004, 0.07, this.sfx);
      return;
    }
    this.splash(t, quality === 'perfect' ? 0.55 : 0.4);
    if (quality === 'perfect') {
      // a bright wooden accent and a likembe note on top
      this.tone(t, 'triangle', 1180, 0.12, 0.0015, 0.05, this.sfx, 0.94);
      if (this.chant) this.pluck(t + 0.01, this.chant.root * 2 ** ((PENTA[2] + 24) / 12), 0.12);
    }
  }

  // --- the lokolé -------------------------------------------------------------------------------
  lokole(pattern, { pan = 0, gain = 1, rate = 1 } = {}) {
    const step = 0.16 / rate;
    let dur = 0;
    for (const ch of pattern) dur += ch === '-' ? 0.45 / rate : step;
    if (!this.ctx) return dur;
    const c = this.ctx, out = c.createStereoPanner();
    out.pan.value = clamp(pan, -1, 1);
    out.connect(this.lokoleBus);
    let t = c.currentTime + 0.03;
    const hi = 330 * (0.97 + this.rand() * 0.06), lo = 220 * (0.97 + this.rand() * 0.06);
    for (const ch of pattern) {
      if (ch === 'H' || ch === 'L') {
        const f = ch === 'H' ? hi : lo, g = gain * (0.85 + this.rand() * 0.25);
        // damped body mode with a slight pitch drop, a second mode, a knock of resonant noise
        this.tone(t, 'sine', f, 0.5 * g, 0.002, 0.11, out, 0.94, 1.05);
        this.tone(t, 'sine', f * 2.31, 0.12 * g, 0.002, 0.035, out);
        this.noise(t, 0.08, { type: 'bandpass', f, q: 18 }, 0.9 * g, 0.001, 0.03, out);
        this.noise(t, 0.03, { type: 'bandpass', f: 1800, q: 1.2 }, 0.08 * g, 0.001, 0.008, out);
      }
      t += ch === '-' ? 0.45 / rate : step;
    }
    setTimeout(() => out.disconnect(), (dur + 2) * 1000);
    return dur;
  }

  // --- weather and engine -----------------------------------------------------------------------
  thunder(distance = 0.5) {
    if (!this.ctx) return;
    const c = this.ctx, d = clamp(distance, 0, 1), t0 = c.currentTime + 0.05 + d * 1.5;
    if (d < 0.6) {
      const g = (0.6 - d) * 1.2;
      for (let k = 0; k < 4; k++) this.noise(t0 + k * (0.03 + this.rand() * 0.09), 0.5, { type: 'highpass', f: 1400, q: 0.5 }, g * (1 - k * 0.2), 0.003, 0.1, this.sfx);
    }
    // the rumble: slowed noise, low-passed, swelling irregularly
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.35;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320 - d * 210;
    const env = c.createGain();
    const len = 3 + d * 3 + this.rand() * 2, peak = 0.9 - 0.5 * d;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + 0.3 + d * 0.8);
    for (let x = 0.6 + d; x < len; x += 0.25 + this.rand() * 0.3) env.gain.linearRampToValueAtTime(peak * (0.35 + this.rand() * 0.65) * (1 - x / len * 0.6), t0 + x);
    env.gain.setTargetAtTime(0, t0 + len, 1.1);
    src.connect(lp).connect(env).connect(this.sfx);
    src.start(t0, this.rand() * 1.5);
    src.stop(t0 + len + 6);
    src.onended = () => { src.disconnect(); lp.disconnect(); env.disconnect(); };
  }

  engine(on, load = 0.5) {
    this.st.engine = { on: !!on, load: clamp(load, 0, 1) };
    if (!this.ctx) return;
    const c = this.ctx, e = this.eng ?? (this.eng = this.buildEngine()), l = this.st.engine.load, t = c.currentTime;
    const f = 34 + l * 38;
    e.o1.frequency.setTargetAtTime(f, t, 0.25);
    e.o2.frequency.setTargetAtTime(f * 2.02, t, 0.25);
    e.lp.frequency.setTargetAtTime(600 + l * 900, t, 0.25);
    e.out.gain.setTargetAtTime(on ? 0.05 + 0.07 * l : 0, t, on ? 0.3 : 0.5);
  }

  dispose() {
    this.stopChant();
    clearInterval(this.timer);
    if (this.ctx && !this.offline && !this.injected) this.ctx.close();
    this.ctx = null;
  }

  // --- graph ------------------------------------------------------------------------------------
  build() {
    const c = this.ctx;
    // one shared buffer of white noise
    this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 3.5; comp.attack.value = 0.005; comp.release.value = 0.25;
    this.master = c.createGain();
    this.master.gain.value = this.st.master;
    const out = c.createGain();
    out.gain.value = 0.9;
    this.master.connect(comp).connect(out).connect(c.destination);
    // chant voices through a gentle low-pass, so they never get shrill
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3600; lp.Q.value = 0.5;
    this.chantBus = c.createGain();
    this.chantBus.gain.value = 0.55 + 0.45 * this.st.chantLevel;
    this.chantBus.connect(lp).connect(this.master);
    this.sfx = c.createGain();
    this.sfx.connect(this.master);
    // the lokolé heard across the water: a little dulled, a short echo off the far bank
    this.lokoleBus = c.createGain();
    const dull = c.createBiquadFilter();
    dull.type = 'lowpass'; dull.frequency.value = 2600;
    const echo = c.createDelay(1), fb = c.createGain(), elp = c.createBiquadFilter();
    echo.delayTime.value = 0.19; fb.gain.value = 0.32; elp.type = 'lowpass'; elp.frequency.value = 1500;
    this.lokoleBus.connect(dull).connect(this.master);
    dull.connect(echo).connect(elp).connect(fb).connect(echo);
    elp.connect(this.master);

    this.buildAmbience();
    this.applyAmbience(0.05);
    const ev = c.currentTime;
    this.ev = { bird: ev + 1, frog: ev + 2, horn: ev + 3, gust: ev + 1 };
    if (this.st.engine.on) this.engine(true, this.st.engine.load);
  }

  buildAmbience() {
    const c = this.ctx;
    this.amb = {};
    const bed = (k, scale) => { const g = c.createGain(); g.gain.value = 0; g.connect(this.master); this.amb[k] = { g, scale }; return g; };
    const loop = (rate = 1, buf = this.noiseBuf) => { const s = c.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(0, Math.random() * 1.9); return s; };
    const filt = (type, f, q = 0.7) => { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    // a gain whose level is wobbled by an LFO: base ± depth
    const wobble = (base, hz, depth, type = 'sine') => {
      const g = c.createGain(); g.gain.value = base;
      const o = c.createOscillator(); o.type = type; o.frequency.value = hz;
      const d = c.createGain(); d.gain.value = depth;
      o.connect(d).connect(g.gain); o.start();
      return g;
    };
    // water lapping at the hull
    {
      const a = wobble(0.5, 0.31, 0.22), b = wobble(1, 0.53, 0.25);
      loop().connect(filt('lowpass', 650)).connect(filt('peaking', 260, 1)).connect(a).connect(b).connect(bed('water', 0.55));
    }
    // forest: a band of cicadas, swelling slowly (birds are scheduled in pump)
    {
      const am = wobble(0.5, 41, 0.5), swell = wobble(0.5, 0.07, 0.45);
      loop().connect(filt('bandpass', 5200, 6)).connect(am).connect(swell).connect(bed('forest', 0.35));
      this.birdBus = bed('birds', 0.5);
    }
    // the city: low traffic rumble (horns in pump)
    {
      loop(0.6).connect(filt('lowpass', 230)).connect(bed('city', 0.6));
      this.hornBus = bed('horns', 1);
    }
    // rain: bright hiss and a loop of drops
    {
      const drops = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), dd = drops.getChannelData(0), r = rng(5);
      for (let n = 0; n < 420; n++) {
        const at = Math.floor(r() * (dd.length - 2000)), f = 2000 + r() * 4000, a = 0.2 + r() * 0.8, len = 300 + Math.floor(r() * 500);
        for (let i = 0; i < len; i++) dd[at + i] += Math.sin((i / c.sampleRate) * f * 6.283) * a * Math.exp(-i / (len / 5));
      }
      const rb = bed('rain', 1);
      loop().connect(filt('highpass', 2400)).connect(this.gainNode(0.16)).connect(rb);
      loop(1, drops).connect(this.gainNode(0.22)).connect(rb);
    }
    // wind: band-passed noise, gusty
    {
      const gust = wobble(0.55, 0.09, 0.35), f = filt('bandpass', 380, 0.9);
      const fo = c.createOscillator(); fo.frequency.value = 0.05; const fd = c.createGain(); fd.gain.value = 140; fo.connect(fd).connect(f.frequency); fo.start();
      this.gust = gust;
      loop().connect(f).connect(gust).connect(bed('wind', 0.7));
    }
    // night: crickets (a tone pulsed fast, gated slowly); frogs in pump
    {
      const o = c.createOscillator(); o.frequency.value = 4300; o.start();
      const p = wobble(0.5, 23, 0.5, 'square'), g = wobble(0.5, 0.85, 0.5, 'square');
      o.connect(p).connect(g).connect(bed('night', 0.05));
      this.frogBus = bed('frogs', 1);
    }
  }

  applyAmbience(tau) {
    const a = this.st.amb, t = this.ctx.currentTime;
    const set = (k, v) => this.amb[k].g.gain.setTargetAtTime(v * this.amb[k].scale, t, tau);
    for (const k of ['water', 'forest', 'city', 'rain', 'wind', 'night']) set(k, a[k]);
    set('birds', a.forest); set('horns', a.city); set('frogs', a.night);
  }

  buildEngine() {
    const c = this.ctx;
    const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 50;
    const o2 = c.createOscillator(); o2.type = 'square'; o2.frequency.value = 101;
    const mix = c.createGain(); mix.gain.value = 0.5;
    const o2g = c.createGain(); o2g.gain.value = 0.3;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const am = c.createGain(); am.gain.value = 0.8;
    const lfo = c.createOscillator(); lfo.frequency.value = 9; const ld = c.createGain(); ld.gain.value = 0.2; lfo.connect(ld).connect(am.gain);
    const hiss = c.createBufferSource(); hiss.buffer = this.noiseBuf; hiss.loop = true;
    const hb = c.createBiquadFilter(); hb.type = 'bandpass'; hb.frequency.value = 1200; const hg = c.createGain(); hg.gain.value = 0.12;
    const out = c.createGain(); out.gain.value = 0;
    o1.connect(mix); o2.connect(o2g).connect(mix); hiss.connect(hb).connect(hg).connect(mix);
    mix.connect(lp).connect(am).connect(out).connect(this.sfx);
    o1.start(); o2.start(); lfo.start(); hiss.start();
    return { o1, o2, lp, out };
  }

  // --- scheduler --------------------------------------------------------------------------------
  // schedule everything due before `horizon` (ctx time)
  pump(horizon) {
    const c = this.ctx;
    if (!c) return;
    const now = c.currentTime;
    const ch = this.chant;
    if (ch) {
      if (!ch.next || ch.next < now - 0.2) ch.next = now + 0.08;     // started, or the tab was asleep
      while (ch.next < horizon) {
        if (ch.pending) { ch.bpm = ch.pending; ch.pending = null; }
        const p = 60 / ch.bpm;
        this.scheduleBeat(ch, ch.index, ch.next, p);
        this.beats.push({ t: ch.next, p, i: ch.index });
        if (this.beats.length > 8) this.beats.shift();
        if (this.onBeat && !this.offline) {
          const i = ch.index, t = ch.next;
          const id = setTimeout(() => { this.timeouts.delete(id); this.onBeat?.(i, t); }, Math.max(0, (t - now + this.latency) * 1000));
          this.timeouts.add(id);
        }
        ch.next += p;
        ch.index++;
      }
    }
    // random life in the ambience
    const a = this.st.amb, r = this.rand, ev = this.ev;
    for (const k of Object.keys(ev)) if (ev[k] < now - 1) ev[k] = now + r();
    while (ev.bird < horizon) { if (a.forest > 0.05 && r() < 0.4 + a.forest * 0.6) this.bird(ev.bird); ev.bird += 1.2 + r() * 4.5; }
    while (ev.frog < horizon) { if (a.night > 0.05 && r() < 0.3 + a.night * 0.7) this.frog(ev.frog); ev.frog += 0.6 + r() * 2.4; }
    while (ev.horn < horizon) { if (a.city > 0.05 && r() < a.city) this.horn(ev.horn); ev.horn += 4 + r() * 10; }
    while (ev.gust < horizon) {
      if (a.wind > 0.05) this.gust.gain.setTargetAtTime(0.25 + r() * 0.75, ev.gust, 0.6 + r());
      ev.gust += 1.5 + r() * 3;
    }
  }

  scheduleBeat(ch, i, t, p) {
    const b = i % 4;
    // the catch: drum and the crew's blades
    this.ngoma(t, b === 0 ? 1 : 0.72);
    this.splash(t + 0.025, 0.3);
    const lk = LIKEMBE[Math.floor(i / 4) % LIKEMBE.length];
    this.pluck(t + p * 0.5, ch.root * 2 ** (this.degree(lk[0]) / 12), 0.07);
    this.pluck(t + p * 0.75, ch.root * 2 ** (this.degree(lk[1]) / 12), 0.05);
    if (b === 0) ch.phrase = PHRASES[Math.floor(ch.rand() * PHRASES.length)];
    const ph = ch.phrase ?? PHRASES[0], lvl = this.st.chantLevel;
    for (const [at, len, deg, syl] of ph.call) if (Math.floor(at) === b) this.sing(t + (at - b) * p, len * p, ch.root * 2 ** (this.degree(deg) / 12), syl, null, 0.24);
    const n = 4 + Math.round(lvl * 2);
    for (const [at, len, deg, syl] of ph.resp) if (Math.floor(at) === b) this.sing(t + (at - b) * p, len * p, ch.root * 2 ** (this.degree(deg) / 12), syl, CHORUS.slice(0, n), 0.15 + 0.06 * lvl);
  }

  degree(d) { return PENTA[((d % 5) + 5) % 5] + 12 * Math.floor(d / 5) - 12; }

  // --- instruments ------------------------------------------------------------------------------
  // a sung syllable: voices null = the soloist, else a chorus [[octave, cents, side], ...]
  sing(t, dur, freq, syl, voices, gain) {
    const c = this.ctx, { on, v } = parseSyllable(syl), solo = !voices;
    const groups = solo ? [[[0, 0, 0]]] : [voices.filter((x) => x[2] < 0), voices.filter((x) => x[2] >= 0)];
    const t1 = t + Math.max(0.15, dur) + 0.4, nodes = [];
    const start = on === 'h' ? 0.04 : 0;
    // shared vibrato, growing in after the attack
    const lfo = c.createOscillator(); lfo.frequency.value = 5.2 + this.rand() * 0.8;
    const vib = c.createGain(); vib.gain.setValueAtTime(0, t); vib.gain.linearRampToValueAtTime(solo ? 22 : 14, t + Math.min(0.3, dur));
    lfo.connect(vib); lfo.start(t); lfo.stop(t1); nodes.push(lfo, vib);
    groups.forEach((g, gi) => {
      if (!g.length) return;
      const sum = c.createGain(); sum.gain.value = 1 / Math.sqrt(g.length);
      const env = c.createGain(), pan = c.createStereoPanner();
      pan.pan.value = solo ? 0 : gi ? 0.55 : -0.55;
      nodes.push(sum, env, pan);
      for (const [oct, cents] of g) {
        const o = c.createOscillator(); o.type = 'sawtooth';
        const f = freq * 2 ** oct;
        o.frequency.setValueAtTime(f * 0.96, t + start);
        o.frequency.exponentialRampToValueAtTime(f, t + start + 0.07);     // a little scoop up into the note
        o.detune.value = cents + (solo ? 0 : (this.rand() - 0.5) * 6);
        vib.connect(o.detune);
        o.connect(sum); o.start(t); o.stop(t1); nodes.push(o);
        if (solo) {
          // a rough edge on the soloist's voice
          const j = c.createOscillator(), jd = c.createGain(); j.frequency.value = 13; jd.gain.value = 9;
          j.connect(jd).connect(o.detune); j.start(t); j.stop(t1); nodes.push(j, jd);
        }
      }
      // formant bank: higher voices get slightly higher formants
      const shift = g.some((x) => x[0] > 0) && !g.some((x) => x[0] <= 0) ? 1.15 : 1;
      const from = on === 'y' ? VOWEL.i : on === 'mb' ? VOWEL.m : VOWEL[v], to = VOWEL[v];
      to.forEach(([fq, amp], k) => {
        const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 9;
        bp.frequency.setValueAtTime(from[k][0] * shift, t);
        bp.frequency.linearRampToValueAtTime(fq * shift, t + start + (on ? 0.08 : 0.01));
        const ag = c.createGain(); ag.gain.value = amp * 3.2;
        sum.connect(bp).connect(ag).connect(env); nodes.push(bp, ag);
        if (on === 'h' && k < 2) this.noise(t, 0.06, { type: 'bandpass', f: fq * shift, q: 6 }, gain * 0.5, 0.01, 0.025, pan);
      });
      // envelope; 'mb' hums in softly before the vowel opens
      const peak = gain * (solo ? 1 : 1.1), a = t + start;
      env.gain.setValueAtTime(0, t);
      if (on === 'mb') { env.gain.linearRampToValueAtTime(peak * 0.35, a + 0.03); env.gain.linearRampToValueAtTime(peak, a + 0.09); } else env.gain.linearRampToValueAtTime(peak, a + 0.035);
      env.gain.setValueAtTime(peak, Math.max(a + 0.09, t + dur - 0.08));
      env.gain.setTargetAtTime(0, Math.max(a + 0.1, t + dur - 0.06), 0.05);
      env.connect(pan).connect(this.chantBus);
    });
    lfo.onended = () => nodes.forEach((n) => n.disconnect());
  }

  ngoma(t, g) {
    this.tone(t, 'sine', 110, 0.75 * g, 0.003, 0.16, this.sfx, 0.5, 1, 0.22);
    this.noise(t, 0.08, { type: 'bandpass', f: 900, q: 1 }, 0.14 * g, 0.001, 0.02, this.sfx);
  }

  splash(t, g) {
    const c = this.ctx, src = c.createBufferSource(), hp = c.createBiquadFilter(), bp = c.createBiquadFilter(), env = c.createGain();
    src.buffer = this.noiseBuf;
    hp.type = 'highpass'; hp.frequency.value = 500;
    bp.type = 'bandpass'; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(2600, t); bp.frequency.exponentialRampToValueAtTime(900, t + 0.25);
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(g, t + 0.012); env.gain.setTargetAtTime(0, t + 0.02, 0.07);
    src.connect(hp).connect(bp).connect(env).connect(this.sfx);
    src.start(t, this.rand() * 1.5); src.stop(t + 0.5);
    src.onended = () => { src.disconnect(); hp.disconnect(); bp.disconnect(); env.disconnect(); };
  }

  // likembe: a tine (sine with a short metallic partial) and the buzz of its rattles
  pluck(t, f, g) {
    this.tone(t, 'sine', f, g, 0.002, 0.28, this.sfx);
    this.tone(t, 'sine', f * 5.9, g * 0.18, 0.001, 0.02, this.sfx);
    this.noise(t, 0.12, { type: 'bandpass', f: 3200, q: 2 }, g * 0.12, 0.002, 0.04, this.sfx);
  }

  bird(t) {
    const c = this.ctx, r = this.rand, pan = c.createStereoPanner(), n = 2 + Math.floor(r() * 3);
    pan.pan.value = r() * 1.6 - 0.8;
    pan.connect(this.birdBus);
    const f0 = 2200 + r() * 1800, up = r() < 0.6;
    let x = t;
    for (let k = 0; k < n; k++) {
      const len = 0.05 + r() * 0.08, o = c.createOscillator(), m = c.createOscillator(), md = c.createGain(), env = c.createGain();
      o.frequency.setValueAtTime(up ? f0 : f0 * 1.5, x);
      o.frequency.exponentialRampToValueAtTime(up ? f0 * 1.5 : f0, x + len);
      m.frequency.value = 25 + r() * 35; md.gain.value = 120 + r() * 200;
      m.connect(md).connect(o.frequency);
      env.gain.setValueAtTime(0, x); env.gain.linearRampToValueAtTime(0.06, x + 0.01); env.gain.setTargetAtTime(0, x + len * 0.7, 0.02);
      o.connect(env).connect(pan);
      o.start(x); m.start(x); o.stop(x + len + 0.1); m.stop(x + len + 0.1);
      o.onended = () => { o.disconnect(); m.disconnect(); md.disconnect(); env.disconnect(); };
      x += len + 0.03 + r() * 0.06;
    }
    setTimeout(() => pan.disconnect(), (x - c.currentTime + 1) * 1000);
  }

  frog(t) {
    const c = this.ctx, r = this.rand, pan = c.createStereoPanner(), bp = c.createBiquadFilter();
    pan.pan.value = r() * 1.6 - 0.8;
    bp.type = 'bandpass'; bp.frequency.value = 500 + r() * 300; bp.Q.value = 3;
    bp.connect(pan).connect(this.frogBus);
    const f = 120 + r() * 100, n = 2 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) this.tone(t + k * 0.1, 'sawtooth', f, 0.3, 0.005, 0.025, bp, 0.85);
    setTimeout(() => { bp.disconnect(); pan.disconnect(); }, (t - c.currentTime + n * 0.1 + 1) * 1000);
  }

  horn(t) {
    const c = this.ctx, r = this.rand, pan = c.createStereoPanner(), lp = c.createBiquadFilter();
    pan.pan.value = r() * 1.4 - 0.7;
    lp.type = 'lowpass'; lp.frequency.value = 1100;
    lp.connect(pan).connect(this.hornBus);
    const honks = r() < 0.4 ? 2 : 1, len = 0.25 + r() * 0.35;
    for (let k = 0; k < honks; k++) {
      const x = t + k * (len + 0.12);
      for (const f of [410 + r() * 30, 520 + r() * 30]) {
        const o = c.createOscillator(), env = c.createGain();
        o.type = 'square'; o.frequency.value = f;
        env.gain.setValueAtTime(0, x); env.gain.linearRampToValueAtTime(0.025, x + 0.02); env.gain.setValueAtTime(0.025, x + len); env.gain.linearRampToValueAtTime(0, x + len + 0.04);
        o.connect(env).connect(lp); o.start(x); o.stop(x + len + 0.1);
        o.onended = () => { o.disconnect(); env.disconnect(); };
      }
    }
    setTimeout(() => { lp.disconnect(); pan.disconnect(); }, (t - c.currentTime + 2.5) * 1000);
  }

  // an oscillator with an attack and an exponential decay (tau); `drop` the pitch ends at
  // f * drop over `dropT` s, `from` its starting multiple
  tone(t, type, f, g, attack, tau, dest, drop = 1, from = 1, dropT = 0.05) {
    const c = this.ctx, o = c.createOscillator(), env = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f * from, t);
    if (drop !== 1 || from !== 1) o.frequency.exponentialRampToValueAtTime(f * drop, t + dropT);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(g, t + attack);
    env.gain.setTargetAtTime(0, t + attack, tau);
    o.connect(env).connect(dest);
    o.start(t);
    o.stop(t + attack + tau * 7 + 0.02);
    o.onended = () => { o.disconnect(); env.disconnect(); };
  }

  // a burst of filtered noise
  noise(t, len, { type, f, q }, g, attack, tau, dest) {
    const c = this.ctx, src = c.createBufferSource(), flt = c.createBiquadFilter(), env = c.createGain();
    src.buffer = this.noiseBuf;
    flt.type = type; flt.frequency.value = f; flt.Q.value = q;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(g, t + attack);
    env.gain.setTargetAtTime(0, t + attack, tau);
    src.connect(flt).connect(env).connect(dest);
    src.start(t, this.rand() * 1.5);
    src.stop(t + Math.max(len, attack + tau * 6));
    src.onended = () => { src.disconnect(); flt.disconnect(); env.disconnect(); };
  }

  gainNode(v) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
}
