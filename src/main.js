import { ROUTES } from './data/routes.js';
import { TourMap } from './map.js';
import { PRESETS } from './water/presets.js';
import { PIROGUES } from './water/pirogues.js';
import { PilotUI, placeChannel } from './pilot.js';

const $ = (s) => document.querySelector(s);
const fmtKm = (m) => (m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000).toLocaleString('fr-FR')) + ' km';
function fmtDuration(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 48) return `${h} h ${String(m).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}
const panelPad = () => (matchMedia('(max-width: 820px)').matches
  ? { top: 40, bottom: 40, left: 30, right: 30 }
  : { top: 60, bottom: 60, left: 60, right: Math.min(520, innerWidth * 0.3) });

// --- map -----------------------------------------------------------------------------------
const tour = new TourMap($('#map'), ROUTES);
if (import.meta.env.DEV) window.__tour = tour;
const state = { route: null, s: 0, playing: false, speed: 1, current: -1, last: 0 };

// --- 3D viewer (lazy: three.js and the bake only load when first opened) -------------------
let river = null, riverLoading = null;
const viewer = $('#viewer');
viewer.hidden = true;
async function ensureRiver() {
  if (river) return river;
  riverLoading ??= import('./water/RiverScene.js').then(({ RiverScene }) => (river = new RiverScene($('#three'))));
  if (import.meta.env.DEV) riverLoading.then((r) => (window.__river = r));
  return riverLoading;
}

function hourToSun(h) {
  // close to the equator the sun climbs almost straight up: ~6 h sunrise, ~18 h sunset
  const elev = 82 * Math.sin((Math.PI * (h - 6.1)) / 12);
  return { elev, azim: h < 12 ? 95 + (h - 6) * 4 : 265 - (18 - h) * 4 };
}
function sunToHour(elev, azim) {
  const x = (Math.asin(Math.max(-1, Math.min(1, elev / 82))) * 12) / Math.PI;
  return azim > 180 ? 18.1 - x : 6.1 + x;
}
const fmtHour = (h) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;

// the 3D view of a place: a stop of the route shows the real river around it (its OSM course),
// a bare preset the procedural stretch; a mission passes its own channel
async function showPlace(stop, sceneKey, mission = null) {
  viewer.hidden = false;
  $('#vOpen').hidden = true;
  const r = await ensureRiver();
  await r.ready;
  r.audio.resume();
  r.audio.setMaster(soundOn ? 0.8 : 0);
  const kind = mission?.kind ?? ($('#pirogue').value || state.route?.pirogue || PRESETS[sceneKey].pirogue);
  $('#vPlace').textContent = stop?.name ?? PRESETS[sceneKey].label;
  $('#vScene').textContent = `${PRESETS[sceneKey].label} · ${PIROGUES[kind].label}`;
  $('#vNote').textContent = stop?.text ?? '';
  $('#preset').value = sceneKey;
  if (!mission?.kind) $('#pirogue').value = kind;
  const i = state.route ? state.route.stops.indexOf(stop) : -1;
  const placeId = mission ? `mission:${Math.random()}` : i >= 0 && stop.scene === sceneKey ? `${state.route.id}:${i}` : sceneKey;
  if (r.placeId !== placeId) {
    let opts = mission ?? {};
    if (!mission && i >= 0 && stop.scene === sceneKey) {
      try { opts = placeChannel(tour, state.route, i) ?? {}; } catch (e) { console.warn('placeChannel', e); opts = {}; }
    }
    r.setPlace(sceneKey, kind, opts);
    r.placeId = placeId;
  }
  if (r.key === sceneKey && r.lastScene !== sceneKey) {
    r.lastScene = sceneKey;
    const p = PRESETS[sceneKey];
    const h = sunToHour(p.sun.elev, p.sun.azim);
    $('#hour').value = h;
    $('#hourOut').textContent = fmtHour(h);
  }
  r.start();
}
function closeViewer() {
  viewer.hidden = true;
  viewer.classList.replace('full', 'pip');
  $('#vExpand').textContent = '⤢';
  $('#vOpen').hidden = !state.route;
  river?.stop();
  river?.audio.setMaster(0);
}

$('#vClose').onclick = () => { pilotUI.exit(); closeViewer(); };
$('#vOpen').onclick = () => {
  const st = state.route?.stops[Math.max(0, state.current)];
  showPlace(st, st?.scene ?? 'fleuve');
};
let soundOn = true;
$('#vSound').onclick = () => {
  soundOn = !soundOn;
  river?.audio.setMaster(soundOn ? 0.8 : 0);
  if (soundOn) river?.audio.resume();
  $('#vSound').classList.toggle('off', !soundOn);
  $('#vSound').setAttribute('aria-pressed', soundOn);
  $('#vSound').setAttribute('aria-label', soundOn ? 'Couper le son' : 'Remettre le son');
};
$('#vExpand').onclick = () => {
  const full = viewer.classList.toggle('full');
  viewer.classList.toggle('pip', !full);
  $('#vExpand').textContent = full ? '⤡' : '⤢';
};
$('#vMode').onclick = () => {
  if (!river) return;
  if (pilotUI.active) return pilotUI.cycleCamera();
  const onboard = river.mode !== 'onboard';
  river.setMode(onboard ? 'onboard' : 'orbit');
  $('#vMode').textContent = onboard ? 'Orbite' : 'À bord';
};
for (const [k, p] of Object.entries(PRESETS)) $('#preset').add(new Option(p.label, k));
for (const [k, p] of Object.entries(PIROGUES)) $('#pirogue').add(new Option(p.label, k));
$('#pirogue').value = '';
$('#pirogue').onchange = (e) => {
  river?.setPirogue(e.target.value);
  $('#vScene').textContent = `${PRESETS[river.key].label} · ${PIROGUES[e.target.value].label}`;
};
$('#preset').onchange = (e) => showPlace({ name: $('#vPlace').textContent, text: $('#vNote').textContent }, e.target.value);
$('#hour').oninput = (e) => {
  const h = +e.target.value, s = hourToSun(h);
  $('#hourOut').textContent = fmtHour(h);
  river?.setSun(s.elev, s.azim);
};
$('#flow').oninput = (e) => {
  $('#flowOut').textContent = `×${(+e.target.value).toFixed(2).replace(/\.?0+$/, '')}`;
  river?.setFlowScale(+e.target.value);
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewer.classList.contains('full') && !pilotUI.active) $('#vExpand').click();
});

// --- route list & detail ---------------------------------------------------------------------
function renderList() {
  $('#routes').innerHTML = '';
  for (const r of ROUTES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'route';
    const km = tour.tracks?.[r.id]?.length;
    b.innerHTML = `<span class="bar" style="background:${r.color}"></span>
      <span><b>${r.name}</b><small>${r.tagline}</small></span>
      <span class="km">${km ? fmtKm(km) : ''}<em>${r.boat.split(' (')[0]}</em></span>`;
    b.onclick = () => selectRoute(r.id);
    $('#routes').append(b);
  }
}

function selectRoute(id) {
  const r = ROUTES.find((x) => x.id === id);
  if (!r || !tour.tracks) return;
  pause();
  pilotUI.exit();
  state.route = r;
  $('#pirogue').value = r.pirogue;
  if (river?.pirogue && river.pirogue.kind !== r.pirogue) river.setPirogue(r.pirogue);
  state.s = 0;
  state.current = -1;
  const track = tour.tracks[r.id];
  $('#routes').hidden = true;
  $('#detail').hidden = false;
  $('#dName').textContent = r.name;
  $('#dTag').textContent = r.tagline;
  $('#dKm').textContent = fmtKm(track.length);
  $('#dDur').textContent = r.duration;
  $('#dBoat').textContent = r.boat;
  $('#dText').textContent = r.text;
  $('#detail').style.setProperty('--c', r.color);
  tour.select(r, panelPad());

  const ol = $('#stops');
  ol.innerHTML = '';
  r.stops.forEach((st, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', r.color);
    li.innerHTML = `<h3>${st.name}</h3><p>${st.text}</p>
      <div class="acts"><button type="button" data-a="map">Sur la carte</button><button type="button" data-a="view">Voir l'eau en 3D</button></div>`;
    li.querySelector('[data-a=map]').onclick = () => gotoStop(i, false);
    li.querySelector('[data-a=view]').onclick = () => gotoStop(i, true);
    ol.append(li);
  });
  updateReadout();
  pilotUI.fill(r);
  setCurrent(0, !viewer.hidden);
  $('#vOpen').hidden = !viewer.hidden;
  $('#panel').scrollTop = 0;
}

