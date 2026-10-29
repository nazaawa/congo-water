import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';
import { waveHeight } from './waves.js';
import { PIROGUES } from './pirogues.js';
import { createPerson } from './people.js';

export { PIROGUES };

// Things on the water: the pirogues (the GLB models in public/models) with standing
// paddlers, passengers and cargo, rafts of water
// hyacinth drifting with the current, and far-off river boats. They ride the same
// wave function the water shader draws (waves.js), sampled on the CPU at a few hull
// points, the way Ultra-Water's floaters read their heights back from the GPU.

// --- pirogue models -------------------------------------------------------------------------
// Specs (file, draft, crew layout) live in pirogues.js, shared with the UI.

export async function loadPirogues(base) {
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
  ]);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const out = {};
  await Promise.all(Object.entries(PIROGUES).map(async ([k, spec]) => {
    const gltf = await loader.loadAsync(`${base}models/${spec.file}`);
    out[k] = prepareModel(gltf.scene);
  }));
  return out;
}

function prepareModel(scene) {
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.material.side = THREE.DoubleSide;
  });
  // dugouts: coque_exterieur / coque_interieur; plank whaleboats: a `coque` group capped by `plat_bord`
  const outer = scene.getObjectByName('coque_exterieur') ?? scene.getObjectByName('coque');
  const box = new THREE.Box3().setFromObject(outer);
  return {
    scene, lid: lidFrom(scene.getObjectByName('coque_interieur') ?? scene.getObjectByName('plat_bord')),
    length: box.max.x - box.min.x, halfBeam: box.max.z, rim: box.max.y,
  };
}

// Lid across the opening of the hull, drawn depth-only after the hull and before the
// water, so the water plane doesn't show through the inside of the hull. Built from the
// interior shell (or the gunwale): per slice along the length, its top height and half width.
function lidFrom(mesh) {
  const pos = mesh.geometry.attributes.position, v = new THREE.Vector3();
  const box = new THREE.Box3().setFromObject(mesh);
  const N = 96, top = new Float32Array(N + 1).fill(-1e9), half = new Float32Array(N + 1);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const b = Math.round(((v.x - box.min.x) / (box.max.x - box.min.x)) * N);
    top[b] = Math.max(top[b], v.y);
    half[b] = Math.max(half[b], Math.abs(v.z));
  }
  for (let b = 1; b <= N; b++) if (top[b] < -1e8) { top[b] = top[b - 1]; half[b] = half[b - 1]; }
  const p = [], idx = [];
  for (let b = 0; b <= N; b++) {
    const x = box.min.x + (b / N) * (box.max.x - box.min.x), y = top[b] - 0.015;
    p.push(x, y, -half[b], x, y, half[b]);
    if (b < N) idx.push(b * 2, b * 2 + 1, b * 2 + 3, b * 2, b * 2 + 3, b * 2 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setIndex(idx);
  return g;
}

function hullInstance(model, draft) {
  const g = new THREE.Group();
  const hull = model.scene.clone(true);
  const lid = new THREE.Mesh(model.lid, LID_MAT);
  lid.renderOrder = 1;
  g.add(hull, lid);
  g.position.y = -draft;           // waterline at the group origin
  return g;
}
const LID_MAT = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

// --- crew: lofted, skinned people (people.js, after mrdoob's slop-newyork) -----------------
let seedN = 11;
// someone sitting at height `y` above the hull floor `floor`, looking along `yaw`. High seats
// (sacks, the top of the cargo) get a virtual floor half a metre below them, legs dangling onto it.
function seatedPerson(rnd, floorY, seatY, yaw, opts = {}) {
  const person = createPerson(seedN++, opts);
  const seat = seatY - floorY, high = seat > 0.9;
  person.setPose('sit', { seat: high ? 0.5 : Math.max(0.3, seat) });
  person.group.position.y = high ? seatY - 0.5 : floorY;
  person.group.rotation.y = yaw;
  person.update(rnd() * 10, 0);
  return person;
}
const CREW_OUTFITS = ['fisher', 'shirt', 'football', 'shirt'];
function cargoItem(rnd) {
  const r = rnd();
  let m;
  if (r < 0.4) {
    // sacks of charcoal / cassava flour
    m = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8).scale(1.25, 0.7, 0.9),
      new THREE.MeshStandardMaterial({ color: rnd() < 0.5 ? 0xb8a27a : 0x2b2b2b, roughness: 1 }));
    m.position.y = 0.16;
  } else if (r < 0.75) {
    // plastic basin (bassine) with produce
    m = new THREE.Group();
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.2, 16, 1, true),
      new THREE.MeshStandardMaterial({ color: [0x1f7fd1, 0xd7263d, 0x2aa84a, 0xf2b705][Math.floor(rnd() * 4)], roughness: 0.5, side: THREE.DoubleSide }));
    basin.position.y = 0.1;
    const fill = new THREE.Mesh(new THREE.SphereGeometry(0.27, 10, 6).scale(1, 0.35, 1),
      new THREE.MeshStandardMaterial({ color: rnd() < 0.5 ? 0x3f7a2a : 0xd99a2b, roughness: 0.9 }));
    fill.position.y = 0.2;
    m.add(basin, fill);
  } else {
    // bundle of plantains under a tarp
    m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.35, 0.5), new THREE.MeshStandardMaterial({ color: 0x2c5f8a, roughness: 0.9 }));
    m.position.y = 0.18;
  }
  m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return m;
}

