import { Map as MLMap, Marker, NavigationControl, ScaleControl, LngLatBounds, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

setWorkerUrl(workerUrl);

// Map of the real courses: OpenFreeMap vector basemap (or Esri imagery), the Congo and
// Kinshasa rivers from OSM, tour routes snapped to the river network (npm run geo),
// and a pirogue marker that travels along the selected route.

const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const PIROGUE_SVG = `<svg viewBox="0 0 24 64" width="18" height="48" aria-hidden="true">
  <path d="M12 1 C17 12 18 30 17 46 C16.5 54 14.5 60 12 63 C9.5 60 7.5 54 7 46 C6 30 7 12 12 1 Z" fill="#5b3a1e" stroke="#f1e9dc" stroke-width="1.5"/>
  <path d="M12 8 C14.6 16 15 30 14.6 44 C14.3 50 13.3 55 12 57 C10.7 55 9.7 50 9.4 44 C9 30 9.4 16 12 8 Z" fill="#8a5a2e"/>
  <circle cx="12" cy="20" r="2.2" fill="#f2b705"/><circle cx="12" cy="33" r="2.2" fill="#d7263d"/><circle cx="12" cy="46" r="2.2" fill="#1b4f9c"/>
</svg>`;

const R = 6371008.8, rad = (d) => (d * Math.PI) / 180;
export function haversine(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// a route as a measured polyline: cumulative distances, point & heading at distance s
export class Track {
  constructor(coords) {
    this.coords = coords;
    this.cum = [0];
    for (let i = 1; i < coords.length; i++) this.cum.push(this.cum[i - 1] + haversine(coords[i - 1], coords[i]));
    this.length = this.cum.at(-1);
  }
  at(s) {
    s = Math.max(0, Math.min(this.length, s));
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    const a = this.coords[lo], b = this.coords[hi], seg = this.cum[hi] - this.cum[lo] || 1, t = (s - this.cum[lo]) / seg;
    return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(a, b), index: lo };
  }
  slice(s) {
    const { point, index } = this.at(s);
    return [...this.coords.slice(0, index + 1), point];
  }
  // distance along the track of the point closest to c
  project(c) {
    let best = 0, bestD = Infinity;
    for (let i = 1; i < this.coords.length; i++) {
      const a = this.coords[i - 1], b = this.coords[i];
      const k = Math.cos(rad(a[1]));
      const dx = (b[0] - a[0]) * k, dy = b[1] - a[1], px = (c[0] - a[0]) * k, py = c[1] - a[1];
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1e-18)));
      const ex = px - t * dx, ey = py - t * dy, d = ex * ex + ey * ey;
      if (d < bestD) { bestD = d; best = this.cum[i - 1] + t * (this.cum[i] - this.cum[i - 1]); }
    }
    return best;
  }
}

export class TourMap {
  constructor(el, routes) {
    this.routes = routes;
    this.map = new MLMap({
      container: el, style: STYLE, center: [15.32, -4.3], zoom: 10.6,
      attributionControl: { compact: true }, maxPitch: 70,
    });
    this.map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');
    this.ready = new Promise((res) => this.map.on('load', () => this.setup().then(res)));
    this.handlers = {};
  }

  on(name, fn) { this.handlers[name] = fn; }
  emit(name, ...a) { this.handlers[name]?.(...a); }