function gotoStop(i, open3d) {
  const r = state.route;
  pause();
  state.s = tour.stopAlong[i];
  tour.setProgress(state.s);
  updateReadout();
  setCurrent(i, open3d || !viewer.hidden);
  tour.flyTo(r.stops[i].coord, r.id === 'grand-fleuve' || r.id === 'estuaire' ? 11 : 14);
}

function setCurrent(i, show3d) {
  const r = state.route;
  if (i === state.current) return;
  state.current = i;
  tour.setStops(i);
  [...$('#stops').children].forEach((li, k) => {
    li.classList.toggle('current', k === i);
    li.classList.toggle('passed', k < i);
  });
  const st = r.stops[i];
  if (show3d) showPlace(st, st.scene);
}

function toast(stop) {
  const t = $('#toast');
  t.innerHTML = `<b>${stop.name}</b> — ${stop.text}`;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 4200);
}

$('#back').onclick = () => {
  pause();
  $('#detail').hidden = true;
  $('#routes').hidden = false;
};

// --- playback ----------------------------------------------------------------------------------
// simulated time runs so the whole route plays in about a minute at ×1, whatever its length
function timeScale() {
  const r = state.route, len = tour.tracks[r.id].length;
  return (len / (r.kmh / 3.6)) / 60;
}
function updateReadout() {
  const r = state.route, len = tour.tracks[r.id].length;
  $('#rKm').textContent = `${fmtKm(state.s)} / ${fmtKm(len)}`;
  $('#rTime').textContent = fmtDuration(state.s / (r.kmh / 3.6));
  const next = tour.stopAlong.findIndex((d) => d > state.s + 1);
  $('#rNext').textContent = next >= 0 ? `→ ${r.stops[next].name} (${fmtKm(tour.stopAlong[next] - state.s)})` : 'Arrivée';
  $('#scrub').value = Math.round((state.s / len) * 1000);
}
function stopIndexAt(s) {
  let k = 0;
  tour.stopAlong.forEach((d, i) => { if (s >= d - 1) k = i; });
  return k;
}