// --- the pirogue the camera rides ---------------------------------------------------------------
export class Pirogue {
  constructor(models) {
    this.models = models;
    this.group = new THREE.Group();
    this.state = { y: 0, vy: 0, pitch: 0, roll: 0 };
    this.heading = Math.PI;      // bow upstream (−x): paddling against the current
    this.base = new THREE.Vector3();
    this.paddlers = [];
    this.setKind('peche');
  }

  setKind(kind) {
    if (kind === this.kind || !this.models[kind]) return;
    this.kind = kind;
    const spec = PIROGUES[kind], model = this.models[kind];
    const rnd = mulberry32(5 + kind.length);
    this.group.clear();
    this.L = model.length;
    this.halfBeam = model.halfBeam;
    this.spec = spec;
    const hull = hullInstance(model, spec.draft);
    this.group.add(hull);
    const floor = -spec.draft + (spec.floor ?? 0.08), bench = -spec.draft + (spec.bench ?? model.rim * 0.72);
    this.people = [];
    this.paddlers = spec.crew.map((c, i) => {
      const { x, y, z = 0, paddle = true, pose } = typeof c === 'number' ? { x: c } : c;
      const motorised = !!spec.motor;
      const kind = pose ?? (!paddle ? 'helm' : motorised && i > 0 ? 'pole' : 'paddle');
      const person = createPerson(seedN++, { female: false, outfit: spec.crewOutfit ?? CREW_OUTFITS[i % CREW_OUTFITS.length] });
      const side = i % 2 ? 1 : -1;
      person.setPose(kind, { side });
      person.group.position.set(x, y != null ? -spec.draft + y : floor, z);
      person.phase = rnd() * 0.6;
      person.kind = kind;
      person.side = side;
      this.group.add(person.group);
      this.people.push(person);
      return person;
    });
    for (const e of spec.seated) {
      const [x, z, y, yaw] = Array.isArray(e) ? e : [e];
      const turn = yaw ?? (y != null ? (rnd() < 0.7 ? 0 : Math.PI) + (rnd() - 0.5) * 0.6 : rnd() < 0.5 ? 0 : Math.PI);
      const person = seatedPerson(rnd, floor, y != null ? -spec.draft + y : bench, turn, spec.passengers ?? {});
      person.group.position.x = x;
      person.group.position.z = z ?? (rnd() - 0.5) * 0.1;
      this.group.add(person.group);
      this.people.push(person);
    }
    // the bottom of a dugout is round: cargo rides on the benches' level, centred
    const deck = bench - 0.16;
    for (let i = 0; i < spec.cargo; i++) {
      const c = cargoItem(rnd);
      c.scale.setScalar(Math.min(1, model.halfBeam * 1.7));
      const x = spec.seated.length ? spec.seated[i % spec.seated.length] + 0.55 : 0.6 + i * 0.75;
      c.position.add(new THREE.Vector3(x, deck, (rnd() - 0.5) * 0.08));
      c.rotation.y = rnd() * 6.28;
      this.group.add(c);
    }
    this.motor = null;
    const own = spec.motor === 'model' && hull.getObjectByName(spec.motorNode ?? 'moteur');
    if (own) {
      // the model's own motor swings about its engine block (long-tail) or its clamp (outboard)
      const pivot = new THREE.Group();
      const c = new THREE.Box3().setFromObject(own.getObjectByName(spec.pivotNode ?? 'moteur_bloc') ?? own).getCenter(new THREE.Vector3());
      own.parent.add(pivot);
      pivot.position.set(c.x, 0, c.z);
      own.position.x -= c.x;
      own.position.z -= c.z;
      pivot.add(own);
      this.motor = pivot;
    } else if (spec.motor) {
      // outboard at the stern, pivoting with the steering
      const m = new THREE.Group();
      const dark = new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.5, metalness: 0.3 });
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.32), dark);
      head.position.set(-0.15, 0.25, 0);
      const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.08, 0.34), new THREE.MeshStandardMaterial({ color: 0xd7263d, roughness: 0.6 }));
      cowl.position.set(-0.15, 0.52, 0);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.0, 0.08), dark);
      leg.position.set(-0.12, -0.45, 0);
      const tiller = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.8, 6), dark);
      tiller.rotation.z = Math.PI / 2 - 0.25;
      tiller.position.set(0.35, 0.3, 0);
      m.add(head, cowl, leg, tiller);
      m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      m.position.set(-model.length / 2 + 0.25, -spec.draft + model.rim, 0);
      this.group.add(m);
      this.motor = m;
    }
    if (spec.net) {
      // heap of net amidships and a fish basket
      const net = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8).scale(1.3, 0.3, 0.42),
        new THREE.MeshStandardMaterial({ color: 0x4d5a4a, roughness: 1 }));
      net.position.set(-1.0, deck + 0.06, 0);
      const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.32, 12),
        new THREE.MeshStandardMaterial({ color: 0x9a7a45, roughness: 1 }));
      basket.position.set(-1.9, deck + 0.12, 0);
      for (const m of [net, basket]) { m.castShadow = true; this.group.add(m); }
    }
  }

  // camera in the eyes of the man at the stern: hide his own body, keep his paddle
  firstPerson(on) {
    const p = this.paddlers[0];
    p.setFirstPerson(on);
    return p.eye().applyEuler(p.group.rotation).add(p.group.position);
  }

  place(x, z, heading) {
    this.base.set(x, 0, z);
    this.heading = heading;
    this.state = { y: 0, vy: 0, pitch: 0, roll: 0 };
  }

  // pose: {x, z, heading} when someone is piloting, else the boat holds station and
  // sways; effort (0..1) sets the paddling rate
  update(waves, t, dt, pose = null, effort = 1) {
    if (pose) this.heading = pose.heading;
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    const x = pose ? pose.x : this.base.x + Math.sin(t * 0.11) * 3;
    const z = pose ? pose.z : this.base.z + Math.sin(t * 0.07 + 1) * 2;
    const at = (lx, lz) => waveHeight(waves, x + lx * ch - lz * sh, z + lx * sh + lz * ch, t);
    const hl = this.L * 0.44, hw = this.halfBeam * 0.9;
    const hb = at(hl, 0), hs = at(-hl, 0), hp = at(0, hw), hst = at(0, -hw), hc = at(0, 0);
    const target = (hb + hs + hp + hst + 2 * hc) / 6;
    const st = this.state;
    // critically damped follow, a little lag looks like mass
    const k = 30, c = 2 * Math.sqrt(k);
    st.vy += (k * (target - st.y) - c * st.vy) * dt;
    st.y += st.vy * dt;
    st.pitch += (Math.atan2(hb - hs, 2 * hl) - st.pitch) * Math.min(1, dt * 4);
    st.roll += (Math.atan2(hp - hst, 2 * hw) * 0.35 + Math.sin(t * 1.7) * 0.012 - st.roll) * Math.min(1, dt * 4);
    this.group.position.set(x, st.y, z);
    this.group.rotation.set(0, 0, 0);
    this.group.rotateY(-this.heading);
    this.group.rotateZ(st.pitch);
    this.group.rotateX(st.roll);
    // paddle stroke: long pull, quick recovery
    this.stroke = (this.stroke ?? 0) + dt * (0.25 + 0.75 * effort);
    if (this.motor) this.motor.rotation.y = -(this.steer ?? 0) * 0.5;
    const stroke = { stroke: 0, steer: this.steer ?? 0 };
    for (const p of this.people) {
      stroke.stroke = this.stroke + (p.phase ?? 0);
      p.update(t, dt, stroke);
    }
  }
}

