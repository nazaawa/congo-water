// The river's course in the 3D world, shared by the terrain, the water shader, the waves,
// the boats and the pilot. A channel is a smooth centreline (downstream order) with a half
// width; it is baked into a grid giving, everywhere around it:
//   d  signed distance from the centreline (> 0 on the right bank looking downstream),
//   s  distance along the centreline from its upstream end,
//   f  the downstream direction of the nearest stretch.
// Two kinds: the real route (OSM track, scaled to fit the world, widths kept real) and
// the old straight, gently meandering stretch (crossings, places without a route).
// No three.js here: the UI uses it too (radar, map mapping).

export class Channel {
  // points: [[x, z], ...] downstream; halfWidth in metres
  constructor(points, halfWidth, { smooth = true } = {}) {
    this.halfWidth = halfWidth;
    const W = halfWidth;
    let pts = resample(points, Math.max(1.5, Math.min(120, W / 3)));
    if (smooth && pts.length > 4) {
      // rivers this wide can't turn on a sixpence: average over ~1.5 widths
      const win = Math.max(1, Math.round((W * 1.5) / Math.max(1.5, Math.min(120, W / 3)) / 2));
      for (let it = 0; it < 3; it++) pts = movingAverage(pts, win);
      pts = resample(pts, Math.max(1.5, Math.min(120, W / 3)));
    }
    this.pts = pts;
    const n = pts.length;
    this.cum = new Float64Array(n);
    for (let i = 1; i < n; i++) this.cum[i] = this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    this.length = this.cum[n - 1];
    let mx = 0, mz = 0;
    for (let i = 1; i < n; i++) { mx += pts[i][0] - pts[i - 1][0]; mz += pts[i][1] - pts[i - 1][1]; }
    this.meanAngle = Math.atan2(mz, mx);   // overall downstream direction
    // curvature (1/m, > 0 turning towards the right bank), averaged over about a width
    this.curv = new Float32Array(n);
    const span = Math.max(1, Math.round(W / Math.max(1.5, Math.min(120, W / 3))));
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - span), b = Math.min(n - 1, i + span), c = Math.max(a + 1, Math.min(b - 1, i));
      if (b - a < 2) continue;
      const ux = pts[c][0] - pts[a][0], uz = pts[c][1] - pts[a][1], vx = pts[b][0] - pts[c][0], vz = pts[b][1] - pts[c][1];
      const la = Math.hypot(ux, uz) || 1, lb = Math.hypot(vx, vz) || 1;
      this.curv[i] = ((ux * vz - uz * vx) / (la * lb)) / ((la + lb) / 2);
    }
    this.bake();
  }

  curvature(s) {
    const c = this.cum;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= Math.max(0, s)) lo = m; else hi = m; }
    return this.curv[lo];
  }

  // point on the centreline at distance s, with the downstream direction
  at(s) {
    const c = this.cum, p = this.pts;
    s = Math.max(0, Math.min(this.length, s));
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    const seg = c[hi] - c[lo] || 1, t = (s - c[lo]) / seg;
    const fx = (p[hi][0] - p[lo][0]) / seg, fz = (p[hi][1] - p[lo][1]) / seg;
    return { x: p[lo][0] + (p[hi][0] - p[lo][0]) * t, z: p[lo][1] + (p[hi][1] - p[lo][1]) * t, fx, fz };
  }

  // world position at (s, d): d along the right-hand normal (-fz, fx)
  point(s, d = 0) {
    const a = this.at(s);
    return { x: a.x - a.fz * d, z: a.z + a.fx * d, fx: a.fx, fz: a.fz };
  }

  // grid over the channel and its banks: cells of ~W/6, at most 512 a side
  bake() {
    const W = this.halfWidth, reach = W + Math.max(260, W * 2.2);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of this.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const pad = reach + Math.max(400, W * 2);
    x0 -= pad; x1 += pad; z0 -= pad; z1 += pad;
    const cell = Math.max(W / 6, Math.max(x1 - x0, z1 - z0) / 512, 1);
    const nx = Math.ceil((x1 - x0) / cell) + 1, nz = Math.ceil((z1 - z0) / cell) + 1;
    Object.assign(this, { x0, z0, cell, nx, nz, x1: x0 + (nx - 1) * cell, z1: z0 + (nz - 1) * cell });
    const N = nx * nz;
    const best = new Float32Array(N).fill(Infinity);
    this.d = new Float32Array(N); this.s = new Float32Array(N); this.fx = new Float32Array(N); this.fz = new Float32Array(N);
    // coarse pass: every 8th cell against every segment, so far land gets a sensible answer
    const step = 8, p = this.pts, nseg = p.length - 1;
    const near = (px, pz, k) => {
      let bd = Infinity, bs = 0, bfx = 1, bfz = 0, bsd = 0;
      for (let i = 0; i < nseg; i++) {
        const ax = p[i][0], az = p[i][1], dx = p[i + 1][0] - ax, dz = p[i + 1][1] - az;
        const L2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
        const ex = px - ax - t * dx, ez = pz - az - t * dz, dd = ex * ex + ez * ez;
        if (dd < bd) {
          const L = Math.sqrt(L2);
          bd = dd; bs = this.cum[i] + t * L; bfx = dx / L; bfz = dz / L;
          bsd = Math.sign(-bfz * ex + bfx * ez) || 1;
        }
      }
      this.write(k, Math.sqrt(bd), bsd, bs, bfx, bfz, best);
    };
    for (let j = 0; j < nz; j += step) for (let i = 0; i < nx; i += step) near(x0 + i * cell, z0 + j * cell, j * nx + i);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      if (i % step === 0 && j % step === 0) continue;
      // fill from the coarse corners
      const i0 = Math.min(Math.floor(i / step) * step, nx - 1), j0 = Math.min(Math.floor(j / step) * step, nz - 1);
      const k0 = j0 * nx + i0;
      const k = j * nx + i;
      this.d[k] = this.d[k0]; this.s[k] = this.s[k0]; this.fx[k] = this.fx[k0]; this.fz[k] = this.fz[k0];
    }
    best.fill(Infinity);
    // fine pass: rasterise each segment's neighbourhood (where the banks are)
    for (let i = 0; i < nseg; i++) {
      const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9, L = Math.sqrt(L2), fx = dx / L, fz = dz / L;
      const ci0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / cell)), ci1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + reach - x0) / cell));
      const cj0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - z0) / cell)), cj1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz) + reach - z0) / cell));
      for (let cj = cj0; cj <= cj1; cj++) {
        const pz = z0 + cj * cell;
        for (let ci = ci0; ci <= ci1; ci++) {
          const px = x0 + ci * cell, t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
          const ex = px - ax - t * dx, ez = pz - az - t * dz, dd = ex * ex + ez * ez;
          const k = cj * nx + ci;
          if (dd < best[k] && dd < reach * reach) {
            best[k] = dd;
            this.write(k, Math.sqrt(dd), Math.sign(-fz * ex + fx * ez) || 1, this.cum[i] + t * L, fx, fz);
          }
        }
      }
    }
  }

  write(k, dist, sign, s, fx, fz, best) {
    this.d[k] = dist * sign; this.s[k] = s; this.fx[k] = fx; this.fz[k] = fz;
    if (best) best[k] = dist * dist;
  }

  // bilinear lookup; out: {d, s, fx, fz} (direction renormalised)
  sample(x, z, out = {}) {
    const gx = Math.max(0, Math.min(this.nx - 1.001, (x - this.x0) / this.cell));
    const gz = Math.max(0, Math.min(this.nz - 1.001, (z - this.z0) / this.cell));
    const i = Math.floor(gx), j = Math.floor(gz), u = gx - i, v = gz - j;
    const k = j * this.nx + i, k1 = k + 1, k2 = k + this.nx, k3 = k2 + 1;
    const w0 = (1 - u) * (1 - v), w1 = u * (1 - v), w2 = (1 - u) * v, w3 = u * v;
    const D = this.d, S = this.s, FX = this.fx, FZ = this.fz;
    // where the sign flips across far land (the outside of a bend) don't blend through zero
    const da = D[k], db = D[k1], dc = D[k2], dd = D[k3];
    const mixed = Math.sign(da) !== Math.sign(db) || Math.sign(da) !== Math.sign(dc) || Math.sign(da) !== Math.sign(dd);
    out.d = mixed && Math.min(Math.abs(da), Math.abs(db), Math.abs(dc), Math.abs(dd)) > this.halfWidth
      ? [da, db, dc, dd][[w0, w1, w2, w3].indexOf(Math.max(w0, w1, w2, w3))]
      : da * w0 + db * w1 + dc * w2 + dd * w3;
    out.s = S[k] * w0 + S[k1] * w1 + S[k2] * w2 + S[k3] * w3;
    const fx = FX[k] * w0 + FX[k1] * w1 + FX[k2] * w2 + FX[k3] * w3, fz = FZ[k] * w0 + FZ[k1] * w1 + FZ[k2] * w2 + FZ[k3] * w3;
    const n = Math.hypot(fx, fz) || 1;
    out.fx = fx / n; out.fz = fz / n;
    return out;
  }

  // RGBA float data for the water shader: d, s, fx, fz
  textureData() {
    const N = this.nx * this.nz, data = new Float32Array(N * 4);
    for (let k = 0; k < N; k++) { data[k * 4] = this.d[k]; data[k * 4 + 1] = this.s[k]; data[k * 4 + 2] = this.fx[k]; data[k * 4 + 3] = this.fz[k]; }
    return data;
  }

  // how far the modelled world reaches (for the terrain and the forest)
  get bounds() { return { x0: this.x0, z0: this.z0, x1: this.x1, z1: this.z1 }; }
}

