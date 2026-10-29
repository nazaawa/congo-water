// Builds public/data/*.geojson from OpenStreetMap (Overpass API).
//
//   npm run geo
//
// 1. Downloads the Congo river centreline (and its side channels) between the estuary
//    and Kisangani, plus the rivers that cross Kinshasa.
// 2. Turns every river way into a graph (shared OSM nodes = shared coordinates) and
//    finds each tour route with Dijkstra between its waypoints, so the drawn route
//    follows the real river course instead of straight lines.
// 3. Simplifies (Douglas-Peucker) and writes compact GeoJSON for the app.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ROUTES } from '../src/data/routes.js';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OUT = new URL('../public/data/', import.meta.url);
const CACHE = new URL('../.cache/', import.meta.url);
const UA = 'congo-water/0.1 (tour map demo)';

// Kinshasa rivers worth showing (OSM spellings vary, so a regex).
const KIN_BBOX = [-4.62, 15.1, -4.0, 15.75];           // s, w, n, e
const KIN_RIVERS = /^(Ndjili|N'djili|N'Djili|Nsele|N'sele|Lukaya|Lukunga|Funa|Binza|Kalamu|Makelele|Bumbu|Mampeza|Tshenke|Djoué|Lumene|Mai-Ndombe)$/i;
const CONGO_BBOX = [-6.3, 12.1, 2.6, 25.5];
const INKISI_BBOX = [-5.2, 14.7, -4.4, 15.3];

async function overpass(name, query) {
  const file = new URL(`${name}.json`, CACHE);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  // public servers are often at capacity: rotate mirrors with exponential backoff
  let json, wait = 5;
  for (let attempt = 0; !json; attempt++) {
    const server = OVERPASS[attempt % OVERPASS.length];
    console.log(`overpass: ${name} (${new URL(server).host}) …`);
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(150_000),
    }).catch((e) => ({ ok: false, status: e.message, text: async () => '' }));
    if (res.ok) { json = await res.json(); break; }
    if (attempt >= 7) throw new Error(`overpass ${name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log(`  ${res.status}, retry in ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    wait *= 2;
  }
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(json));
  return json;
}

const bbox = (b) => b.join(',');

// --- geometry helpers ------------------------------------------------------------------
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function lineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}
// Douglas-Peucker in degrees (with longitude scaled by cos(lat), so tolerance is roughly isotropic)
function simplify(coords, tol) {
  if (coords.length < 3) return coords;
  const k = Math.cos(rad(coords[0][1]));
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = coords[a][0] * k, ay = coords[a][1], bx = coords[b][0] * k, by = coords[b][1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-18;
    let best = -1, bestD = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const px = coords[i][0] * k, py = coords[i][1];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return coords.filter((_, i) => keep[i]);
}
const round = (c) => c.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);