// --- other pirogues around: pulled up on the banks and the village beaches, or out fishing ----
// heading h: the bow points along (cos h, sin h)
export class MooredPirogues {
  constructor(models, preset, channel, station, rnd, skip, villages = []) {
    this.group = new THREE.Group();
    this.items = [];
    const narrow = preset.halfWidth < 120, W = preset.halfWidth;
    // no 16 m whaleboats pulled up on the bank of a small river
    const kinds = ['transport', 'peche', 'petite', 'baleiniere-bois', 'baleiniere', 'baleiniere-sacs'].filter((k) => k !== skip && models[k] && (!narrow || models[k].length < 13));
    const small = kinds.filter((k) => models[k].length < 13);
    const add = (kind, x, z, heading, sitter) => {
      const spec = PIROGUES[kind], model = models[kind], g = new THREE.Group();
      g.add(hullInstance(model, spec.draft));
      if (sitter) {
        // a fisherman squatting at the stern, mending or watching his lines
        const p = createPerson(seedN++, { female: false, outfit: 'fisher' }).setPose('squat');
        p.group.position.set(-model.length * 0.3, (spec.floor ?? 0.08), 0);
        p.group.rotation.y = rnd() < 0.5 ? 0 : Math.PI;
        g.children[0].add(p.group);
      }
      this.group.add(g);
      this.items.push({ g, x, z, heading, L: model.length, phase: rnd() * 10 });
    };
    const n = narrow ? 3 : 4;
    for (let i = 0; i < n; i++) {
      const kind = kinds[i % kinds.length];
      if (narrow) {
        // pulled up on the bank, bow on the shore
        const side = i === 1 ? 1 : -1, sAt = station.s + (i - 1) * (9 + rnd() * 8) + 14;
        const q = channel.point(sAt, side * (W - models[kind].length * 0.3));
        add(kind, q.x, q.z, Math.atan2(side * q.fx, -side * q.fz) + (rnd() - 0.5) * 0.35, false);
      } else {
        // fishing out on the water, one man kneeling
        const a = (i / n) * Math.PI * 2 + rnd();
        const d = Math.max(-W + 20, Math.min(W - 20, station.d + Math.sin(a) * (22 + rnd() * 50)));
        const q = channel.point(station.s + Math.cos(a) * (30 + rnd() * 60), d);
        add(kind, q.x, q.z, rnd() * 6.28, true);
      }
    }
    // dugouts on the village beaches
    for (const v of villages.slice(0, 6)) {
      for (let i = 0; i < 2; i++) {
        const kind = small[(i + Math.floor(v.s)) % small.length];
        const q = channel.point(v.s + (rnd() - 0.5) * 30, v.side * (W - 0.5));
        add(kind, q.x, q.z, Math.atan2(v.side * q.fx, -v.side * q.fz) + (rnd() - 0.5) * 0.5, false);
      }
    }
  }

