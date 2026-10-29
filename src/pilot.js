import { PRESETS, channelCentre } from './water/presets.js';
import { PIROGUES } from './water/pirogues.js';
import { Channel, straightChannel, maxExtent, toLocal } from './water/channel.js';
import { haversine } from './map.js';

// Piloting a trip from stop X to stop Y of the selected route: free, as a race against
// other pirogues, or as a guided visit.
//
// * Along a river, the 3D river *is* the route's real course: the OSM track between the two
//   stops (with some river before and after) in local metres, scaled down uniformly when it
//   doesn't fit the world, the river keeping its real width (channel.js). The boat maps back
//   to the real map exactly: distance along the bed → the same fraction of the real track,
//   offset from the centreline → the same offset in metres.
// * A crossing (route mode 'crossing') keeps the straight stretch: the real offset X→Y splits
//   into an along-river and an across-river part, fitted bank to bank.

const $ = (s) => document.querySelector(s);
const rad = (d) => (d * Math.PI) / 180;
const toEnu = (o, c) => [(c[0] - o[0]) * Math.cos(rad(o[1])) * 111320, (c[1] - o[1]) * 110574];
const fromEnu = (o, d) => [o[0] + d[0] / (Math.cos(rad(o[1])) * 111320), o[1] + d[1] / 110574];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtKm = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} km`);
const fmtTime = (s) => (s < 3600 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`);
const MAX_SQUEEZE = 12;

// signed offset of a point from the river centreline (m), right of downstream
function riverOffset(tour, route, c) {
  const { dir, point } = tour.riverDirection(c, route.river);
  return dot(toEnu(point, c), [dir[1], -dir[0]]);
}

// does the route's track run downstream around real distance `mid`?
function trackSign(tour, route, mid, span) {
  const track = tour.track, h = Math.max(150, Math.min(600, span / 3));
  const run = toEnu(track.at(mid - h).point, track.at(mid + h).point), u = tour.riverDirection(track.at(mid).point, route.river).dir;
  return dot(run, u) >= 0 ? 1 : -1;
}

// the track at real distance r, carried on in a straight line past either end (stops often sit
// at the very ends of a route, and the 3D river needs some water beyond them)
function trackAt(track, r) {
  const c = Math.max(0, Math.min(track.length, r)), a = track.at(c);
  if (r === c) return a;
  const h = rad(track.at(r < 0 ? Math.min(track.length, 60) : Math.max(0, track.length - 60)).heading);
  return { heading: a.heading, point: fromEnu(a.point, [Math.sin(h) * (r - c), Math.cos(h) * (r - c)]) };
}

// a stretch [wa, wb] (real metres along the track, may run past its ends) as a 3D channel,
// scaled by k (≤ 1) to fit the world; s3d(real) / real(s3d) convert along the bed
function trackChannel(tour, W, wa, wb, tSign, kMax = 1) {
  const track = tour.track, origin = trackAt(track, (wa + wb) / 2).point;
  const n = Math.max(2, Math.min(1500, Math.ceil((wb - wa) / Math.max(4, W / 4))));
  let pts = [];
  for (let i = 0; i <= n; i++) pts.push(toLocal(origin, trackAt(track, wa + ((wb - wa) * i) / n).point));
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const k = Math.min(kMax, (maxExtent(W) * 0.85) / Math.max(1, x1 - x0, z1 - z0));
  pts = pts.map(([x, z]) => [x * k, z * k]);
  if (tSign < 0) pts.reverse();
  const channel = new Channel(pts, W);
  const Lc = channel.length, span = wb - wa;
  return {
    channel, k, scale: span / Lc,
    s3d: (r) => (tSign > 0 ? (r - wa) / span : (wb - r) / span) * Lc,
    real: (s) => (tSign > 0 ? wa + (s / Lc) * span : wb - (s / Lc) * span),
  };
}

// the 3D river around one stop of a route (the view at a stop, outside piloting)
export function placeChannel(tour, route, i) {
  if (route.mode === 'crossing' || !tour.track) return null;
  const S = route.stops[i], p = PRESETS[S.scene], W = p.halfWidth;
  const si = tour.stopAlong[i], half = (maxExtent(W) * 0.8) / 2;
  const wa = Math.max(-half / 3, si - half), wb = Math.min(tour.track.length + half / 3, si + half);
  const tSign = trackSign(tour, route, si, wb - wa);
  const t = trackChannel(tour, W, wa, wb, tSign);
  const o = clamp(riverOffset(tour, route, S.coord), -W * 0.6, W * 0.6);
  return { channel: t.channel, stationS: t.s3d(si), stationD: W < 100 ? 0 : o, fallS: p.fall ? Math.max(30, t.s3d(si) - 60) : null };
}

