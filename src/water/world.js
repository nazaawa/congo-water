import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm2, mulberry32, noise2 } from './noise.js';

// Banks and props along a Channel (channel.js) for one preset: terrain with red laterite
// banks and sand beaches on the inside of the bends, reeds and papyrus at the waterline,
// gallery forest with emergent umbrella trees, bushes and palms, Kinshasa's low town with
// its tin roofs, fishing villages, rocks in the rapids, a waterfall with mist, birds.

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// h(x, z); h.last.inner is how much the last point lies on the inside of a bend (0..1)
// level: the season, raising the ground against the water (> 0 dry season: sandbanks come out,
// < 0 high water: the bank forest stands in the flood)
export function makeHeight(p, channel, fallS = null, level = 0) {
  const W = p.halfWidth, rise = p.bankRise, H = p.bankHeight;
  const rough = p.bank === 'falaise' ? 0.6 : p.bank === 'ville' ? 0.15 : 0.3;
  const c = {}, last = { inner: 0, d: 0 };
  const islands = channel.kind === 'straight' ? p.islands ?? [] : [];
  const fn = (x, z) => {
    channel.sample(x, z, c);
    const d = Math.abs(c.d) - W;      // < 0 in the water
    // point bars: the inside of a bend silts up into a low beach, the outside is cut steep
    const inner = Math.max(0, Math.min(1, channel.curvature(c.s) * Math.sign(c.d) * W * 5));
    last.inner = inner;
    last.d = d;
    let h;
    if (d < 0) h = -1.5 - Math.min(-d, 40) * 0.25 + inner * Math.max(0, 1 + d / Math.max(12, W * 0.25)) * 1.2;
    else {
      const beach = inner * Math.min(140, W * 0.3 + 6);
      const dd = Math.max(0, d - beach);
      const t = Math.min(1, dd / rise);
      const s = t * t * (3 - 2 * t);
      h = 0.25 + Math.min(d, beach) * 0.01 + dd * 0.04 * (1 - s) + H * s + fbm2(x * 0.004, z * 0.004) * H * rough * s * 2;
      if (p.bank === 'falaise') h += Math.max(0, fbm2(x * 0.02, z * 0.02) - 0.45) * 18 * s;
    }
    for (const [cx, cz, rx, rz] of islands) {
      const q = 1 - ((x - cx) / rx) ** 2 - ((z - cz) / rz) ** 2;
      if (q > 0) h = Math.max(h, -0.5 + Math.sqrt(q) * 4.5 + fbm2(x * 0.01, z * 0.01) * 2);
    }
    if (fallS != null) h += (1 - smooth(fallS - 4, fallS + 4, c.s)) * p.fall.height;   // the cliff: high ground upstream
    // dry season: the shallows near the banks and the bars inside the bends come out first
    if (level > 0) h += level * (d < 0 ? 0.6 + 0.8 * inner + 0.4 * Math.max(0, 1 + d / Math.max(30, W * 0.2)) : 1);
    else h += level;
    return h;
  };
  fn.last = last;
  return fn;
}

const C = {
  mud: new THREE.Color(0.11, 0.075, 0.045), wet: new THREE.Color(0.08, 0.055, 0.035), laterite: new THREE.Color(0.5, 0.2, 0.09),
  sand: new THREE.Color(0.62, 0.48, 0.32), grass: new THREE.Color(0.13, 0.24, 0.055), forest: new THREE.Color(0.05, 0.12, 0.03),
  rock: new THREE.Color(0.24, 0.2, 0.17), street: new THREE.Color(0.32, 0.28, 0.24), dry: new THREE.Color(0.3, 0.28, 0.1),
};