  update(waves, t) {
    for (const it of this.items) {
      const ch = Math.cos(it.heading), sh = Math.sin(it.heading), hl = it.L * 0.4;
      const hb = waveHeight(waves, it.x + hl * ch, it.z + hl * sh, t), hs = waveHeight(waves, it.x - hl * ch, it.z - hl * sh, t);
      it.g.position.set(it.x, (hb + hs) / 2, it.z);
      it.g.rotation.set(0, 0, 0);
      it.g.rotateY(-it.heading);
      it.g.rotateZ(Math.atan2(hb - hs, 2 * hl));
      it.g.rotateX(Math.sin(t * 0.9 + it.phase) * 0.02);
    }
  }
}

// --- water hyacinth (Eichhornia, the floating islands of the Congo) -----------------------
function hyacinthGeometry() {
  const rnd = mulberry32(9);
  const parts = [];
  const green = new THREE.Color(0.1, 0.25, 0.05), lilac = new THREE.Color(0.55, 0.42, 0.8);
  for (let i = 0; i < 14; i++) {
    const a = rnd() * 6.28, r = Math.sqrt(rnd()) * 0.85;
    const s = 0.22 + rnd() * 0.2;
    const g = new THREE.SphereGeometry(1, 6, 4).scale(s, s * 0.55, s * 0.8).rotateY(rnd() * 6.28)
      .translate(Math.cos(a) * r, 0.05 + rnd() * 0.18, Math.sin(a) * r);
    parts.push([g, green.clone().offsetHSL(0, 0, (rnd() - 0.5) * 0.06)]);
  }
  for (let i = 0; i < 4; i++) {
    const a = rnd() * 6.28, r = rnd() * 0.5;
    const g = new THREE.SphereGeometry(0.07, 5, 4).scale(1, 2, 1).translate(Math.cos(a) * r, 0.42, Math.sin(a) * r);
    parts.push([g, lilac]);
  }
  const geos = parts.map(([g, c]) => {
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    return g;
  });
  return mergeGeometries(geos);
}