export function planMission(tour, route, i, j) {
  const S = route.stops[i], E = j == null ? null : route.stops[j];
  const sceneKey = S.scene, p = PRESETS[sceneKey];
  const W = p.halfWidth, margin = Math.max(6, Math.min(30, W * 0.3));
  const flow = p.flow, vmax = PIROGUES[route.pirogue].vmax;
  const offset = (c) => riverOffset(tour, route, c);
  const base = { sceneKey, from: S, to: E, flow, vmax, title: E ? `${S.name} → ${E.name}` : `Pilotage libre · ${S.name}` };
  if (E && i === j) return { ...base, ok: false, reason: 'Choisis deux étapes différentes.' };

  if (route.mode === 'crossing') {
    const channel = straightChannel(p);
    const ref = E ? [(S.coord[0] + E.coord[0]) / 2, (S.coord[1] + E.coord[1]) / 2] : S.coord;
    const u = tour.riverDirection(ref, route.river).dir, r = [u[1], -u[0]];
    const sS = offset(S.coord) >= 0 ? 1 : -1;
    const start = { x: 0, z: channelCentre(p, 0) + sS * (W - margin) };
    let end = null, sx = 1, sz = 1, dist = 0, heading = -sS * (Math.PI / 2 + 0.3);
    if (E) {
      const d = toEnu(S.coord, E.coord), along = dot(d, u), across = dot(d, r), sE = offset(E.coord) >= 0 ? 1 : -1;
      const k = Math.min(1, (2 * W - 2 * margin) / Math.abs(across));
      end = { x: along * k, z: channelCentre(p, along * k) + sE * (W - margin) };
      // 3D → real metres east/north of X, each axis scaled so the 3D landing maps onto Y
      sx = Math.abs(end.x) > 1 ? along / end.x : 1 / k;
      sz = Math.abs(end.z - start.z) > 1 ? across / (end.z - start.z) : 1 / k;
      dist = Math.hypot(d[0], d[1]);
      heading = Math.atan2(end.z - start.z, end.x - start.x);
      base.landSide = { start: sS, end: sE };
    } else base.landSide = { start: sS };
    const sd = (P) => { const c = channel.sample(P.x, P.z); return { ...P, s: c.s, d: c.d }; };
    Object.assign(start, sd(start));
    if (end) Object.assign(end, sd(end));
    const planDir = (dx, dz) => [u[0] * dx * sx + r[0] * dz * sz, u[1] * dx * sx + r[1] * dz * sz];
    const plan = (P) => planDir(P.x - start.x, P.z - start.z);
    return {
      ...base, ok: true, crossing: true, start, end, heading, dist, north: true, channel,
      stationS: channel.offset + start.x, stationD: start.z,
      lengthAlong: end ? Math.hypot(end.x - start.x, end.z - start.z) : 0, alongSign: end && end.s < start.s ? -1 : 1,
      labels: [{ ...S, s: start.s, side: Math.sign(start.d) }, ...(E ? [{ ...E, s: end.s, side: Math.sign(end.d) }] : [])],
      scale: end ? dist / Math.hypot(end.x - start.x, end.z - start.z) : 1,
      plan, planDir,
      geo: (P) => fromEnu(S.coord, plan(P)),
      bearing: (P, h) => { const v = planDir(Math.cos(h), Math.sin(h)); return (Math.atan2(v[0], v[1]) * 180) / Math.PI; },
      remaining: (P) => (E ? haversine(fromEnu(S.coord, plan(P)), E.coord) : null),
      progress: (P) => (E ? clamp(1 - haversine(fromEnu(S.coord, plan(P)), E.coord) / dist, 0, 1) : 0),
      stops: [],
    };
  }

  // along the river: the real course between the two stops, with some river on both sides
  const track = tour.track, si = tour.stopAlong[i], sj = E ? tour.stopAlong[j] : si;
  const L = Math.abs(sj - si);
  const extra = Math.max(L * 0.12, 400, W * 4);
  const wa = Math.min(si, sj) - extra, wb = Math.max(si, sj) + (E ? extra : extra * 6);
  const tSign = trackSign(tour, route, (si + sj) / 2, Math.max(L, 600));
  const t = trackChannel(tour, W, wa, wb, tSign);
  const { channel } = t;
  const ok = !E || (L > 40 && t.k >= 1 / MAX_SQUEEZE);
  const dS = clamp(offset(S.coord), -(W - margin), W - margin);
  const bankOf = (d) => (Math.abs(d) > W * 0.5 ? Math.sign(d) : 0);
  const s0 = t.s3d(si), start = { ...channel.point(s0, dS), s: s0, d: dS };
  base.landSide = { start: bankOf(dS) };
  let end = null, s1 = s0;
  if (E) {
    const dE = clamp(offset(E.coord), -(W - margin), W - margin);
    s1 = t.s3d(sj);
    end = { ...channel.point(s1, dE), s: s1, d: dE };
    base.landSide.end = bankOf(dE);
  }
  const downstream = s1 >= s0;
  const fallStop = route.stops.findIndex((st) => PRESETS[st.scene].fall);
  const fallS = p.fall && fallStop >= 0 ? t.s3d(tour.stopAlong[fallStop]) - 60 : null;
  // the stops passed on the way, for the guided visit (along the bed, in 3D)
  const lo = Math.min(i, j ?? i), hi = Math.max(i, j ?? i);
  const all = route.stops.map((st, k) => ({ ...st, k, s: t.s3d(tour.stopAlong[k]), side: Math.sign(offset(st.coord)) || 1 }))
    .filter((st) => st.s > 0 && st.s < channel.length);
  const stops = all.filter((st) => st.k >= lo && st.k <= hi);
  const c = {};
  const along = (P) => channel.sample(P.x, P.z, c);
  return {
    ...base, ok, crossing: false, start, end, dist: L, scale: t.scale, squeeze: 1 / t.k, downstream, north: true, channel,
    stationS: s0, stationD: dS, fallS: fallS != null && fallS > 40 ? fallS : null, stops, labels: all,
    lengthAlong: Math.abs(s1 - s0), alongSign: downstream ? 1 : -1,
    // bow along the bed, towards the landing (upstream when piloting freely)
    heading: E && downstream ? Math.atan2(start.fz, start.fx) : Math.atan2(-start.fz, -start.fx),
    reason: ok ? '' : L <= 40 ? 'Ces deux étapes sont au même endroit du parcours.' : `Trajet trop long pour le pilotage (${fmtKm(L)} sur le fleuve) — choisis deux étapes plus proches.`,
    // the 3D world is the real map scaled: x east, z south
    plan: (P) => [P.x - start.x, -(P.z - start.z)],
    planDir: (dx, dz) => [dx, -dz],
    geo: (P) => {
      along(P);
      const { point, heading } = trackAt(track, t.real(c.s)), b = rad(heading + 90 * tSign);   // right of downstream
      return fromEnu(point, [Math.sin(b) * c.d, Math.cos(b) * c.d]);
    },
    bearing: (P, h) => (Math.atan2(Math.cos(h), -Math.sin(h)) * 180) / Math.PI,
    remaining: (P) => (end ? (along(P), Math.hypot((s1 - c.s) * t.scale, end.d - c.d)) : null),
    progress: (P) => (end ? (along(P), clamp((c.s - s0) / (s1 - s0), 0, 1)) : 0),
  };
}