function terrain(p, height, channel) {
  const W = p.halfWidth, b = channel.bounds, wx = b.x1 - b.x0, wz = b.z1 - b.z0;
  const cell = Math.max(W / 5, 2.5, Math.max(wx, wz) / 460);
  const sx = Math.max(2, Math.round(wx / cell)), sz = Math.max(2, Math.round(wz / cell));
  const g = new THREE.PlaneGeometry(wx, wz, sx, sz);
  g.rotateX(-Math.PI / 2);
  g.translate((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
  // a narrow river is only a few cells of that grid wide: its bed and banks get a finer
  // ribbon following the channel, and the grid drops out of sight under it
  const band = cell > W / 4 ? W + Math.min(Math.max(60, W * 3), p.bankRise * 2 + 40) : 0;
  const c = {};
  const groundAt = (x, z) => {
    const h = height(x, z);
    if (band) { channel.sample(x, z, c); if (Math.abs(c.d) < band - cell * 1.5 && c.s > 0.5 && c.s < channel.length - 0.5) return Math.min(h, -12); }
    return h;
  };
  const meshes = [colourTerrain(p, g, groundAt, height, cell)];
  if (band) {
    const ds = Math.max(1.5, Math.min(8, W / 4));
    const rows = Math.ceil(channel.length / ds), across = [];
    // across the ribbon: coarse over the deep bed, fine at the banks
    for (let d = -band; d <= band + 1e-6;) {
      across.push(d);
      const a = Math.abs(Math.abs(d) - W);
      d += a < W * 0.6 + 6 ? Math.max(0.8, W / 14) : a < W * 2 ? Math.max(1.5, W / 6) : Math.max(3, W / 3);
    }
    const n = across.length, pos = new Float32Array((rows + 1) * n * 3), idx = [];
    for (let i = 0; i <= rows; i++) {
      const a = channel.at((channel.length * i) / rows);
      for (let k = 0; k < n; k++) {
        const o = (i * n + k) * 3;
        pos[o] = a.x - a.fz * across[k];
        pos[o + 2] = a.z + a.fx * across[k];
      }
      if (i < rows) for (let k = 0; k < n - 1; k++) { const q = i * n + k; idx.push(q, q + n, q + 1, q + 1, q + n, q + n + 1); }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setIndex(idx);
    meshes.push(colourTerrain(p, rg, height, height, ds));
  }
  const group = new THREE.Group();
  group.add(...meshes);
  return group;
}

function colourTerrain(p, g, ground, height, cell) {
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = ground(x, z);
    const inner = height.last.inner;
    pos.setY(i, h);
    const e = Math.max(1, cell * 0.5);
    const slope = (Math.abs(height(x + e, z) - h) + Math.abs(height(x, z + e) - h)) * (2 / e);
    const n = noise2(x * 0.05, z * 0.05), n2 = noise2(x * 0.011 + 3, z * 0.011);
    if (h < -0.2) c.copy(C.mud);
    else if (h < 0.45) c.copy(C.wet).lerp(C.sand, inner * 0.6);          // the wet line at the water's edge
    else if (h < 1.7) c.copy(p.bank === 'mangrove' ? C.mud : p.bank === 'pool' ? C.sand : C.laterite).lerp(C.sand, Math.max(n * 0.4, inner));
    else c.copy(p.bank === 'ville' ? C.street : C.grass).lerp(C.forest, n * 0.6).lerp(C.dry, Math.max(0, n2 - 0.55) * 1.2);
    if (slope > 2.2) c.lerp(C.rock, Math.min(1, (slope - 2.2) / 2));
    if (p.bank === 'falaise' && slope > 1.2) c.lerp(C.laterite, 0.35);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
  m.receiveShadow = true;
  return m;
}

// --- vegetation ---------------------------------------------------------------------------
function treeGeometries() {
  const trunk = new THREE.CylinderGeometry(0.06, 0.1, 1, 5).translate(0, 0.5, 0);
  const crown = mergeGeometries([
    new THREE.IcosahedronGeometry(0.5, 1).scale(1, 0.7, 1).translate(0, 0.86, 0),
    new THREE.IcosahedronGeometry(0.36, 1).scale(1, 0.8, 1).translate(0.26, 0.7, 0.15),
    new THREE.IcosahedronGeometry(0.34, 1).scale(1, 0.8, 1).translate(-0.25, 0.68, -0.12),
    new THREE.IcosahedronGeometry(0.3, 1).scale(1, 0.9, 1).translate(0.05, 0.52, -0.2),
  ]);
  // emergent forest giant: a flat umbrella of foliage on a bare trunk (like the Congo's
  // limba and sapelli standing over the canopy)
  const umbrella = mergeGeometries([
    new THREE.IcosahedronGeometry(0.5, 1).scale(1, 0.22, 1).translate(0, 0.95, 0),
    new THREE.IcosahedronGeometry(0.32, 1).scale(1, 0.3, 1).translate(0.35, 0.9, 0.2),
    new THREE.IcosahedronGeometry(0.3, 1).scale(1, 0.3, 1).translate(-0.32, 0.91, -0.18),
    new THREE.IcosahedronGeometry(0.28, 1).scale(1, 0.3, 1).translate(0.1, 0.92, -0.38),
  ]);
  const bush = mergeGeometries([
    new THREE.IcosahedronGeometry(0.5, 1).scale(1, 0.6, 1).translate(0, 0.3, 0),
    new THREE.IcosahedronGeometry(0.4, 1).scale(1, 0.6, 1).translate(0.4, 0.22, 0.1),
    new THREE.IcosahedronGeometry(0.38, 1).scale(1, 0.6, 1).translate(-0.35, 0.2, -0.15),
  ]);
  return { trunk, crown, umbrella, bush };
}

function palmGeometry() {
  const fronds = [];
  for (let i = 0; i < 9; i++) {
    // drooping fronds: two segments, the outer one bent down
    const a = (i / 9) * Math.PI * 2 + (i % 2) * 0.2;
    const inner = new THREE.ConeGeometry(0.07, 0.45, 3, 1).rotateZ(Math.PI / 2 + 0.25).translate(0.22, 0.02, 0);
    const outer = new THREE.ConeGeometry(0.05, 0.4, 3, 1).rotateZ(Math.PI / 2 + 0.9).translate(0.55, -0.12, 0);
    fronds.push(inner.rotateY(a).translate(0, 1, 0), outer.rotateY(a).translate(0, 1, 0));
  }
  return mergeGeometries(fronds);
}

// a tuft of reeds or papyrus: thin tapering blades leaning out; papyrus has umbels on top
function reedGeometry(papyrus) {
  const rnd = mulberry32(papyrus ? 7 : 8), parts = [];
  const n = papyrus ? 7 : 11;
  for (let i = 0; i < n; i++) {
    const h = papyrus ? 1.6 + rnd() * 1.4 : 0.9 + rnd() * 1.1, a = rnd() * 6.28, lean = 0.08 + rnd() * 0.22;
    const blade = new THREE.ConeGeometry(papyrus ? 0.012 : 0.02, h, 3, 1).translate(0, h / 2, 0).rotateZ(lean).rotateY(a)
      .translate(Math.cos(a) * 0.15 * rnd(), 0, Math.sin(a) * 0.15 * rnd());
    parts.push(blade);
    if (papyrus) {
      const top = new THREE.ConeGeometry(0.22, 0.25, 6, 1, true).rotateX(Math.PI).translate(0, h + 0.05, 0).rotateZ(lean).rotateY(a);
      parts.push(top);
    }
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

// scatter along the channel: s along, d beyond the bank (both sides)
function alongBanks(channel, rnd, offFn) {
  const s = rnd() * channel.length, side = rnd() < 0.5 ? -1 : 1, off = offFn();
  const q = channel.point(s, side * (channel.halfWidth + off));
  return { x: q.x + (rnd() - 0.5) * 4, z: q.z + (rnd() - 0.5) * 4, side, s, off };
}

function lengthFactor(p, channel) {
  return Math.min(3, Math.max(0.4, channel.length / (2 * Math.min(14000, Math.max(900, p.halfWidth * 7)) * 0.8)));
}

function forest(p, height, channel, rnd) {
  const group = new THREE.Group();
  const { trunk, crown, umbrella, bush } = treeGeometries();
  const kinds = {
    foret: { n: 9000, h: [14, 38], w: [0.5, 0.75], giants: 0.07 },
    falaise: { n: 5000, h: [6, 20], w: [0.6, 0.9], giants: 0.02 },
    ville: { n: 1200, h: [6, 14], w: [0.7, 1], giants: 0 },
    mangrove: { n: 9000, h: [5, 11], w: [0.9, 1.3], giants: 0 },
  };
  const k = kinds[p.bank] ?? kinds.foret;
  const W = p.halfWidth, lf = lengthFactor(p, channel);
  const n = Math.min(22000, Math.round(k.n * p.trees * (W < 100 ? 0.6 : 1) * lf));
  const ng = Math.round(n * k.giants), nb = Math.round(n * 0.3);
  const barkMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
  const trunks = new THREE.InstancedMesh(trunk, barkMat, n + ng);
  const crowns = new THREE.InstancedMesh(crown, leafMat, n);
  const giants = new THREE.InstancedMesh(umbrella, leafMat, Math.max(1, ng));
  const bushes = new THREE.InstancedMesh(bush, leafMat, Math.max(1, nb));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), c = new THREE.Color(), e = new THREE.Euler();
  const sc = {};
  const near = Math.max(W * 2.5, 300);
  const ok = (x, z, minH) => { channel.sample(x, z, sc); return Math.abs(sc.d) > W + 2 && height(x, z) >= minH; };
  let placed = 0, nt = 0, gi = 0;
  for (let tries = 0; placed < n && tries < n * 8; tries++) {
    const a = alongBanks(channel, rnd, () => 3 + Math.pow(rnd(), 1.7) * near);
    if (!ok(a.x, a.z, 0.8)) continue;
    if (p.bank === 'ville' && a.off > 60 && rnd() < 0.8) continue;   // city behind the riverside trees
    const h = height(a.x, a.z);
    const th = k.h[0] + (k.h[1] - k.h[0]) * Math.pow(rnd(), 1.5);
    const w = th * (k.w[0] + (k.w[1] - k.w[0]) * rnd());
    q.setFromEuler(e.set((rnd() - 0.5) * 0.08, rnd() * 6.28, (rnd() - 0.5) * 0.08));
    m.compose(v.set(a.x, h - 0.3, a.z), q, s.set(w * 0.25, th, w * 0.25));
    trunks.setMatrixAt(nt++, m);
    m.compose(v.set(a.x, h - 0.3, a.z), q, s.set(w, th, w));
    crowns.setMatrixAt(placed, m);
    c.setHSL(0.24 + rnd() * 0.08, 0.55 + rnd() * 0.25, 0.09 + rnd() * 0.09);
    if (rnd() < 0.04) c.setHSL(0.08 + rnd() * 0.06, 0.6, 0.2);      // a tree in red new leaf
    crowns.setColorAt(placed, c);
    placed++;
  }
  for (let tries = 0; gi < ng && tries < ng * 10; tries++) {
    const a = alongBanks(channel, rnd, () => 15 + rnd() * near);
    if (!ok(a.x, a.z, 1.2)) continue;
    const h = height(a.x, a.z), th = 40 + rnd() * 18, w = th * (0.55 + rnd() * 0.25);
    q.setFromEuler(e.set(0, rnd() * 6.28, 0));
    m.compose(v.set(a.x, h - 0.3, a.z), q, s.set(1.4 + rnd(), th * 0.93, 1.4 + rnd()));
    trunks.setMatrixAt(nt++, m);
    m.compose(v.set(a.x, h - 0.3, a.z), q, s.set(w, th, w));
    giants.setMatrixAt(gi, m);
    c.setHSL(0.22 + rnd() * 0.06, 0.45 + rnd() * 0.2, 0.12 + rnd() * 0.06);
    giants.setColorAt(gi++, c);
  }
  let bi = 0;
  for (let tries = 0; bi < nb && tries < nb * 8; tries++) {
    // undergrowth crowding the bank, hanging over the water
    const a = alongBanks(channel, rnd, () => -1 + Math.pow(rnd(), 2) * 30);
    const h = height(a.x, a.z);
    if (h < 0.3 || (p.bank === 'ville' && rnd() < 0.7)) continue;
    const r = (W < 100 ? 2 : 3) + rnd() * 4;
    q.setFromEuler(e.set(0, rnd() * 6.28, 0));
    m.compose(v.set(a.x, h - 0.4, a.z), q, s.set(r, r * (0.6 + rnd() * 0.5), r));
    bushes.setMatrixAt(bi, m);
    c.setHSL(0.22 + rnd() * 0.09, 0.5 + rnd() * 0.3, 0.1 + rnd() * 0.08);
    bushes.setColorAt(bi++, c);
  }
  trunks.count = nt; crowns.count = placed; giants.count = gi; bushes.count = bi;
  for (const im of [trunks, crowns, giants, bushes]) { im.castShadow = true; im.receiveShadow = true; group.add(im); }

  // palms along the water in the city, the estuary and the villages
  if (p.bank === 'ville' || p.bank === 'mangrove' || p.bank === 'foret' || p.bank === 'pool') {
    const np = Math.round((p.bank === 'foret' ? 300 : 700) * lf);
    const palms = new THREE.InstancedMesh(palmGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), np);
    const ptrunks = new THREE.InstancedMesh(trunk, barkMat, np);
    let k2 = 0;
    for (let tries = 0; k2 < np && tries < np * 8; tries++) {
      const a = alongBanks(channel, rnd, () => 4 + rnd() * 40);
      if (!ok(a.x, a.z, 0.6)) continue;
      const h = height(a.x, a.z), th = 9 + rnd() * 9;
      q.setFromEuler(e.set((rnd() - 0.5) * 0.25, rnd() * 6.28, (rnd() - 0.5) * 0.25));
      m.compose(v.set(a.x, h - 0.2, a.z), q, s.set(th * 0.38, th, th * 0.38));
      palms.setMatrixAt(k2, m);
      c.setHSL(0.25 + rnd() * 0.05, 0.5, 0.14 + rnd() * 0.06);
      palms.setColorAt(k2, c);
      m.compose(v.set(a.x, h - 0.2, a.z), q, s.set(2.2, th, 2.2));
      ptrunks.setMatrixAt(k2, m);
      k2++;
    }
    palms.count = ptrunks.count = k2;
    palms.castShadow = ptrunks.castShadow = true;
    group.add(palms, ptrunks);
  }
  return group;
}

function reeds(p, height, channel, rnd) {
  const group = new THREE.Group();
  if (p.bank === 'falaise' && p.flow > 4) return group;
  const W = p.halfWidth;
  const n = Math.round(Math.min(7000, Math.max(400, (channel.length * 2) / (W < 100 ? 2.5 : 7))));
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
  const meshes = [reedGeometry(false), reedGeometry(true)].map((g) => new THREE.InstancedMesh(g, mat, n));
  const count = [0, 0];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), c = new THREE.Color();
  for (let tries = 0; count[0] + count[1] < n && tries < n * 6; tries++) {
    const a = alongBanks(channel, rnd, () => -4 + rnd() * 7);
    if (noise2(a.x * 0.02, a.z * 0.02) < 0.42) continue;           // in patches
    const h = height(a.x, a.z);
    if (h < -0.7 || h > 1.0) continue;
    const kind = p.bank === 'mangrove' || rnd() < 0.7 ? 0 : 1;
    const sz = (W < 100 ? 0.8 : 1.2) * (0.7 + rnd() * 0.8);
    q.setFromAxisAngle(_Y, rnd() * 6.28);
    m.compose(v.set(a.x, Math.max(h, -0.3) - 0.1, a.z), q, s.set(sz, sz * (0.8 + rnd() * 0.5), sz));
    meshes[kind].setMatrixAt(count[kind], m);
    c.setHSL(kind ? 0.22 + rnd() * 0.04 : 0.15 + rnd() * 0.08, 0.45 + rnd() * 0.2, 0.16 + rnd() * 0.1);
    meshes[kind].setColorAt(count[kind]++, c);
  }
  meshes.forEach((im, i) => { im.count = count[i]; im.castShadow = true; group.add(im); });
  return group;
}
const _Y = new THREE.Vector3(0, 1, 0);

// --- Kinshasa & Brazzaville -------------------------------------------------------------
function city(p, height, channel, stationS, rnd) {
  // Kinshasa on the left bank (d < 0 looking downstream), Brazzaville on the right: low town
  // of painted walls under tin roofs, a few towers downtown
  const n = 1600;
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const walls = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.02 }), n);
  const roofs = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.35 }), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), c = new THREE.Color();
  const WALLS = [0xe8dcc0, 0xd9b77a, 0xc9d6dc, 0xe3b8a6, 0xf2efe6, 0xb9c9a3, 0xd98b5f];
  const ROOFS = [0x8a4b2a, 0x8d9196, 0x6f7377, 0x2f5d8a, 0x9c3b2b, 0xa65a2e];
  const span = Math.min(channel.length / 2, 6500);
  let k = 0, kr = 0;
  for (let tries = 0; k < n && tries < n * 6; tries++) {
    const side = rnd() < 0.55 ? -1 : 1;
    const along = (rnd() - 0.5) * 2 * span, sAt = stationS + along;
    if (sAt < 0 || sAt > channel.length) continue;
    const off = 50 + Math.pow(rnd(), 1.4) * 1400;
    const pt = channel.point(sAt, side * (p.halfWidth + off));
    const h = height(pt.x, pt.z);
    if (h < 1) continue;
    // downtown: Gombe towers upstream on the left bank, Brazzaville's Tour Nabemba on the right
    const core = side < 0 ? Math.exp(-(((along + 900) / 1300) ** 2)) : Math.exp(-(((along - 600) / 700) ** 2));
    let bh = 3.5 + rnd() * 6;
    if (rnd() < core * 0.35) bh = 25 + rnd() * 70;
    if (side > 0 && k === 0) bh = 106;
    const fw = 8 + rnd() * 18, fd = 7 + rnd() * 16;
    q.setFromAxisAngle(_Y, -Math.atan2(pt.fz, pt.fx) + (rnd() - 0.5) * 0.3);
    m.compose(v.set(pt.x, h - 0.5, pt.z), q, s.set(fw, bh, fd));
    walls.setMatrixAt(k, m);
    if (bh > 30) c.setRGB(0.28, 0.36, 0.42).lerp(new THREE.Color(0.7, 0.68, 0.62), rnd() < 0.5 ? 0 : 0.8);   // glass or concrete towers
    else c.setHex(WALLS[Math.floor(rnd() * WALLS.length)]).multiplyScalar(0.75 + rnd() * 0.25);
    walls.setColorAt(k, c);
    if (bh < 14) {
      m.compose(v.set(pt.x, h - 0.5 + bh, pt.z), q, s.set(fw * 1.08, 0.35, fd * 1.08));
      roofs.setMatrixAt(kr, m);
      c.setHex(ROOFS[Math.floor(rnd() * ROOFS.length)]).multiplyScalar(0.7 + rnd() * 0.3);
      roofs.setColorAt(kr++, c);
    }
    k++;
  }
  walls.count = k; roofs.count = kr;
  const g = new THREE.Group();
  for (const im of [walls, roofs]) { im.castShadow = im.receiveShadow = true; g.add(im); }
  return g;
}