function tick(now) {
  if (!state.playing) return;
  const dt = Math.min(0.1, (now - state.last) / 1000);
  state.last = now;
  const r = state.route, len = tour.tracks[r.id].length;
  const speedMs = (r.kmh / 3.6) * timeScale() * state.speed;
  state.s = Math.min(len, state.s + speedMs * dt);
  const p = tour.setProgress(state.s);
  if ($('#follow').checked) tour.follow(p);
  const k = stopIndexAt(state.s);
  if (k !== state.current) {
    setCurrent(k, !viewer.hidden);
    toast(r.stops[k]);
  }
  updateReadout();
  if (state.s >= len) { pause(); return; }
  requestAnimationFrame(tick);
}
function play() {
  if (!state.route) return;
  const len = tour.tracks[state.route.id].length;
  if (state.s >= len) { state.s = 0; state.current = -1; setCurrent(0, !viewer.hidden); }
  state.playing = true;
  state.last = performance.now();
  $('#play').textContent = '❚❚ Pause';
  if ($('#follow').checked) tour.map.easeTo({ zoom: Math.max(tour.map.getZoom(), state.route.id === 'grand-fleuve' ? 8.5 : 12.5), duration: 800 });
  requestAnimationFrame(tick);
}
function pause() {
  state.playing = false;
  $('#play').textContent = '▶ Naviguer';
}
$('#play').onclick = () => (state.playing ? pause() : play());
document.querySelectorAll('[data-speed]').forEach((b) => {
  b.onclick = () => {
    state.speed = +b.dataset.speed;
    document.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('on', x === b));
  };
});
$('#scrub').oninput = (e) => {
  const len = tour.tracks[state.route.id].length;
  state.s = (+e.target.value / 1000) * len;
  tour.setProgress(state.s);
  setCurrent(stopIndexAt(state.s), !viewer.hidden);
  updateReadout();
};

document.querySelectorAll('.layer-toggle button').forEach((b) => {
  b.onclick = () => {
    tour.setSatellite(b.dataset.base === 'sat');
    document.querySelectorAll('.layer-toggle button').forEach((x) => x.classList.toggle('on', x === b));
  };
});

// --- piloting: steer the pirogue yourself from stop X to stop Y -------------------------------
const pilotUI = new PilotUI({
  tour, viewer, ensureRiver, showPlace,
  getRoute: () => state.route,
  onStart: () => pause(),
  onExit: () => { tour.setProgress(state.s); $('#vMode').textContent = 'À bord'; },
});
if (import.meta.env.DEV) window.__ui = pilotUI;

tour.on('route', selectRoute);
tour.on('stop', (i) => gotoStop(i, true));

renderList();
tour.ready.then(() => {
  renderList();
  const id = new URLSearchParams(location.search).get('parcours');
  if (id) selectRoute(id);
  if (new URLSearchParams(location.search).has('3d')) $('#vOpen').click();
});