export class PilotUI {
  constructor({ tour, getRoute, ensureRiver, showPlace, viewer, onStart, onExit }) {
    Object.assign(this, { tour, getRoute, ensureRiver, showPlace, viewer, onStart, onExit });
    this.active = false;
    this.held = new Set();
    this.radar = $('#radar').getContext('2d');

    $('#pFrom').onchange = $('#pTo').onchange = () => this.validate();
    // free piloting, a race against three crews, or a guided visit on autopilot
    this.modeSel = 'libre';
    document.querySelectorAll('.pmode button').forEach((b) => (b.onclick = () => this.setMode(b.dataset.mode)));
    $('#pGo').onclick = () => this.start(+$('#pFrom').value, +$('#pTo').value);
    $('#pFree').onclick = () => this.start(+$('#pFrom').value, null);
    $('#hQuit').onclick = () => this.exit();
    $('#aAgain').onclick = () => this.start(this.ij[0], this.ij[1]);
    $('#aMap').onclick = () => this.exit(true);
    document.querySelectorAll('[data-ts]').forEach((b) => {
      b.onclick = () => this.setTimeScale(+b.dataset.ts);
    });
    // on-screen pad: hold to act (works with a finger or the mouse)
    document.querySelectorAll('.pad button').forEach((b) => {
      const k = b.dataset.k;
      const on = (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); if (k === 'stop') this.river.pilot.input.throttle = 0; else this.held.add(k); b.classList.add('on'); };
      const off = () => { this.held.delete(k); b.classList.remove('on'); };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
    });
    const KEYS = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
    addEventListener('keydown', (e) => {
      if (!this.active || e.target.matches?.('input, select, textarea')) return;
      if (KEYS[e.code]) { this.held.add(KEYS[e.code]); e.preventDefault(); }
      else if (e.code === 'Space') { e.preventDefault(); if (this.chant) { if (!e.repeat) this.paddleStroke(); } else this.river.pilot.input.throttle = 0; }
      else if (e.code === 'KeyC') this.cycleCamera();
      else if (e.code === 'KeyP' && this.auto) { this.autoOn = !this.autoOn; this.flash(this.autoOn ? 'Pilote automatique repris' : 'Tu as la barre'); }
    });
    $('#hPaddle').addEventListener('pointerdown', (e) => { e.preventDefault(); this.paddleStroke(); });
    addEventListener('keyup', (e) => { if (KEYS[e.code]) this.held.delete(KEYS[e.code]); });
    addEventListener('blur', () => this.held.clear());
  }

  setMode(mode) {
    this.modeSel = mode;
    document.querySelectorAll('.pmode button').forEach((x) => { x.classList.toggle('on', x.dataset.mode === mode); x.setAttribute('aria-checked', x.dataset.mode === mode); });
    if (this.getRoute()) this.validate();
  }

  // the setup box in the expedition panel
  fill(route) {
    const opts = route.stops.map((s, i) => `<option value="${i}">${s.name}</option>`).join('');
    $('#pFrom').innerHTML = opts;
    $('#pTo').innerHTML = opts;
    // default: the longest trip from the first stop that can be piloted, else the first pair of
    // neighbouring stops that can
    const n = route.stops.length, ok = (i, j) => planMission(this.tour, route, i, j).ok;
    let pick = [0, Math.min(1, n - 1)];
    found: {
      for (let j = n - 1; j > 0; j--) if (ok(0, j)) { pick = [0, j]; break found; }
      for (let i = 1; i < n - 1; i++) if (ok(i, i + 1)) { pick = [i, i + 1]; break found; }
    }
    $('#pFrom').value = pick[0];
    $('#pTo').value = pick[1];
    this.validate();
  }

  validate() {
    const route = this.getRoute();
    const m = planMission(this.tour, route, +$('#pFrom').value, +$('#pTo').value);
    const spec = PIROGUES[$('#pirogue').value || route.pirogue], flow = m.flow.toFixed(1).replace('.', ',');
    const squeeze = m.scale > 1.3 ? ` La vue 3D condense le trajet (×${m.scale.toFixed(1).replace('.', ',')}) ; distance et temps affichés restent réels.` : '';
    const mode = this.modeSel;
    $('#pGo').disabled = !m.ok;
    $('#pGo').textContent = { libre: 'Embarquer', course: 'Lancer la course', visite: 'Commencer la visite' }[mode];
    $('#pFree').hidden = mode !== 'libre';
    const extra = !m.ok ? '' : mode === 'course'
      ? ' Course contre trois équipages : passe entre les bouées (+15 s par bouée manquée).'
      : mode === 'visite' ? ' Le pilote te promène d’étape en étape ; reprends la barre quand tu veux.' : '';
    $('#pNote').textContent = !m.ok ? m.reason
      : m.crossing
        ? `Traversée de ${fmtKm(m.dist)} en ${spec.label.toLowerCase()}. Le courant (${flow} m/s) te déporte vers l'aval : vise un peu en amont.`
        : m.downstream
          ? `${fmtKm(m.dist)} en descendant le courant (${flow} m/s).${squeeze}`
          : `${fmtKm(m.dist)} à contre-courant (${flow} m/s).${m.flow > spec.vmax * 0.8 ? ' Le courant est plus fort que ta pirogue : longe les berges, où il faiblit.' : ''}${squeeze}`;
    if (extra) $('#pNote').textContent += extra;
  }

  async start(i, j) {
    const route = this.getRoute();
    const m = planMission(this.tour, route, i, j);
    if (!m.ok) return;
    const mode = (m.mode = j == null ? 'libre' : this.modeSel);
    // the guided visit goes out in the painted leisure whaleboat, where the river is wide enough
    if (mode === 'visite' && PRESETS[m.sceneKey].halfWidth >= 60) m.kind = 'baleiniere-loisirs';
    this.ij = [i, j];
    this.onStart?.();
    this.mission = m;
    this.cleanup();
    const season = $('#pSeason').value || null;
    await this.showPlace(m.from, m.sceneKey, { channel: m.channel, stationS: m.stationS, stationD: m.stationD, fallS: m.fallS, kind: m.kind, season });
    const r = this.river = await this.ensureRiver();
    if ($('#pTime').value) { const h = $('#hour'); h.value = $('#pTime').value; h.dispatchEvent(new Event('input')); }
    this.startSound(r, m, mode);
    this.viewer.classList.remove('pip');
    this.viewer.classList.add('full', 'piloting');
    $('#vExpand').textContent = '⤡';
    r.setMode('chase');
    $('#vMode').textContent = 'Poursuite';
    r.pilot.start(m);
    // a trip of a few minutes at most: speed up time on long or slow ones
    const eta = m.end ? m.lengthAlong / PIROGUES[r.pirogue.kind].vmax : 0;
    this.ts = [1, 4, 10, 30].find((ts) => eta / ts < (mode === 'course' ? 200 : 150)) ?? 30;
    this.setTimeScale(this.ts);
    $('#pilotHud').hidden = false;
    $('#arrive').hidden = true;
    $('#aTable').hidden = true;
    $('#hTitle').textContent = { libre: m.title, course: `Course · ${m.title}`, visite: `Visite · ${m.title}` }[mode];
    this.trail = [m.geo(m.start)];
    this.tour.setPilotTrail([]);
    this.lastMap = 0;
    this.active = true;
    this.arrivedShown = false;
    this.cardShown = new Set();

    if (mode !== 'libre') {
      const { Race, racingLine, autopilot } = await import('./water/race.js');
      if (mode === 'course') {
        this.race = new Race(r, m, 3);
        // 3, 2, 1, partez! — the clock and the rivals wait for the start
        r.pilot.timeScale = 0;
        this.countdown = 3.6;
      } else {
        const line = racingLine(m, PRESETS[m.sceneKey].halfWidth);
        this.auto = autopilot(m, r, line, m.stops.slice(1, -1).map((st) => st.s));
        this.autoOn = true;
        $('#kAuto').hidden = false;
        this.showCard(m.from, 'Départ');
      }
    }
    this.buildLabels();
    this.announced = new Set();
    this.drumQueue = [];
    // the weather of the trip: fine, a storm from the start, or one rolling in on the way
    const wx = $('#pWeather').value;
    r.weather.target = r.weather.storm = wx === 'orage' ? 1 : 0;
    r.refreshWater();
    r.setSun(r.sunElev, r.sunAzim);
    this.stormPlan = wx === 'variable' && Math.random() < 0.75 ? { at: m.end ? 0.2 + Math.random() * 0.3 : 60 + Math.random() * 60, warned: false, on: false, off: false } : null;
    if (mode === 'course') this.drum('HH.HH.H-L', 'Les tambours appellent les équipages. Tokende ! (On y va !)');
    else this.drum('HL.HL-HH', m.end ? `${m.from.name} salue ton départ. Mbote !` : 'Le fleuve est à toi. Mbote !');
    document.activeElement?.blur?.();
    cancelAnimationFrame(this.raf);
    let last = performance.now();
    const loop = (now) => {
      if (!this.active) return;
      this.tick(Math.min(0.1, (now - last) / 1000), now);
      last = now;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // race, autopilot, labels and cards of the last trip
  cleanup() {
    this.race?.dispose();
    this.race = null;
    this.auto = null;
    this.autoOn = false;
    this.countdown = 0;
    $('#kAuto').hidden = true;
    $('#hRank').hidden = true;
    $('#countdown').hidden = true;
    $('#card').hidden = true;
    $('#labels').innerHTML = '';
    this.labels = [];
    this.bubbles = null;
    $('#rhythm').hidden = true;
    $('#hPaddle').hidden = true;
    $('#drum').hidden = true;
    if (this.river) {
      const a = this.river.audio;
      a.stopChant();
      a.engine(false);
      this.river.pirogue.strokeClock = null;
      this.river.pilot.input.boost = 1;
      this.river.weather.setStorm(0);
    }
    this.chant = null;
  }

  // the chant of the paddlers (paddle boats) or the outboard (motor boats)
  startSound(r, m, mode) {
    const a = r.audio, spec = PIROGUES[r.pirogue.kind];
    a.resume();
    this.rhythm = 0;
    this.combo = 0;
    if (!spec.motor) {
      a.startChant({ bpm: 36, seed: Math.floor(Math.random() * 1000) });
      a.setChantLevel(mode === 'course' ? 0.9 : 0.6);
      r.pirogue.strokeClock = () => { if (!a.ready || !a.beats.length) return null; const b = a.beat(); return b.index + b.phase; };
      this.chant = { bpm: 36, lastCatch: -1 };
      a.onBeat = (i) => this.onBeat(i);
      $('#rhythm').hidden = false;
      $('#hPaddle').hidden = false;
    } else a.engine(true, 0);
    $('#kAuto').hidden = !this.auto;
    document.querySelector('.hud-bottom .keys').firstChild.textContent = spec.motor
      ? 'Z/W ▲ accélérer · S ▼ ralentir · Q/A ◀ ▶ D barrer · Espace stop · C caméra'
      : 'Z/W ▲ cadence · S ▼ ralentir · Q/A ◀ ▶ D barrer · Espace : pagaie au rythme du chant · C caméra';
  }

  // the chant's call and response, and whether the last catch was paddled
  onBeat(i) {
    const c = this.chant;
    if (!c) return;
    const lines = [['Soliste', 'É-é ya !'], ['Soliste', 'Tokende !'], ['Chœur', 'O-hé !'], ['Chœur', 'Makasi !']];
    const [who, word] = lines[i % 4];
    $('#rCall').innerHTML = `<small>${who}</small>${word}`;
    const ring = $('#rRing');
    ring.style.animation = 'none'; void ring.offsetWidth;
    ring.style.animation = `beat ${(60 / c.bpm).toFixed(2)}s linear`;
  }

  paddleStroke() {
    if (!this.chant || !this.river) return;
    const a = this.river.audio, j = a.judge();
    a.stroke(j.quality);
    const at = a.now - a.latency - j.offset;        // the catch this stroke was aimed at
    if (Math.abs(at - this.chant.lastCatch) < 0.05) return;     // one stroke per catch
    this.chant.lastCatch = at;
    const gain = { perfect: 0.22, good: 0.1, miss: -0.25 }[j.quality];
    this.rhythm = clamp(this.rhythm + gain, 0, 1);
    this.combo = j.quality === 'miss' ? 0 : this.combo + 1;
    const el = $('#rJudge');
    el.textContent = { perfect: 'Malamu !', good: 'Bien', miss: 'Raté' }[j.quality];
    el.className = j.quality;
    $('#rCombo').textContent = this.combo > 1 ? `×${this.combo}` : '';
    this.river.pilot.input.throttle = Math.max(this.river.pilot.input.throttle, 0.35);
  }

  soundTick(dt, st, now) {
    const r = this.river, a = r.audio, m = this.mission, inp = r.pilot.input;
    if (this.chant) {
      // the throttle sets the cadence; paddling in time pushes harder
      const bpm = Math.round(32 + 30 * Math.max(0, inp.throttle));
      if (Math.abs(bpm - this.chant.bpm) >= 3) { this.chant.bpm = bpm; a.setTempo(bpm); }
      // two catches gone by without a stroke: the crew loses heart
      const idle = a.now - this.chant.lastCatch > 2.2 * (60 / this.chant.bpm);
      this.rhythm = Math.max(0, this.rhythm - dt * (idle ? 0.12 : 0.02));
      if (idle && this.combo) { this.combo = 0; $('#rCombo').textContent = ''; }
      inp.boost = 1 + 0.35 * this.rhythm;
      $('#rhythm').style.setProperty('--fire', this.rhythm.toFixed(2));
    } else if ((this.engineT = (this.engineT ?? 0) - dt) <= 0) {
      this.engineT = 0.1;
      a.engine(true, Math.abs(inp.throttle));
    }
    // the villages drum as you come by
    for (const v of r.world.villages) {
      if (this.announced.has(v)) continue;
      const dx = v.centre.x - st.x, dz = v.centre.z - st.z, d = Math.hypot(dx, dz);
      if (d > 320) continue;
      this.announced.add(v);
      const rel = Math.atan2(dz, dx) - st.heading, pan = clamp(Math.sin(rel), -0.9, 0.9);
      const next = m.stops?.find((S) => m.alongSign * (S.s - m.channel.sample(st.x, st.z).s) > 200);
      const msgs = [
        ['HL.HL-HHL', 'Pirogue en vue ! Mbote, Boyei malamu !'],
        ['HH.LL-HL.HL', 'Les pêcheurs sont rentrés : il y a du poisson frais au village.'],
        ['LH.LH-HH', next ? `${next.name} est à ${fmtKm(Math.abs(next.s - m.channel.sample(st.x, st.z).s) * m.scale)} en suivant le fleuve.` : 'Bon voyage sur le fleuve !'],
      ];
      const [pat, txt] = msgs[this.announced.size % msgs.length];
      this.drum(pat, `Le village sur la rive ${pan > 0 ? 'droite' : 'gauche'} : « ${txt} »`, pan);
      break;
    }
    // the storm of the trip
    const sp = this.stormPlan;
    if (sp) {
      const x = m.end ? m.progress(st) : st.time;
      const warnAt = m.end ? sp.at - 0.06 : sp.at - 25;
      if (!sp.warned && x >= warnAt) { sp.warned = true; this.drum('HHHH.LLLL-HHHH', 'Orage en approche ! Attachez les bâches, serrez la berge.'); }
      if (!sp.on && x >= sp.at) { sp.on = true; r.weather.setStorm(1); }
      if (sp.on && !sp.off && x >= (m.end ? sp.at + 0.3 : sp.at + 150)) { sp.off = true; r.weather.setStorm(0); this.drum('HL.HL', 'L’orage est passé. Le fleuve se calme.'); }
    }
  }

  // a message on the lokolé, the slit drum of the riverside villages
  drum(pattern, text, pan = 0) {
    const a = this.river?.audio;
    const dur = a ? a.lokole(pattern, { pan, gain: 0.9 }) : 1;
    $('#drumText').textContent = text;
    const el = $('#drum');
    el.hidden = false;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(this.drumTimer);
    this.drumTimer = setTimeout(() => (el.hidden = true), Math.max(5000, dur * 1000 + 3500));
  }

  // names floating over the 3D view: the stops on their bank, the rival crews
  buildLabels() {
    const box = $('#labels'), m = this.mission, ch = m.channel, W = ch.halfWidth;
    this.labels = [];
    for (const st of m.labels ?? []) {
      const el = document.createElement('div');
      el.className = 'lbl stop';
      el.innerHTML = `${st.name}<em></em>`;
      box.append(el);
      const q = ch.point(st.s, (st.side || 1) * (W + Math.min(40, W * 0.3 + 4)));
      this.labels.push({ el, pos: { x: q.x, y: Math.min(30, 6 + W * 0.02), z: q.z }, stop: st });
    }
    for (const rv of this.race?.rivals ?? []) {
      const el = document.createElement('div');
      el.className = 'lbl team';
      el.innerHTML = `<i style="background:${rv.team.color}"></i>${rv.team.name}`;
      box.append(el);
      this.labels.push({ el, rival: rv });
    }
  }

  updateLabels(st) {
    const r = this.river, cam = r.camera, w = this.viewer.clientWidth, h = this.viewer.clientHeight;
    const v = this.v3 ??= new (r.camera.position.constructor)();
    const m = this.mission, c = m.channel.sample(st.x, st.z), here = m.geo(st);
    for (const L of this.labels) {
      if (L.rival) { const p = L.rival.pos; if (!p) continue; v.set(p.x, 3.6, p.z); } else v.set(L.pos.x, L.pos.y, L.pos.z);
      const dist = v.distanceTo(cam.position);
      v.project(cam);
      const show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && dist < (L.rival ? 900 : 6000);
      L.el.style.display = show ? '' : 'none';
      if (!show) continue;
      L.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
      L.el.style.opacity = String(clamp(1.4 - dist / (L.rival ? 900 : 6000), 0.35, 1));
      if (L.stop) L.el.querySelector('em').textContent = fmtKm(m.crossing ? haversine(here, L.stop.coord) : Math.abs(L.stop.s - c.s) * m.scale);
    }
    // the villagers waving at you call out
    const box = $('#labels');
    this.bubbles ??= ['Mbote !', 'Mbote na yo !', 'Boyei malamu !', 'Tokende !'].map((t) => { const el = document.createElement('div'); el.className = 'lbl bubble'; el.textContent = t; box.append(el); return el; });
    const waving = r.villagers.slots.filter((s) => s.person?.pose === 'wave');
    this.bubbles.forEach((el, k) => {
      const s = waving[k];
      if (!s) { el.style.display = 'none'; return; }
      v.set(s.x, s.y + 2.1, s.z).project(cam);
      if (v.z > 1) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    });
  }

  showCard(stop, kind) {
    $('#cKind').textContent = kind;
    $('#cName').textContent = stop.name;
    $('#cText').textContent = stop.text ?? '';
    const card = $('#card');
    card.hidden = false;
    card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
    clearTimeout(this.cardTimer);
    this.cardTimer = setTimeout(() => (card.hidden = true), 9000);
  }

  flash(msg) {
    this.flashMsg = msg;
    this.flashUntil = performance.now() + 2500;
  }

  setTimeScale(ts) {
    if (this.river) this.river.pilot.timeScale = ts;
    document.querySelectorAll('[data-ts]').forEach((b) => b.classList.toggle('on', +b.dataset.ts === ts));
  }

  cycleCamera() {
    const order = ['chase', 'onboard', 'orbit'], names = { chase: 'Poursuite', onboard: 'À bord', orbit: 'Orbite' };
    const next = order[(order.indexOf(this.river.mode) + 1) % order.length];
    if (next === 'orbit') {
      // orbit around where the boat is now
      const g = this.river.pirogue.group.position;
      this.river.controls.target.set(g.x, 1, g.z);
      this.river.camera.position.set(g.x - 20, 9, g.z + 18);
    }
    this.river.mode = next;
    this.river.controls.enabled = next === 'orbit';
    if (next !== 'onboard') this.river.pirogue.firstPerson(false);
    $('#vMode').textContent = names[next];
  }

  tick(dt, now) {
    const pilot = this.river.pilot, inp = pilot.input, m = this.mission;
    // a key on the guided visit takes the helm from the autopilot
    if (this.autoOn && this.held.size) { this.autoOn = false; this.flash('Tu as la barre · P pour rendre la main au pilote'); }
    if (this.countdown > 0) {
      this.countdown -= dt;
      const cd = $('#countdown'), n = Math.ceil(this.countdown - 0.6);
      cd.hidden = false;
      cd.textContent = n > 0 ? n : 'Partez !';
      cd.classList.toggle('go', n <= 0);
      inp.throttle = 0;
      if (this.countdown <= 0.6 && !this.race.started) { this.race.started = true; pilot.timeScale = this.ts; }
      if (this.countdown <= 0) cd.hidden = true;
    } else if (this.autoOn && !pilot.arrived) {
      const a = this.auto();
      inp.throttle += (a.throttle - inp.throttle) * Math.min(1, dt * 1.5);
      inp.steer += (a.steer - inp.steer) * Math.min(1, dt * 6);
    } else {
      if (this.held.has('up')) inp.throttle = Math.min(1, inp.throttle + dt * 0.7);
      if (this.held.has('down')) inp.throttle = Math.max(-0.4, inp.throttle - dt * 0.9);
      const steer = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
      inp.steer += (steer - inp.steer) * Math.min(1, dt * 6);
    }

    const st = pilot.status();
    const geo = m.geo(st), remaining = m.remaining(st);
    this.soundTick(dt, st, now);
    if (this.race) {
      this.race.update(dt, this.river.time);
      const rows = this.race.standings({ u: m.progress(st), finished: st.arrived ? st.time + this.race.penalty : null });
      this.standings = rows;
      const ol = $('#hRank');
      ol.hidden = false;
      ol.innerHTML = rows.map((x) => `<li class="${x.you ? 'you' : ''}"><i style="background:${x.color}"></i>${x.name}<span>${x.finished != null ? fmtTime(x.finished * m.scale) : `${Math.round(x.u * 100)} %`}</span></li>`).join('');
      const ev = this.race.lastEvent;
      if (ev && ev !== this.lastEvent) { this.lastEvent = ev; this.flash(ev.ok ? `Bouée ${this.race.passed}/${this.race.gates.length} ✓` : `Bouée manquée ! +15 s`); }
    }
    if (this.auto) {
      // cards at the stops the visit passes
      const c = m.channel.sample(st.x, st.z);
      for (const S of m.stops) {
        if (this.cardShown.has(S.k) || S.name === m.from.name || S.name === m.to?.name) continue;
        if (Math.abs(S.s - c.s) < Math.max(120, m.channel.halfWidth * 1.2)) { this.cardShown.add(S.k); this.showCard(S, 'Étape du parcours'); }
      }
    }
    this.updateLabels(st);
    $('#hDist').textContent = remaining == null ? '—' : fmtKm(st.arrived ? 0 : remaining);
    $('#hSpeed').textContent = Math.round(st.speedGround * 3.6);
    $('#hTime').textContent = fmtTime((st.time + (this.race?.penalty ?? 0)) * m.scale);
    $('#hMsg').textContent = this.flashUntil > now ? this.flashMsg
      : this.countdown > 0 ? 'Prépare-toi… les gaz au signal !'
      : this.autoOn ? 'Pilote automatique · une touche pour prendre la barre'
      : st.grounded ? 'Échoué ! Recule (▼) et barre pour repartir.'
      : st.throttle === 0 && st.time < 1 ? 'Z / ▲ pour mettre les gaz, Q D / ◀ ▶ pour barrer'
        : `Courant ${st.current.toFixed(1).replace('.', ',')} m/s vers l'aval · ${PIROGUES[this.river.pirogue.kind].motor ? 'moteur' : 'pagaie'} ${Math.round(Math.max(0, st.throttle) * 100)} %`;
    if (st.bearingToEnd != null) {
      // along a river the arrow follows the bed (the landing may be round a bend), straight at it once close
      let b = st.bearingToEnd;
      if (!m.crossing && st.remaining > m.channel.halfWidth * 3) {
        const c = m.channel.sample(st.x, st.z), q = m.channel.point(c.s + m.alongSign * Math.min(Math.abs(m.end.s - c.s), Math.max(60, m.channel.halfWidth * 1.5)), m.end.d * 0.5 + c.d * 0.5);
        b = Math.atan2(q.z - st.z, q.x - st.x);
      }
      $('#hArrow').style.transform = `rotate(${b - st.heading}rad)`;
    }
    const g = $('#hThrottle'), zero = 0.4 / 1.4;
    g.style.left = `${(st.throttle >= 0 ? zero : zero + st.throttle / 1.4) * 100}%`;
    g.style.width = `${(Math.abs(st.throttle) / 1.4) * 100}%`;
    this.drawRadar(st);

    // the real map, ~10 times a second
    if (now - this.lastMap > 100) {
      this.lastMap = now;
      this.tour.setBoat(geo, m.bearing(st, st.heading));
      if (haversine(this.trail.at(-1), geo) > 3) {
        this.trail.push(geo);
        this.tour.setPilotTrail(this.trail);
      }
      if (this.viewer.classList.contains('pip') && $('#follow').checked) this.tour.follow(geo);
    }

    if (st.arrived && !this.arrivedShown) {
      this.arrivedShown = true;
      this.trail.push(m.to.coord);
      this.tour.setPilotTrail(this.trail);
      let real = 0;
      for (let i = 1; i < this.trail.length; i++) real += haversine(this.trail[i - 1], this.trail[i]);
      $('#aTitle').textContent = `Bienvenue à ${m.to.name} !`;
      $('#aText').textContent = m.crossing
        ? `${m.title} en ${fmtTime(st.time * m.scale)}. Tu as parcouru ${fmtKm(real)} pour ${fmtKm(m.dist)} à vol d'oiseau : la différence, c’est le courant qui t'a déporté.`
        : `${m.title} : ${fmtKm(m.dist)} ${m.downstream ? 'au fil du courant' : 'à contre-courant'} en ${fmtTime(st.time * m.scale)}, soit ${(m.dist / Math.max(1, st.time * m.scale) * 3.6).toFixed(1).replace('.', ',')} km/h de moyenne.`;
      if (this.race) {
        // finish order; crews still on the water get the time they're heading for
        const rows = this.race.standings({ u: 1, finished: st.time + this.race.penalty })
          .map((x) => ({ ...x, t: x.finished ?? (pilot.time / Math.max(0.05, x.u)) }));
        rows.sort((a, b) => a.t - b.t);
        const rank = rows.findIndex((x) => x.you) + 1;
        $('#aTitle').textContent = rank === 1 ? `Victoire à ${m.to.name} !` : `${rank}e place à ${m.to.name}`;
        $('#aText').textContent = `${fmtKm(m.dist)} ${m.crossing ? 'de traversée' : m.downstream ? 'au fil du courant' : 'à contre-courant'} · ${this.race.passed - this.race.missed}/${this.race.gates.length} bouées${this.race.penalty ? ` (+${this.race.penalty} s de pénalité)` : ''}.`;
        $('#aTable').innerHTML = rows.map((x, k) => `<tr class="${x.you ? 'you' : ''}"><td>${k + 1}</td><td><i style="background:${x.color}"></i>${x.name}</td><td>${x.finished != null || x.you ? '' : '≈ '}${fmtTime(x.t * m.scale)}</td></tr>`).join('');
        $('#aTable').hidden = false;
      } else if (this.auto) {
        $('#aText').textContent = `Fin de la visite : ${fmtKm(m.dist)} ${m.crossing ? 'd’une rive à l’autre' : 'sur le fleuve'} en ${fmtTime(st.time * m.scale)}.`;
      }
      $('#arrive').hidden = false;
      pilot.input.throttle = 0;
      this.autoOn = false;
    }
  }

  // a plan of the trip: north up for a crossing, the direction of travel up along a river.
  // It shows the whole trip when it fits at a readable scale, else a window around the boat.
  drawRadar(st) {
    const ctx = this.radar, m = this.mission, p = PRESETS[m.sceneKey], S = 320, W = p.halfWidth;
    const pts = [m.start, m.end ?? m.start, st].map((P) => m.plan(P));
    const minX = Math.min(...pts.map((q) => q[0])), maxX = Math.max(...pts.map((q) => q[0]));
    const minY = Math.min(...pts.map((q) => q[1])), maxY = Math.max(...pts.map((q) => q[1]));
    const win = Math.max(300, W * 6);
    let span = Math.max(maxX - minX, maxY - minY, 300) * 1.35, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    if (span > win * 1.5) { span = win; [cx, cy] = pts[2]; }
    const sc = S / span, X = (q) => S / 2 + (q[0] - cx) * sc, Y = (q) => S / 2 - (q[1] - cy) * sc;
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#25331f';
    ctx.fillRect(0, 0, S, S);
    // the modelled channel around what is shown
    const ch = m.channel, here = ch.sample(st.x, st.z);
    const a = Math.max(0, here.s - span * 2.5), b = Math.min(ch.length, here.s + span * 2.5);
    const left = [], right = [];
    for (let i = 0; i <= 120; i++) {
      const s = a + ((b - a) * i) / 120;
      left.push(m.plan(ch.point(s, -W)));
      right.push(m.plan(ch.point(s, W)));
    }
    ctx.beginPath();
    [...left, ...right.reverse()].forEach((q, i) => (i ? ctx.lineTo(X(q), Y(q)) : ctx.moveTo(X(q), Y(q))));
    ctx.closePath();
    ctx.fillStyle = '#7a5532';
    ctx.fill();
    // trace, start, landing, boat
    const tr = this.river.pilot.trail.map(([x, z]) => m.plan({ x, z }));
    tr.push(pts[2]);
    ctx.strokeStyle = '#f7d618'; ctx.lineWidth = 3; ctx.setLineDash([6, 6]);
    ctx.beginPath(); tr.forEach((q, i) => (i ? ctx.lineTo(X(q), Y(q)) : ctx.moveTo(X(q), Y(q)))); ctx.stroke();
    ctx.setLineDash([]);
    const dotAt = (q, col, r) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(q), Y(q), r, 0, Math.PI * 2); ctx.fill(); };
    dotAt(pts[0], '#ffffff', 7);
    if (m.end) {
      // the landing, or an arrow on the edge pointing to it
      const q = pts[1], ex = X(q), ey = Y(q);
      if (ex > 10 && ex < S - 10 && ey > 10 && ey < S - 10) { dotAt(q, '#f7d618', 11); dotAt(q, '#ce1021', 5); }
      else {
        const a = Math.atan2(ey - S / 2, ex - S / 2), k = (S / 2 - 18) / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
        ctx.save(); ctx.translate(S / 2 + Math.cos(a) * k, S / 2 + Math.sin(a) * k); ctx.rotate(a);
        ctx.fillStyle = '#f7d618'; ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -10); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
    const v = m.planDir(Math.cos(st.heading), Math.sin(st.heading));
    ctx.save();
    ctx.translate(X(pts[2]), Y(pts[2]));
    ctx.rotate(Math.atan2(v[0], v[1]));
    ctx.fillStyle = '#fff6e0'; ctx.strokeStyle = '#140f0a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(8, 12); ctx.lineTo(-8, 12); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // north (crossings) and the current
    if (m.north) { ctx.fillStyle = '#f3ebde'; ctx.font = 'bold 22px Inter, sans-serif'; ctx.fillText('N', S - 30, 30); }
    ctx.save();
    ctx.translate(40, S - 36);
    const f = m.planDir(here.fx, here.fz);
    ctx.rotate(Math.atan2(f[0], f[1]));
    ctx.strokeStyle = '#3fa7d6'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, 18); ctx.lineTo(0, -16); ctx.moveTo(-8, -6); ctx.lineTo(0, -16); ctx.lineTo(8, -6); ctx.stroke();
    ctx.restore();
  }

  exit(showMap = false) {
    if (!this.active) return;
    this.active = false;
    this.cleanup();
    cancelAnimationFrame(this.raf);
    this.held.clear();
    this.river.pilot.stop();
    this.river.setMode('orbit');
    $('#pilotHud').hidden = true;
    this.viewer.classList.remove('piloting');
    // back to the map screen; showMap: frame the trace just sailed
    this.onExit?.(showMap, this.trail);
  }
}