// --- villages on the banks ----------------------------------------------------------------
// a few huts of mud brick under thatch or corrugated iron behind a beach; returns the spots
// where people stand, wash and wave (people are added by RiverScene)
function villages(p, height, channel, stationS, rnd) {
  const group = new THREE.Group(), spots = [];
  if (p.bank === 'ville' || p.bank === 'falaise') return { group, spots };
  const W = p.halfWidth;
  const nv = Math.max(1, Math.min(9, Math.round(channel.length / (W < 100 ? 700 : 2200))));
  const nh = nv * 12;
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const cone = new THREE.ConeGeometry(0.78, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0);
  const gable = new THREE.CylinderGeometry(0.7, 0.7, 1, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6).translate(0, 0.25, 0);
  const walls = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.95 }), nh);
  const thatch = new THREE.InstancedMesh(cone, new THREE.MeshStandardMaterial({ color: 0x9c8550, roughness: 1, flatShading: true }), nh);
  const tin = new THREE.InstancedMesh(gable, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.4, flatShading: true }), nh);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), c = new THREE.Color();
  let kw = 0, kt = 0, kn = 0;
  const sc = {};
  for (let vi = 0; vi < nv; vi++) {
    // the first village sits near the boat, the others spread along the trip
    const sv = vi === 0 ? stationS + (W < 100 ? 40 : 250) * (rnd() < 0.5 ? 1 : -1) : rnd() * channel.length;
    const side = rnd() < 0.5 ? -1 : 1;
    const shore = channel.point(sv, side * (W + 2));
    if (height(shore.x, shore.z) > 3) continue;
    const back = W < 100 ? 10 : 22;
    const village = { s: sv, side, shore, people: [], centre: channel.point(sv, side * (W + back + 10)) };
    const face = Math.atan2(-side * shore.fx, side * shore.fz);   // looking at the water
    for (let i = 0; i < 12; i++) {
      const along = (rnd() - 0.5) * (W < 100 ? 40 : 90), off = back + rnd() * (W < 100 ? 18 : 40);
      const pt = channel.point(sv + along, side * (W + off));
      channel.sample(pt.x, pt.z, sc);
      const h = height(pt.x, pt.z);
      if (Math.abs(sc.d) < W + 6 || h < 0.6 || h > 9) continue;
      const w = 3 + rnd() * 3, dpt = 3 + rnd() * 2.5, hh = 2.1 + rnd() * 0.6;
      q.setFromAxisAngle(_Y, face + (rnd() - 0.5) * 0.5);
      m.compose(v.set(pt.x, h - 0.2, pt.z), q, s.set(w, hh, dpt));
      walls.setMatrixAt(kw, m);
      c.setHex([0x8a5a3a, 0x9b6b45, 0xb08a64, 0xd9d0bf, 0x7a4a30][Math.floor(rnd() * 5)]).multiplyScalar(0.8 + rnd() * 0.2);
      walls.setColorAt(kw++, c);
      if (rnd() < 0.55) {
        m.compose(v.set(pt.x, h - 0.2 + hh, pt.z), q, s.set(w * 1.25, 1.8 + rnd() * 0.8, dpt * 1.25));
        thatch.setMatrixAt(kt++, m);
      } else {
        m.compose(v.set(pt.x, h - 0.2 + hh - 0.05, pt.z), q, s.set(w * 1.15, 1, dpt * 1.6));
        tin.setMatrixAt(kn, m);
        c.setHex([0x8d9196, 0x8a4b2a, 0x6f7377, 0xa65a2e][Math.floor(rnd() * 4)]);
        tin.setColorAt(kn++, c);
      }
    }
    // where people go: the waterline (washing, fishing), the beach (watching, waving), between the huts
    for (let i = 0; i < (W < 100 ? 5 : 8); i++) {
      const r = rnd(), along = (rnd() - 0.5) * (W < 100 ? 30 : 70);
      const off = r < 0.35 ? -0.5 + rnd() * 1.5 : r < 0.75 ? 3 + rnd() * (back - 4) : back + rnd() * 20;
      const pt = channel.point(sv + along, side * (W + off));
      const h = height(pt.x, pt.z);
      if (h < -0.4 || h > 9) continue;
      village.people.push({ x: pt.x, z: pt.z, y: Math.max(h, -0.15), face: face + (rnd() - 0.5) * 1.2, role: r < 0.35 ? 'wash' : r < 0.75 ? 'watch' : 'walk' });
    }
    spots.push(village);
  }
  walls.count = kw; thatch.count = kt; tin.count = kn;
  for (const im of [walls, thatch, tin]) { im.castShadow = im.receiveShadow = true; group.add(im); }
  return { group, spots };
}

