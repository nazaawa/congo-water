import { ROUTES } from './data/routes.js';
import { TourMap } from './map.js';
import { PRESETS } from './water/presets.js';
import { PIROGUES } from './water/pirogues.js';
import { PilotUI, placeChannel } from './pilot.js';

// Three screens: the title (over the live 3D river), the map of the real courses where an
// expedition is picked, and the trip itself (the 3D view, full screen, with the piloting HUD).

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmtKm = (m) => (m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000).toLocaleString('fr-FR')) + ' km';
function fmtDuration(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 48) return `${h} h ${String(m).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}
const num = (i) => String(i + 1).padStart(2, '0');
const narrow = () => matchMedia('(max-width: 820px)').matches;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const app = $('#app'), titleEl = $('#title');

// --- map -----------------------------------------------------------------------------------
const tour = new TourMap($('#map'), ROUTES);
if (import.meta.env.DEV) window.__tour = tour;
const state = { screen: 'title', route: null, s: 0, playing: false, speed: 1, current: -1, last: 0 };
// the room the map screen's bar, strip and panel leave on the map
const mapPad = () => (narrow()
  ? { top: 70, bottom: $('#detail').hidden ? 170 : Math.round(innerHeight * 0.62), left: 30, right: 30 }
  : { top: 100, bottom: 210, left: 80, right: $('#detail').hidden ? 80 : 470 });

// --- 3D viewer (three.js and the models load with the title screen) ---------------------------
let river = null, riverLoading = null;
const viewer = $('#viewer');
viewer.hidden = true;
async function ensureRiver() {
  if (river) return river;
  riverLoading ??= import('./water/RiverScene.js').then(({ RiverScene }) => (river = new RiverScene($('#three'))));
  if (import.meta.env.DEV) riverLoading.then((r) => (window.__river = r));
  return riverLoading;
}
// pip (thumbnail over the map), full (full screen), bg (behind the title screen)
function setViewer(kind) {
  viewer.classList.remove('pip', 'full', 'bg', 'out');
  viewer.classList.add(kind);
  $('#vExpand').textContent = kind === 'full' ? '⤡' : '⤢';
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

// the title screen's shot: a fishing pirogue on the forest river, the sun setting behind it
const HERO = { scene: 'fleuve', kind: 'peche', hour: 17.9, cloud: 0.45 };
// landscape: the boat right of the title; portrait: above the menu, seen from further back
const portrait = () => innerWidth < innerHeight * 0.9;
const heroFraming = () => (portrait() ? [0, -0.16] : [0.17, 0.02]);
const heroView = () => ({ swing: reduceMotion ? 0 : 7, dist: portrait() ? 22 : 16 });
let heard = false;      // the page has had a gesture, so it may make sound
const masterLevel = () => (!soundOn ? 0 : state.screen === 'title' ? (heard ? 0.55 : 0) : 0.8);

async function showHero() {
  setViewer('bg');
  viewer.hidden = false;
  let r;
  try {
    r = await ensureRiver();
    await r.ready;
  } catch (e) {
    console.warn('Vue 3D indisponible', e);     // the poster stays
    return;
  }
  if (state.screen !== 'title') return;
  r.maxDpr = 1.25;
  r.setFraming(heroFraming());
  if (r.placeId !== 'hero') {
    r.setPlace(HERO.scene, HERO.kind, { season: null, cloud: HERO.cloud });
    r.placeId = 'hero';
    r.lastScene = null;
  }
  const s = hourToSun(HERO.hour);
  r.setSun(s.elev, s.azim);
  r.hero(heroView());
  r.audio.setMaster(masterLevel());
  r.start();
  $('#tLive').textContent = `${PRESETS[HERO.scene].label} · ${fmtHour(HERO.hour)}`;
  // the poster gives way once the live view has drawn
  requestAnimationFrame(() => requestAnimationFrame(() => titleEl.classList.add('is-live')));
}
function leaveHero(r) {
  if (r.mode === 'hero') r.setMode('orbit');
  if (r.maxDpr !== 2 || r.framing) {
    r.maxDpr = 2;
    r.setFraming(null);
  }
}

// the 3D view of a place: a stop of the route shows the real river around it (its OSM course),
// a bare preset the procedural stretch; a mission passes its own channel
async function showPlace(stop, sceneKey, mission = null) {
  viewer.hidden = false;
  if (viewer.classList.contains('bg')) setViewer('pip');
  $('#vOpen').hidden = true;
  const r = await ensureRiver();
  await r.ready;
  leaveHero(r);
  r.audio.resume();
  r.audio.setMaster(masterLevel());
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
  setViewer('pip');
  $('#vOpen').hidden = !state.route || state.screen !== 'map';
  river?.stop();
  river?.audio.setMaster(0);
}

$('#vClose').onclick = () => { pilotUI.exit(); closeViewer(); };
$('#vOpen').onclick = () => {
  const st = state.route?.stops[Math.max(0, state.current)];
  showPlace(st, st?.scene ?? 'fleuve');
};
$('#vExpand').onclick = () => setViewer(viewer.classList.contains('full') ? 'pip' : 'full');
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

// --- sound ---------------------------------------------------------------------------------------
let soundOn = true;
function setSound(on) {
  soundOn = on;
  if (river) {
    if (on) river.audio.resume();
    river.audio.setMaster(viewer.hidden ? 0 : masterLevel());
  }
  $$('[data-sound]').forEach((b) => {
    b.classList.toggle('off', !on);
    b.setAttribute('aria-pressed', on);
    b.setAttribute('aria-label', on ? 'Couper le son' : 'Remettre le son');
  });
}
$$('[data-sound]').forEach((b) => (b.onclick = () => setSound(!soundOn)));
// browsers keep audio off until the first gesture; the title's river and forest come in then
const firstGesture = () => {
  if (heard) return;
  heard = true;
  if (state.screen === 'title' && river && !viewer.hidden) {
    river.audio.resume();
    river.audio.setMaster(masterLevel());
  }
};
addEventListener('pointerdown', firstGesture);
addEventListener('keydown', firstGesture);

// --- screens ---------------------------------------------------------------------------------------
function setScreen(name) {
  state.screen = name;
  app.dataset.screen = name;
  $('#mapUi').inert = name === 'play';      // under the full-screen trip
}

const BAR_TITLES = { libre: 'Choisis ton expédition', course: 'Choisis le parcours de la course', visite: 'Choisis ta visite guidée' };
let mapIntro = false;
function goMap(mode) {
  if (mode) pilotUI.setMode(mode);
  $('#barTitle').textContent = BAR_TITLES[pilotUI.modeSel];
  setScreen('map');
  $('#mapUi').hidden = false;
  titleEl.classList.add('out');
  if (!viewer.hidden && viewer.classList.contains('bg')) viewer.classList.add('out');
  setTimeout(() => {
    if (state.screen !== 'map') return;
    titleEl.hidden = true;
    if (viewer.classList.contains('bg')) closeViewer();
  }, reduceMotion ? 0 : 700);
  $('#vOpen').hidden = !state.route;
  if (!mapIntro && !state.route) {
    // a slow push in on Kinshasa as the title fades
    mapIntro = true;
    tour.ready.then(() => { if (!state.route) tour.map.easeTo({ zoom: narrow() ? 9.9 : 10.7, duration: reduceMotion ? 0 : 2600 }); });
  }
  setTimeout(() => ($('.qcard.on') ?? $('.qcard'))?.focus({ preventScroll: true }), reduceMotion ? 0 : 450);
}
function goTitle() {
  pause();
  pilotUI.exit();
  closeViewer();
  setScreen('title');
  $('#mapUi').hidden = true;
  $('#vOpen').hidden = true;
  titleEl.hidden = false;
  void titleEl.offsetWidth;
  titleEl.classList.remove('out');
  setLink('');
  showHero();
  selMenu(0, true);
}
$('#toTitle').onclick = goTitle;

// the title menu: a cursor that follows the mouse and the arrow keys
const menu = $$('.menu .m-item');
function selMenu(i, focus = false) {
  menu.forEach((m, k) => m.classList.toggle('sel', k === i));
  if (focus) menu[i].focus({ preventScroll: true });
}
menu.forEach((m, i) => { m.onmouseenter = () => selMenu(i); m.onfocus = () => selMenu(i); });
selMenu(0);
$$('[data-go]').forEach((b) => (b.onclick = () => goMap(b.dataset.go)));
$$('[data-open]').forEach((b) => (b.onclick = () => $(`#${b.dataset.open}`).showModal()));
for (const d of $$('dialog')) {
  // a click on the backdrop closes the dialog
  d.addEventListener('click', (e) => {
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
}
addEventListener('keydown', (e) => {
  if ($('dialog[open]')) return;
  if (state.screen === 'title') {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = Math.max(0, menu.findIndex((m) => m.classList.contains('sel')));
    selMenu((i + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length, true);
  } else if (e.key === 'Escape' && !pilotUI.active) {
    if (viewer.classList.contains('full')) setViewer('pip');
    else if (!$('#detail').hidden) closeQuest();
  }
});
addEventListener('resize', () => {
  if (state.screen === 'title' && river?.mode === 'hero') {
    river.setFraming(heroFraming());
    river.hero(heroView());
  }
});

// --- the expeditions: a strip of cards on the map, a panel for the chosen one ------------------------
const maxFlow = (r) => Math.max(...r.stops.map((st) => PRESETS[st.scene].flow));
const level = (f) => (f >= 5 ? 5 : f >= 2.5 ? 4 : f >= 1.5 ? 3 : f >= 1 ? 2 : 1);
const pips = (n) => `<span class="pips" role="img" aria-label="Courant ${n} sur 5">${[1, 2, 3, 4, 5].map((k) => `<i class="${k <= n ? 'on' : ''}"></i>`).join('')}</span>`;
// the route's shape, north up, for its card
function traceSvg(track) {
  if (!track) return '<svg class="qtrace" aria-hidden="true"></svg>';
  const c = track.coords, k = Math.cos((c[0][1] * Math.PI) / 180), step = Math.max(1, Math.floor(c.length / 90));
  const pts = c.filter((_, i) => i % step === 0 || i === c.length - 1).map(([x, y]) => [x * k, -y]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 || 1e-9, h = Math.max(...ys) - y0 || 1e-9;
  const W = 72, H = 30, sc = Math.min(W / w, H / h), ox = W - w * sc, oy = (H - h * sc) / 2;
  const line = pts.map(([x, y]) => `${(ox + (x - x0) * sc).toFixed(1)},${(oy + (y - y0) * sc).toFixed(1)}`).join(' ');
  return `<svg class="qtrace" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${line}" /></svg>`;
}

function renderList() {
  const row = $('#routes');
  row.innerHTML = '';
  ROUTES.forEach((r, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qcard';
    b.dataset.id = r.id;
    b.style.setProperty('--c', r.color);
    b.classList.toggle('on', state.route?.id === r.id && !$('#detail').hidden);
    const km = tour.tracks?.[r.id]?.length;
    b.innerHTML = `<span class="qtop"><span class="qnum">${num(i)}</span>${traceSvg(tour.tracks?.[r.id])}</span>
      <b>${r.name}</b>
      <span class="qmeta"><span>${km ? fmtKm(km) : '…'} · ${r.stops.length} étapes</span>${pips(level(maxFlow(r)))}</span>`;
    b.onclick = () => selectRoute(r.id);
    b.onmouseenter = b.onfocus = () => tour.highlight(r.id);
    b.onmouseleave = b.onblur = () => tour.highlight(null);
    row.append(b);
  });
}

function setTab(t) {
  $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === t));
  $('#panelPlay').hidden = t !== 'play';
  $('#panelRoute').hidden = t !== 'route';
}
$$('.tabs [data-tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

// conditions as chips; the value goes to the hidden input the piloting reads
for (const g of $$('.cond')) {
  const input = $(`#${g.dataset.for}`), chips = [...g.querySelectorAll('[data-v]')];
  for (const b of chips) {
    b.onclick = () => {
      input.value = b.dataset.v;
      chips.forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
    };
  }
}

function selectRoute(id) {
  const r = ROUTES.find((x) => x.id === id);
  if (!r || !tour.tracks) return;
  pause();
  pilotUI.exit();
  state.route = r;
  $('#pirogue').value = r.pirogue;
  if (river?.pirogue && river.pirogue.kind !== r.pirogue && river.placeId !== 'hero') river.setPirogue(r.pirogue);
  state.s = 0;
  state.current = -1;
  const track = tour.tracks[r.id], i = ROUTES.indexOf(r);
  $('#detail').hidden = false;
  app.classList.add('has-quest');
  $('#dNum').textContent = `Expédition ${num(i)}`;
  $('#dName').textContent = r.name;
  $('#dTag').textContent = r.tagline;
  $('#dKm').textContent = fmtKm(track.length);
  $('#dDur').textContent = r.duration;
  $('#dFlow').textContent = `${maxFlow(r).toFixed(1).replace('.', ',')} m/s`;
  $('#dFlow').title = 'Courant le plus fort du parcours';
  $('#dBoat').textContent = r.boat;
  $('#dText').textContent = r.text;
  $('#detail').style.setProperty('--c', r.color);
  setTab('play');
  for (const b of $$('.qcard')) {
    b.classList.toggle('on', b.dataset.id === r.id);
    if (b.dataset.id === r.id) b.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  tour.select(r, mapPad());

  const ol = $('#stops');
  ol.innerHTML = '';
  r.stops.forEach((st, k) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', r.color);
    li.innerHTML = `<h3>${st.name}</h3><p>${st.text}</p>
      <div class="acts"><button type="button" data-a="map">Sur la carte</button><button type="button" data-a="view">Voir l'eau en 3D</button></div>`;
    li.querySelector('[data-a=map]').onclick = () => gotoStop(k, false);
    li.querySelector('[data-a=view]').onclick = () => gotoStop(k, true);
    ol.append(li);
  });
  updateReadout();
  pilotUI.fill(r);
  setCurrent(0, !viewer.hidden);
  $('#vOpen').hidden = !viewer.hidden;
  $('#detail').scrollTop = 0;
  setLink(`#${r.id}`);
}
// the address names the open expedition (#pool-malebo), so it can be bookmarked or sent
function setLink(hash) {
  try { history.replaceState(null, '', hash || location.pathname); } catch { /* a sandboxed frame may refuse */ }
}

function closeQuest() {
  pause();
  $('#detail').hidden = true;
  app.classList.remove('has-quest');
  for (const b of $$('.qcard')) b.classList.remove('on');
  ($(`.qcard[data-id="${state.route?.id}"]`) ?? $('.qcard'))?.focus({ preventScroll: true });
}
$('#back').onclick = closeQuest;

function gotoStop(i, open3d) {
  const r = state.route;
  pause();
  state.s = tour.stopAlong[i];
  tour.setProgress(state.s);
  updateReadout();
  setCurrent(i, open3d || !viewer.hidden);
  tour.flyTo(r.stops[i].coord, r.long ? 11 : 14);
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

// --- fly-over: the boat runs along the route on the map ----------------------------------------------
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
  $('#play').textContent = '▶ Survoler';
}
$('#play').onclick = () => (state.playing ? pause() : play());
$$('[data-speed]').forEach((b) => {
  b.onclick = () => {
    state.speed = +b.dataset.speed;
    $$('[data-speed]').forEach((x) => x.classList.toggle('on', x === b));
  };
});
$('#scrub').oninput = (e) => {
  const len = tour.tracks[state.route.id].length;
  state.s = (+e.target.value / 1000) * len;
  tour.setProgress(state.s);
  setCurrent(stopIndexAt(state.s), !viewer.hidden);
  updateReadout();
};

$$('.layer-toggle button').forEach((b) => {
  b.onclick = () => {
    tour.setSatellite(b.dataset.base === 'sat');
    $$('.layer-toggle button').forEach((x) => x.classList.toggle('on', x === b));
  };
});

// --- piloting: steer the pirogue yourself from stop X to stop Y -------------------------------
const pilotUI = new PilotUI({
  tour, viewer, ensureRiver, showPlace,
  getRoute: () => state.route,
  onStart: () => { pause(); setScreen('play'); },
  onExit: (showMap, trail) => {
    tour.setProgress(state.s);
    $('#vMode').textContent = 'À bord';
    if (state.screen !== 'play') return;
    setScreen('map');
    closeViewer();
    if (showMap && trail.length > 1) tour.fitCoords(trail, mapPad());
  },
});
if (import.meta.env.DEV) window.__ui = pilotUI;

tour.on('route', selectRoute);
tour.on('stop', (i) => gotoStop(i, true));

// --- start: the title screen, or straight to an expedition (?parcours=…) ------------------------------
renderList();
const params = new URLSearchParams(location.search);
const startId = params.get('parcours') ?? ROUTES.find((r) => `#${r.id}` === location.hash)?.id;
if (startId) {
  setScreen('map');
  titleEl.hidden = true;
  $('#mapUi').hidden = false;
  mapIntro = true;
} else showHero();
tour.ready.then(() => {
  renderList();
  if (tour.offline) $('.layer-toggle').hidden = true;     // neither basemap can be reached
  if (startId) selectRoute(startId);
  if (params.has('3d')) $('#vOpen').click();
});