  async setup() {
    const map = this.map;
    const [congo, rivers, routes] = await Promise.all(
      ['congo', 'rivers-kinshasa', 'routes'].map((n) => fetch(`${import.meta.env.BASE_URL}data/${n}.geojson`).then((r) => r.json())),
    );
    this.geo = { congo, rivers };
    this.tracks = {};
    for (const f of routes.features) this.tracks[f.properties.id] = new Track(f.geometry.coordinates);
    routes.features.forEach((f) => { f.properties.color = this.routes.find((r) => r.id === f.properties.id)?.color ?? '#fff'; });

    // basemap labels in French where OSM has them
    for (const l of map.getStyle().layers) {
      const tf = l.type === 'symbol' && map.getLayoutProperty(l.id, 'text-field');
      if (tf && JSON.stringify(tf).includes('name')) {
        map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:fr'], ['get', 'name:latin'], ['get', 'name']]);
      }
    }
    const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    map.addSource('sat', { type: 'raster', tiles: [SAT], tileSize: 256, maxzoom: 19, attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics' });
    map.addLayer({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.1 } }, firstSymbol);

    map.addSource('congo', { type: 'geojson', data: congo });
    map.addSource('rivers', { type: 'geojson', data: rivers });
    map.addSource('routes', { type: 'geojson', data: routes, lineMetrics: true });
    map.addSource('progress', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('pilot-trail', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    map.addLayer({
      id: 'congo-glow', type: 'line', source: 'congo',
      paint: { 'line-color': '#c08a4a', 'line-opacity': 0.35, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2, 9, 6, 13, 10], 'line-blur': 4 },
    }, firstSymbol);
    map.addLayer({
      id: 'rivers-line', type: 'line', source: 'rivers', minzoom: 9,
      paint: { 'line-color': '#3fa7d6', 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 14, 4] },
    }, firstSymbol);
    map.addLayer({
      id: 'routes-all', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 12, 3], 'line-opacity': 0.55, 'line-dasharray': [2, 2] },
    });
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'routes', filter: ['==', ['get', 'id'], ''],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#140f0a', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 5, 12, 10] },
    });
    map.addLayer({
      id: 'route-active', type: 'line', source: 'routes', filter: ['==', ['get', 'id'], ''],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 12, 5] },
    });
    map.addLayer({
      id: 'route-progress', type: 'line', source: 'progress', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fff6e0', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2, 12, 3.5], 'line-opacity': 0.95 },
    });
    map.addLayer({
      id: 'pilot-trail', type: 'line', source: 'pilot-trail', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#f7d618', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 4], 'line-dasharray': [1, 1.5] },
    });
    map.addLayer({
      id: 'rivers-label', type: 'symbol', source: 'rivers', minzoom: 11,
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 12, 'symbol-spacing': 350 },
      paint: { 'text-color': '#1d6f99', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
    });
    map.addLayer({
      id: 'stops', type: 'circle', source: 'stops',
      paint: {
        'circle-radius': ['case', ['get', 'current'], 8, 6], 'circle-color': ['get', 'color'],
        'circle-stroke-color': '#140f0a', 'circle-stroke-width': 2.5,
      },
    });
    map.addLayer({
      id: 'stops-label', type: 'symbol', source: 'stops',
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#1a140e', 'text-halo-color': '#fff8ec', 'text-halo-width': 2 },
    });

    map.on('click', 'routes-all', (e) => this.emit('route', e.features[0].properties.id));
    map.on('click', 'stops', (e) => this.emit('stop', e.features[0].properties.i));
    for (const id of ['routes-all', 'stops']) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }

    const el = document.createElement('div');
    el.className = 'boat-marker';
    el.innerHTML = PIROGUE_SVG;
    this.boat = new Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([15.32, -4.3]);
  }

  setSatellite(on) {
    this.map.setLayoutProperty('sat', 'visibility', on ? 'visible' : 'none');
  }

  select(route, padding) {
    const map = this.map, track = this.tracks[route.id];
    this.route = route;
    this.track = track;
    for (const id of ['route-casing', 'route-active']) map.setFilter(id, ['==', ['get', 'id'], route.id]);
    map.setPaintProperty('routes-all', 'line-opacity', ['case', ['==', ['get', 'id'], route.id], 0, 0.45]);
    this.stopAlong = route.stops.map((s) => track.project(s.coord));
    this.setStops(-1);
    this.setProgress(0);
    const b = new LngLatBounds();
    track.coords.forEach((c) => b.extend(c));
    route.stops.forEach((s) => b.extend(s.coord));
    map.fitBounds(b, { padding, duration: 1600, maxZoom: 14.5 });
    this.boat.addTo(map);
  }

  setStops(current) {
    const r = this.route;
    this.map.getSource('stops').setData({
      type: 'FeatureCollection',
      features: r.stops.map((s, i) => ({ type: 'Feature', properties: { name: s.name, i, color: r.color, current: i === current }, geometry: { type: 'Point', coordinates: s.coord } })),
    });
  }

  // put the boat at distance s (metres) along the route; returns its position
  setProgress(s) {
    const { point, heading } = this.track.at(s);
    this.boat.setLngLat(point).setRotation(heading);
    this.map.getSource('progress').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: this.track.slice(s) } });
    return point;
  }

  // downstream unit vector [east, north] (and the nearest centreline point) of the river named `river` (regex source) near
  // `coord`: OSM draws waterways in the direction they flow
  riverDirection(coord, river = 'Congo') {
    const re = new RegExp(`^(${river})$`, 'i');
    const feats = /congo/i.test(river) ? this.geo.congo.features : this.geo.rivers.features.filter((f) => re.test(f.properties.name.replace('’', "'")));
    const k = Math.cos(rad(coord[1]));
    let best = null, bestD = Infinity;
    for (const f of feats) {
      const c = f.geometry.coordinates;
      for (let i = 1; i < c.length; i++) {
        const ax = (c[i - 1][0] - coord[0]) * k, ay = c[i - 1][1] - coord[1], bx = (c[i][0] - coord[0]) * k, by = c[i][1] - coord[1];
        const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-18)));
        const ex = ax + t * dx, ey = ay + t * dy, d = ex * ex + ey * ey;
        if (d < bestD) { bestD = d; best = { d: [dx, dy], point: [coord[0] + ex / k, coord[1] + ey] }; }
      }
    }
    if (!best) return { dir: [1, 0], point: coord };
    const n = Math.hypot(...best.d);
    return { dir: [best.d[0] / n, best.d[1] / n], point: best.point };
  }

  setBoat(point, bearingDeg) {
    this.boat.setLngLat(point).setRotation(bearingDeg).addTo(this.map);
  }

  setPilotTrail(coords) {
    this.map.getSource('pilot-trail').setData(coords.length > 1
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
      : { type: 'FeatureCollection', features: [] });
  }

  fitCoords(coords, padding = 80) {
    const lons = coords.map((c) => c[0]), lats = coords.map((c) => c[1]);
    this.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding, maxZoom: 15.5, duration: 1200 });
  }

  flyTo(coord, zoom = 13.5) {
    this.map.flyTo({ center: coord, zoom, duration: 1400, essential: true });
  }

  follow(point) {
    if (!this.map.isZooming()) this.map.setCenter(point);   // let a running zoom finish first
  }
}