function rockField(p, height, channel, stationS, fallS, rnd) {
  const rocks = [];
  if (!p.rocks) return { mesh: null, rocks };
  const W = p.halfWidth, span = Math.min(W * 4, 900);
  const n = Math.round(p.rocks * Math.min(6, Math.max(1, channel.length / (2 * span))));
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 0.75 + noise2(x * 2.1 + 5, z * 2.1 + y * 1.7) * 0.5;
    pos.setXYZ(i, x * k, y * k * 0.7, z * k);
  }
  geo.computeVertexNormals();
  const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x5a4a3e, roughness: 0.8, flatShading: true }), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
  const st = channel.point(stationS);
  let k = 0;
  for (let tries = 0; k < n && tries < n * 4; tries++) {
    // around the boat's station, and below a waterfall, else anywhere along the trip
    const sAt = fallS != null && rnd() < 0.6 ? fallS + 5 + rnd() * span * 0.6 : n > p.rocks && rnd() < 0.6 ? rnd() * channel.length : stationS + (rnd() - 0.5) * span;
    const pt = channel.point(sAt, (rnd() - 0.5) * W * 1.8);
    if (Math.hypot(pt.x - st.x, pt.z - st.z) < 28) continue;   // keep the boat clear
    const r = 1.5 + rnd() * (W > 100 ? 5 : 2.2);
    q.setFromEuler(new THREE.Euler(rnd(), rnd() * 6.28, rnd()));
    m.compose(v.set(pt.x, -r * 0.3 + rnd() * r * 0.4, pt.z), q, s.set(r, r, r));
    im.setMatrixAt(k++, m);
    rocks.push({ x: pt.x, z: pt.z, r });
  }
  im.count = k;
  im.castShadow = im.receiveShadow = true;
  return { mesh: im, rocks };
}

