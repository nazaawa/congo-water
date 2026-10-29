import * as THREE from 'three';
import { Pirogue } from './floaters.js';
import { waveHeight } from './waves.js';
import { mulberry32 } from './noise.js';

// The 3D side of the race and of the guided visit:
// * rival crews in boats like yours, running a racing line down (or up) the real channel,
//   each at its own skill, pushed or held back by the same current as you;
// * gates of red and yellow buoys to pass through, and a finish arch over the landing;
// * the autopilot of the guided visit: follow the line, ease off near each stop.
// The race runs in the 3D frame (channel s, d): `line(u)` is the racing line at progress u.

export const TEAMS = [
  { name: 'Les Requins de Kingabwa', color: '#d7263d' },
  { name: 'Pagayeurs de Maluku', color: '#1b6fd1' },
  { name: 'Étoile de Kinkole', color: '#2aa84a' },
  { name: 'Les Hippos de Mbamu', color: '#7b2d8e' },
  { name: 'Lions de Ngaliema', color: '#f2b705' },
];

function flagTexture(color, text) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 80;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 128, 80);
  g.fillStyle = '#fff'; g.font = 'bold 54px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 64, 42);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function bannerTexture(text) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 128;
  const g = c.getContext('2d');
  // checkers at both ends, the word in the middle
  g.fillStyle = '#f7d618'; g.fillRect(0, 0, 1024, 128);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
    g.fillStyle = (i + j) % 2 ? '#111' : '#fff';
    g.fillRect(i * 32, j * 64, 32, 64);
    g.fillRect(1024 - 128 + i * 32, j * 64, 32, 64);
  }
  g.fillStyle = '#ce1021'; g.font = '800 84px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 512, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const BUOY_GEO = new THREE.SphereGeometry(0.75, 16, 10).scale(1, 1.15, 1);
const BUOY_MAT = [new THREE.MeshStandardMaterial({ color: 0xd7263d, roughness: 0.45 }), new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.45 })];

// a gate of two buoys, a little flag on each
function gate(channel, s, d, half) {
  const g = new THREE.Group(), buoys = [];
  for (const k of [-1, 1]) {
    const q = channel.point(s, d + k * half);
    const b = new THREE.Mesh(BUOY_GEO, BUOY_MAT[k > 0 ? 1 : 0]);
    b.position.set(q.x, 0, q.z);
    b.castShadow = true;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    pole.position.y = 1.6;
    b.add(pole);
    g.add(b);
    buoys.push(b);
  }
  return { group: g, buoys, s, d, half };
}

// two posts and a banner across the landing
function arch(channel, s, d, half) {
  const g = new THREE.Group();
  const a = channel.point(s, d - half), b = channel.point(s, d + half);
  const wood = new THREE.MeshStandardMaterial({ color: 0xe9e2d2, roughness: 0.6 });
  for (const q of [a, b]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 11, 10), wood);
    post.position.set(q.x, 4.5, q.z);
    post.castShadow = true;
    g.add(post);
  }
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(len, Math.min(3, len / 8)), new THREE.MeshStandardMaterial({ map: bannerTexture('ARRIVÉE'), side: THREE.DoubleSide, roughness: 0.8 }));
  banner.position.set((a.x + b.x) / 2, 9, (a.z + b.z) / 2);
  banner.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
  g.add(banner);
  return g;
}