// --- river graph -------------------------------------------------------------------------
class RiverGraph {
  constructor(ways, joinGap = 250) {
    this.index = new Map();   // "lon,lat" -> node id
    this.coords = [];
    this.adj = [];
    for (const w of ways) {
      let prev = -1;
      for (const p of w.geometry) {
        const id = this.node([p.lon, p.lat]);
        if (prev >= 0 && prev !== id) {
          const d = haversine(this.coords[prev], this.coords[id]);
          this.adj[prev].push(id, d);
          this.adj[id].push(prev, d);
        }
        prev = id;
      }
    }
    this.joinDangling(joinGap);
  }
  // OSM river ways don't always share their junction node (a tributary ending a few
  // metres off the centreline, a gap between two edits): link every dangling end to
  // the nearest node of another stretch within `gap` metres.
  joinDangling(gap) {
    const cell = gap / 111000, grid = new Map();
    const key = (c) => `${Math.floor(c[0] / cell)},${Math.floor(c[1] / cell)}`;
    this.coords.forEach((c, i) => {
      const k = key(c);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    let joined = 0;
    for (let i = 0; i < this.coords.length; i++) {
      if (this.adj[i].length !== 2) continue;           // not a dead end
      const c = this.coords[i], gx = Math.floor(c[0] / cell), gy = Math.floor(c[1] / cell);
      const near = new Set([i, this.adj[i][0]]);
      let best = -1, bestD = gap;
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
        for (const j of grid.get(`${x},${y}`) ?? []) {
          if (near.has(j)) continue;
          const d = haversine(c, this.coords[j]);
          if (d < bestD) { bestD = d; best = j; }
        }
      }
      if (best >= 0) {
        this.adj[i].push(best, bestD);
        this.adj[best].push(i, bestD);
        joined++;
      }
    }
    if (joined) console.log(`  graph: joined ${joined} dangling ends (≤ ${gap} m)`);
  }
  node(c) {
    const key = `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
    let id = this.index.get(key);
    if (id === undefined) {
      id = this.coords.length;
      this.index.set(key, id);
      this.coords.push(c);
      this.adj.push([]);
    }
    return id;
  }
  nearest(c) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.coords.length; i++) {
      const d = haversine(c, this.coords[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { id: best, dist: bestD };
  }
  // Dijkstra with a binary heap
  path(from, to) {
    const n = this.coords.length;
    const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const heap = [[0, from]];
    dist[from] = 0;
    const push = (e) => {
      heap.push(e);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const [d, u] = pop();
      if (u === to) break;
      if (d > dist[u]) continue;
      const a = this.adj[u];
      for (let k = 0; k < a.length; k += 2) {
        const v = a[k], nd = d + a[k + 1];
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push([nd, v]); }
      }
    }
    if (!Number.isFinite(dist[to])) return null;
    const out = [];
    for (let u = to; u >= 0; u = prev[u]) out.push(this.coords[u]);
    return out.reverse();
  }
}

// --- main ----------------------------------------------------------------------------------
await mkdir(OUT, { recursive: true });

const congo = await overpass('congo', `[out:json][timeout:180];
  way["waterway"="river"]["name"~"^(Congo|Fleuve Congo|Zaïre|Zaire|Rio Congo)$"](${bbox(CONGO_BBOX)});
  out geom;`);
const kin = await overpass('kinshasa', `[out:json][timeout:90];
  way["waterway"~"^(river|stream)$"](${bbox(KIN_BBOX)});
  out geom;`);
const inkisi = await overpass('inkisi', `[out:json][timeout:90];
  way["waterway"="river"]["name"~"Inkisi"](${bbox(INKISI_BBOX)});
  out geom;`);

console.log(`congo ways: ${congo.elements.length}, kinshasa ways: ${kin.elements.length}, inkisi: ${inkisi.elements.length}`);

// 1. Congo centreline for display (simplified per way, it is big)
const congoFeatures = congo.elements.map((w) => ({
  type: 'Feature',
  properties: { name: 'Fleuve Congo', side: w.tags?.['waterway:role'] ?? '' },
  geometry: { type: 'LineString', coordinates: round(simplify(w.geometry.map((p) => [p.lon, p.lat]), 0.0008)) },
}));

// 2. Kinshasa rivers (one feature per way, grouped by a normalised name)
const norm = (n) => n.replace(/^N'?d?j/i, 'N’dj').replace(/^Ndjili$/i, 'N’djili');
const kinWays = kin.elements.filter((w) => KIN_RIVERS.test(w.tags?.name ?? ''));
const kinFeatures = [...kinWays, ...inkisi.elements].map((w) => ({
  type: 'Feature',
  properties: { name: norm(w.tags.name), kind: w.tags.waterway },
  geometry: { type: 'LineString', coordinates: round(simplify(w.geometry.map((p) => [p.lon, p.lat]), 0.00008)) },
}));

await writeFile(new URL('congo.geojson', OUT), JSON.stringify({ type: 'FeatureCollection', features: congoFeatures }));
await writeFile(new URL('rivers-kinshasa.geojson', OUT), JSON.stringify({ type: 'FeatureCollection', features: kinFeatures }));

// 3. Routes along the real river network
// one graph per river (by OSM name), so a route can't shortcut through a stream
const allWays = new Map([...congo.elements, ...kin.elements, ...inkisi.elements].map((w) => [w.id, w]));
const graphCache = new Map();
function graphFor(river) {
  if (!graphCache.has(river)) {
    const re = new RegExp(`^(${river})$`, 'i');
    const ways = [...allWays.values()].filter((w) => re.test(w.tags?.name ?? ''));
    graphCache.set(river, new RiverGraph(ways, river === 'Congo' ? 3000 : 120));
  }
  return graphCache.get(river);
}

const routeFeatures = [];
for (const r of ROUTES) {
  let coords;
  if (r.mode === 'crossing') {
    // a ferry/pirogue crossing goes straight over the water, not along the river
    coords = r.waypoints;
  } else {
    const g = graphFor(r.river);
    coords = [];
    for (let i = 1; i < r.waypoints.length; i++) {
      const a = g.nearest(r.waypoints[i - 1]), b = g.nearest(r.waypoints[i]);
      if (a.dist > 3000 || b.dist > 3000) console.warn(`  ${r.id}: waypoint ${i} snaps ${Math.round(Math.max(a.dist, b.dist))} m away`);
      const leg = g.path(a.id, b.id);
      if (!leg) throw new Error(`${r.id}: no river path between waypoints ${i - 1} and ${i}`);
      coords.push(...(coords.length ? leg.slice(1) : leg));
    }
    // start/end exactly at the landing (beach, port) rather than mid-river
    coords = [r.waypoints[0], ...coords, r.waypoints.at(-1)];
  }
  const tol = r.long ? 0.0015 : 0.00005;
  const simple = round(simplify(coords, tol));
  const km = lineLength(coords) / 1000;
  console.log(`  ${r.id}: ${km.toFixed(1)} km, ${coords.length} → ${simple.length} pts`);
  routeFeatures.push({
    type: 'Feature',
    properties: { id: r.id, km: +km.toFixed(1) },
    geometry: { type: 'LineString', coordinates: simple },
  });
}
await writeFile(new URL('routes.geojson', OUT), JSON.stringify({ type: 'FeatureCollection', features: routeFeatures }));
console.log('done → public/data/');