// --- birds: a loose flock wheeling over the water, wings flapping in the vertex shader ----
function birds(uniforms, count = 26) {
  const wing = new THREE.BufferGeometry();
  // body along x; each wing a triangle, the tip vertex flagged for the flap
  wing.setAttribute('position', new THREE.Float32BufferAttribute([0.35, 0, 0, -0.3, 0, 0, 0, 0, 0.9, 0.35, 0, 0, -0.3, 0, 0, 0, 0, -0.9], 3));
  wing.setAttribute('tip', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 1));
  const g = new THREE.InstancedBufferGeometry().copy(wing);
  g.instanceCount = count;
  const rnd = mulberry32(17), seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) seed.set([rnd() * 6.28, 30 + rnd() * 90, 14 + rnd() * 30, 0.08 + rnd() * 0.06], i * 4);
  g.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uCentre: { value: new THREE.Vector3() }, uColor: { value: new THREE.Color(0.05, 0.045, 0.04) } },
    vertexShader: /* glsl */`
      attribute float tip;
      attribute vec4 seed;   // phase, radius, height, angular speed
      uniform float uTime;
      uniform vec3 uCentre;
      void main() {
        float a = seed.x + uTime * seed.w;
        vec3 c = uCentre + vec3(cos(a) * seed.y, seed.z + 3.0 * sin(uTime * 0.4 + seed.x * 3.0), sin(a) * seed.y * 0.7);
        vec3 p = position * 1.3;
        p.y += tip * sin(uTime * 9.0 + seed.x * 11.0) * 0.55;
        float h = -(a + 1.5708);                       // fly along the circle
        vec3 q = vec3(p.x * cos(h) - p.z * sin(h), p.y, p.x * sin(h) + p.z * cos(h));
        gl_Position = projectionMatrix * viewMatrix * vec4(c + q, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  return mesh;
}

const FALL_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FALL_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uLight;
varying vec2 vUv;
varying vec3 vWorld;
float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  // streaks falling faster and faster (free fall), broken up near the bottom
  float fall = 1.0 - vUv.y;                 // 0 at the lip
  float v = fall * fall * 2.5 + fall * 0.5 - uTime * 0.55;   // accelerates as it drops
  // long vertical streaks: fine across, stretched along the fall
  float s = n(vec2(vUv.x * 160.0, v * 3.0)) * 0.55 + n(vec2(vUv.x * 420.0, v * 7.0)) * 0.3 + n(vec2(vUv.x * 30.0, v * 0.8)) * 0.15;
  float a = smoothstep(0.2, 0.7, s + fall * 0.25) * (0.55 + 0.45 * smoothstep(0.0, 0.15, fall));
  a *= smoothstep(0.0, 0.03, vUv.x) * smoothstep(1.0, 0.97, vUv.x);
  // brown water at the lip turning to white spray lower down
  vec3 brown = vec3(0.32, 0.22, 0.12);
  vec3 col = mix(brown, uColor, smoothstep(0.05, 0.5, fall) * 0.7 + s * 0.3) * uLight * (0.8 + 0.4 * s);
  gl_FragColor = vec4(col, a * 0.95);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;


function waterfall(p, uniforms, at) {
  const W = p.halfWidth * 2, H = p.fall.height;
  const g = new THREE.PlaneGeometry(W, H + 2, 60, 24);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), t = 1 - (y + H / 2) / H;          // 0 at the lip
    pos.setZ(i, t * t * 4 + 0.6 * Math.sin(pos.getX(i) * 0.15));  // the sheet curves out as it falls
  }
  g.rotateY(Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uColor: { value: new THREE.Color(0.85, 0.8, 0.68) }, uLight: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: FALL_VERT, fragmentShader: FALL_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(at.x + at.fx * 1.5, H / 2 - 0.5, at.z + at.fz * 1.5);
  mesh.rotation.y = -Math.atan2(at.fz, at.fx);
  return mesh;
}

function mist(count, origin, spread, uniforms) {
  const g = new THREE.BufferGeometry();
  const rnd = mulberry32(3);
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos.set([origin.x + rnd() * spread.x, origin.y, origin.z + (rnd() - 0.5) * spread.z], i * 3);
    seed[i] = rnd();
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uLight: { value: new THREE.Color(1, 1, 1) }, uRise: { value: spread.y } },
    vertexShader: /* glsl */`
      attribute float seed;
      uniform float uTime, uRise;
      varying float vA;
      void main() {
        float life = fract(uTime * 0.06 + seed * 7.0);
        vec3 p = position + vec3(life * 20.0, life * uRise, sin(seed * 40.0 + uTime * 0.3) * 6.0);
        vA = sin(life * 3.14159) * 0.22;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = min((14.0 + 30.0 * life) * 300.0 / -mv.z, 160.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uLight;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(uLight * 0.9, vA * smoothstep(0.5, 0.0, d));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

// opts: { stationS (where the boat waits), fallS (the lip of a waterfall, along the bed) }
export function buildWorld(p, uniforms, channel, { stationS = channel.length / 2, fallS = null, level = 0 } = {}) {
  const rnd = mulberry32(42);
  const height = makeHeight(p, channel, fallS, level);
  const group = new THREE.Group();
  group.add(terrain(p, height, channel));
  group.add(forest(p, height, channel, rnd));
  group.add(reeds(p, height, channel, rnd));
  if (p.bank === 'ville') group.add(city(p, height, channel, stationS, rnd));
  const vil = villages(p, height, channel, stationS, rnd);
  group.add(vil.group);
  const { mesh: rockMesh, rocks } = rockField(p, height, channel, stationS, fallS, rnd);
  if (rockMesh) group.add(rockMesh);
  const lit = [];
  if (fallS != null) {
    const at = channel.point(fallS);
    const f = waterfall(p, uniforms, at);
    group.add(f);
    const m = mist(380, new THREE.Vector3(at.x, 0, at.z - p.halfWidth), new THREE.Vector3(60, 40, p.halfWidth * 2), uniforms);
    group.add(m);
    lit.push(f.material.uniforms.uLight, m.material.uniforms.uLight);
  }
  if (p.flow > 4) {
    // spray hanging over the rapids
    const at = channel.point(stationS - 300);
    const m = mist(500, new THREE.Vector3(at.x - 400, 0, at.z - p.halfWidth * 0.8), new THREE.Vector3(800, 14, p.halfWidth * 1.6), uniforms);
    group.add(m);
    lit.push(m.material.uniforms.uLight);
  }
  const flock = birds(uniforms);
  group.add(flock);
  return { group, height, rocks, lit, villages: vil.spots, birds: flock.material.uniforms.uCentre, channel };
}