function resample(points, step) {
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i];
    const L = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= L) { out.push([ax + ((bx - ax) * t) / L, az + ((bz - az) * t) / L]); t += step; }
    carry = L - (t - step);
  }
  const last = points.at(-1), prev = out.at(-1);
  if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) > step * 0.3) out.push(last);
  return out;
}

function movingAverage(pts, w) {
  const n = pts.length, out = pts.map((p) => p.slice());
  for (let i = 1; i < n - 1; i++) {
    const r = Math.min(w, i, n - 1 - i);
    let sx = 0, sz = 0;
    for (let k = -r; k <= r; k++) { sx += pts[i + k][0]; sz += pts[i + k][1]; }
    out[i] = [sx / (2 * r + 1), sz / (2 * r + 1)];
  }
  return out;
}

// the old procedural stretch: along +x, a gentle sine meander, s = x + halfLength
export function straightChannel(p, halfLength = riverLength(p)) {
  const pts = [];
  const n = Math.ceil((2 * halfLength) / Math.max(4, Math.min(60, p.halfWidth / 2)));
  for (let i = 0; i <= n; i++) {
    const x = -halfLength + (2 * halfLength * i) / n;
    pts.push([x, p.meander[0] * Math.sin((x / p.meander[1]) * Math.PI * 2)]);
  }
  const c = new Channel(pts, p.halfWidth, { smooth: false });
  c.kind = 'straight';
  c.offset = halfLength;     // s = x + offset on the centreline
  return c;
}

export function riverLength(p) {
  return Math.min(14000, Math.max(900, p.halfWidth * 7)) * 0.8;
}

// the largest stretch of real river the world can hold for a given width
export function maxExtent(halfWidth) {
  return Math.max(1500, Math.min(20000, halfWidth * 80));
}

// lon/lat <-> local metres: x east, z south (so north is -z, as on a map seen from above)
const rad = (d) => (d * Math.PI) / 180;
export const toLocal = (o, c) => [(c[0] - o[0]) * Math.cos(rad(o[1])) * 111320, -(c[1] - o[1]) * 110574];
export const fromLocal = (o, q) => [o[0] + q[0] / (Math.cos(rad(o[1])) * 111320), o[1] - q[1] / 110574];