export class Race {
  // m: the mission (pilot.js planMission); river: RiverScene; n rivals
  constructor(river, m, n = 3) {
    this.river = river;
    this.m = m;
    this.group = new THREE.Group();
    const ch = river.channel, W = ch.halfWidth, kind = river.pirogue.kind;
    this.line = racingLine(m, W);
    this.gateHalf = THREE.MathUtils.clamp(W * 0.22, 7, 45);
    // gates spread along the trip, then the arch
    this.gates = [];
    const ng = Math.max(2, Math.min(8, Math.round(m.lengthAlong / 450)));
    for (let i = 1; i <= ng; i++) {
      const P = this.line(i / (ng + 1));
      const g = gate(ch, P.s, P.d, this.gateHalf);
      this.gates.push(g);
      this.group.add(g.group);
    }
    const E = this.line(1);
    this.group.add(arch(ch, E.s, E.d, this.gateHalf + 4));
    this.passed = 0;
    this.penalty = 0;
    this.missed = 0;
    this.lastS = m.start.s;

    // the rivals, abreast of you on the start line, in the lanes beside the racing line
    const rnd = mulberry32(7 + Math.round(m.lengthAlong));
    this.rivals = [];
    const first = Math.floor(rnd() * TEAMS.length);
    for (let i = 0; i < n; i++) {
      const team = TEAMS[(first + i) % TEAMS.length];
      const boat = new Pirogue(river.models);
      boat.setKind(kind);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.75), new THREE.MeshStandardMaterial({ map: flagTexture(team.color, String(i + 2)), side: THREE.DoubleSide }));
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
      pole.position.set(boat.L * 0.42, 1.4, 0);
      flag.position.set(boat.L * 0.42 - 0.62, 2.2, 0);
      boat.group.add(pole, flag);
      this.group.add(boat.group);
      const lane = (i % 2 ? 1 : -1) * Math.ceil((i + 1) / 2);
      this.rivals.push({ boat, team, skill: 0.9 + rnd() * 0.12, lane, u: 0, laneD: lane * Math.max(6, boat.halfBeam * 6), wobble: rnd() * 10, finished: null, heading: m.heading });
    }
    river.scene.add(this.group);
    this.started = false;
  }

  // progress of a point on the trip (0 start .. 1 landing)
  progressOf(P) { return this.m.progress(P); }

  // frameDt: real seconds since the last frame; t: scene time
  update(frameDt, t) {
    const ch = this.river.channel, waves = this.river.waves, pilot = this.river.pilot;
    const dt = frameDt * pilot.timeScale, time = pilot.time, lim = ch.halfWidth - 4;
    const at = (u, lane) => { const P = this.line(u); return ch.point(P.s, THREE.MathUtils.clamp(P.d + lane * (1 - u), -lim, lim)); };
    for (const r of this.rivals) {
      if (this.started && r.finished == null) {
        const q = at(r.u, r.laneD);
        const cur = pilot.current(q.x, q.z), along = this.m.alongSign;
        // speed made good along the line: own speed through the water, plus or minus the current
        const own = this.m.vmax * r.skill * (0.97 + 0.04 * Math.sin(time * 0.05 + r.wobble));
        const v = Math.max(0.4, own + (this.m.crossing ? 0 : along * cur));
        r.u = Math.min(1, r.u + (v * dt) / this.m.lengthAlong);
        if (r.u >= 1) r.finished = time;
      }
      const q = at(r.u, r.laneD), q2 = at(Math.min(1, r.u + 3 / this.m.lengthAlong), r.laneD);
      if (r.u < 0.999) r.heading = Math.atan2(q2.z - q.z, q2.x - q.x);
      r.boat.steer = 0;
      r.boat.update(waves, t, frameDt, { x: q.x, z: q.z, heading: r.heading }, r.finished == null && this.started ? 1 : 0.1);
      r.pos = q;
    }
    // gates: crossing a gate's station along the bed counts it, passed between the buoys or not
    const s = this.river.pilot.state, c = ch.sample(s.x, s.z);
    const g = this.gates[this.passed];
    if (g) {
      const dir = this.m.alongSign;
      if ((c.s - g.s) * dir >= 0 && (this.lastS - g.s) * dir < 0) {
        const ok = Math.abs(c.d - g.d) <= g.half + 1;
        this.passed++;
        if (!ok) { this.missed++; this.penalty += 15; }
        this.lastEvent = { ok, at: time };
        g.buoys.forEach((b) => (b.material = ok ? BUOY_MAT[1] : BUOY_MAT[0]));
      }
    }
    this.lastS = c.s;
    for (const gg of this.gates) for (const b of gg.buoys) b.position.y = waveHeight(waves, b.position.x, b.position.z, t) + 0.25;
  }

  // standings: you and the rivals by progress (finished first, by time)
  standings(you) {
    const all = [{ name: 'Toi', color: '#ffffff', u: you.u, finished: you.finished, you: true }, ...this.rivals.map((r) => ({ name: r.team.name, color: r.team.color, u: r.u, finished: r.finished }))];
    all.sort((a, b) => (a.finished != null && b.finished != null ? a.finished - b.finished : a.finished != null ? -1 : b.finished != null ? 1 : b.u - a.u));
    return all;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => { if (o.isMesh && o.geometry !== BUOY_GEO) { o.geometry.dispose(); if (!BUOY_MAT.includes(o.material)) { o.material.map?.dispose(); o.material.dispose(); } } });
  }
}