export class Hyacinths {
  constructor(count, preset, channel, around) {
    this.count = count;
    this.mesh = new THREE.InstancedMesh(hyacinthGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true }), Math.max(1, count));
    this.mesh.castShadow = true;
    this.mesh.count = count;
    this.mesh.frustumCulled = false;
    const rnd = mulberry32(13);
    this.channel = channel;
    this.R = Math.min(380, Math.max(80, preset.halfWidth * 0.8));
    const s0 = channel.sample(around.x, around.z).s;
    // rafts in the channel's frame: s along the bed, d across
    this.items = Array.from({ length: count }, () => ({
      s: s0 + (rnd() - 0.5) * 2 * this.R,
      d: (rnd() - 0.5) * 2 * Math.min(this.R, preset.halfWidth - 4),
      s0: 0, r: rnd() * 6.28, spin: (rnd() - 0.5) * 0.05, size: 0.7 + Math.pow(rnd(), 3) * 3.5,
    }));
    this.flow = preset.flow * 0.92;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._v = new THREE.Vector3();
    this._e = new THREE.Euler(); this._c = {};
  }

  update(waves, t, dt, around) {
    const { _m, _q, _s, _v, _e } = this, ch = this.channel;
    const sb = ch.sample(around.x, around.z, this._c).s, db = this._c.d;
    for (let i = 0; i < this.count; i++) {
      const h = this.items[i];
      h.s += this.flow * dt;
      h.r += h.spin * dt;
      if (h.s > sb + this.R) h.s -= 2 * this.R;
      if (h.s < sb - this.R) h.s += 2 * this.R;
      if (Math.abs(h.s - sb) < 9 && Math.abs(h.d - db) < 4 + h.size) h.d += 9 + h.size;   // drift around the pirogue
      const q = ch.point(h.s, h.d);
      const y = waveHeight(waves, q.x, q.z, t);
      const dx = waveHeight(waves, q.x + 1, q.z, t) - y, dz = waveHeight(waves, q.x, q.z + 1, t) - y;
      _e.set(dz, h.r, -dx);
      _q.setFromEuler(_e);
      _m.compose(_v.set(q.x, y - 0.05, q.z), _q, _s.set(h.size, h.size, h.size));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// --- far river traffic: a pusher with barges, a loaded whaleboat ----------------------------
function tradeBoat(model, rnd) {
  const spec = PIROGUES['baleiniere-sacs'], b = new THREE.Group();
  b.add(hullInstance(model, spec.draft));
  for (const [x, z, y] of spec.seated) {
    const p = seatedPerson(rnd, spec.floor - spec.draft, y - spec.draft, rnd() < 0.7 ? 0 : Math.PI);
    p.group.position.x = x;
    p.group.position.z = z;
    b.add(p.group);
  }
  return b;
}

export function riverBoats(preset, rnd, models, channel, stationS) {
  const group = new THREE.Group();
  if (preset.halfWidth < 300) return { group, boats: [] };
  const boats = [];
  const mk = (len, wid, color, cabin) => {
    const b = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(len, 1.4, wid), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
    hull.position.y = 0.2;
    b.add(hull);
    if (cabin) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(cabin[0], cabin[1], wid * 0.8), new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.7 }));
      c.position.set(-len / 2 + cabin[0] / 2 + 1, 0.9 + cabin[1] / 2, 0);
      b.add(c);
    }
    // cargo heaps and tarpaulins
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(len / 7, 0.8 + rnd(), wid * 0.85),
        new THREE.MeshStandardMaterial({ color: [0x2c5f8a, 0x8a3b2c, 0xd6c49b, 0x3f6b3a][i % 4], roughness: 0.9 }));
      s.position.set(-len / 2 + len * (0.3 + i * 0.13), 1.2, 0);
      b.add(s);
    }
    b.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return b;
  };
  // in the channel's frame; they loop within `span` of the station
  const specs = [
    { obj: mk(70, 10, 0x4a4038, [10, 5]), s: stationS - 520, d: preset.halfWidth * 0.35, speed: -1.1 },
    { obj: models?.['baleiniere-sacs'] ? tradeBoat(models['baleiniere-sacs'], rnd) : mk(24, 4, 0x6b4a2a, [16, 2.2]), s: stationS + 380, d: -preset.halfWidth * 0.25, speed: 1.4 },
  ];
  for (const s of specs) {
    s.s0 = stationS;
    s.span = Math.min(1500, channel.length / 2);
    group.add(s.obj);
    boats.push(s);
  }
  return { group, boats };
}