// the line to follow from start to landing, in the channel frame: away from the start bank,
// mid-river going down with the current, nearer a bank (out of the strongest current) going up,
// then in to the landing
export function racingLine(m, W) {
  const s0 = m.start.s, s1 = m.end.s, d0 = m.start.d, d1 = m.end.d;
  const up = !m.crossing && m.alongSign < 0 && m.flow > 0.6;
  const cruise = up ? Math.sign(d0 + d1 || 1) * Math.min(W * 0.55, W - 25) : THREE.MathUtils.clamp((d0 + d1) / 2, -W * 0.3, W * 0.3);
  const L = Math.abs(s1 - s0), ramp = Math.min(0.3, Math.max(W * 1.2, 60) / Math.max(1, L));
  return (u) => {
    const s = s0 + (s1 - s0) * u;
    let d;
    if (m.crossing) d = d0 + (d1 - d0) * u;
    else if (u < ramp) d = d0 + (cruise - d0) * THREE.MathUtils.smoothstep(u, 0, ramp);
    else if (u > 1 - ramp) d = cruise + (d1 - cruise) * THREE.MathUtils.smoothstep(u, 1 - ramp, 1);
    else d = cruise;
    return { s, d };
  };
}

// the guided visit's autopilot: steer for a point ahead on the line, slow near stops
export function autopilot(m, river, line, slowAt = []) {
  const ch = river.channel, pilot = river.pilot, W = ch.halfWidth;
  return () => {
    const s = pilot.state, c = ch.sample(s.x, s.z);
    const u = THREE.MathUtils.clamp((c.s - m.start.s) / (m.end.s - m.start.s || 1), 0, 1);
    const look = Math.max(30, Math.min(W * 0.9, 220)) / Math.max(1, m.lengthAlong);
    const near = Math.hypot(m.end.x - s.x, m.end.z - s.z) < Math.max(60, river.pirogue.L * 3);
    const T = near ? m.end : (() => { const P = line(Math.min(1, u + look)); return ch.point(P.s, P.d); })();
    let e = Math.atan2(T.z - s.z, T.x - s.x) - s.heading;
    e = Math.atan2(Math.sin(e), Math.cos(e));
    const slow = slowAt.some((st) => Math.abs(st - c.s) < Math.max(80, W)) || near;
    // aground: back off; a rock or the bank dead ahead: turn to the clear side
    if (pilot.grounded > 0) return { steer: -Math.sign(e || 1), throttle: -0.4 };
    // how far the water is clear along a bearing (rocks, banks), up to `far`
    const L = river.pirogue.L, far = L * 0.5 + Math.max(18, L * 3);
    const clear = (a) => {
      for (let r = L * 0.5 + 2; r <= far; r += 2.5) if (pilot.blocked(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r)) return r;
      return far;
    };
    const want = s.heading + e;
    if (clear(want) < far) {
      // threading rocks: the bearing with the most clear water, the nearest to the one wanted
      let best = -Infinity;
      for (let k = -6; k <= 6; k++) {
        const a = want + k * 0.2, score = clear(a) - Math.abs(k) * 0.9;
        if (score > best) { best = score; e = Math.atan2(Math.sin(a - s.heading), Math.cos(a - s.heading)); }
      }
    }
    return { steer: THREE.MathUtils.clamp(e * 2.5 - s.r * 1.5, -1, 1), throttle: slow ? 0.4 : 0.8 };
  };
}
