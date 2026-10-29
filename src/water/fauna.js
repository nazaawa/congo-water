import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { waveHeight } from './waves.js';

// The animals of the river (free low-poly models in public/models/animaux, see README):
// * hippos in pods off the banks of the wide reaches: backs and heads above the water,
//   diving now and then, and for good when a boat comes too close; the boat can't go through them;
// * crocodiles basking on the beaches, sliding into the water when a boat comes by;
// * egrets, grey herons and yellow-billed storks fishing at the waterline, stepping back up the
//   bank as you pass;
// * fish leaping out of the water around the boat.
// They are spread along the whole channel; only those near the boat are animated.

const SPECIES = {
  hippo: { file: 'hippo.glb', size: 4.2, axis: 'length' },
  croc: { file: 'croc.glb', size: 3.8, axis: 'length' },
  egret: { file: 'egret.glb', size: 1.0, axis: 'height' },
  heron: { file: 'heron.glb', size: 1.05, axis: 'height' },
  stork: { file: 'stork.glb', size: 1.0, axis: 'height' },
  fish: { file: 'fish.glb', size: 0.5, axis: 'length' },
};

export async function loadFauna(base, loader) {
  const out = {};
  await Promise.all(Object.entries(SPECIES).map(async ([k, sp]) => {
    try {
      const gltf = await loader.loadAsync(`${base}models/animaux/${sp.file}`);
      out[k] = normalise(gltf, sp);
    } catch (e) {
      console.warn('fauna', k, e);
    }
  }));
  return out;
}

// scaled to its real size, standing on y = 0, facing +X (the models face +Z)
function normalise(gltf, sp) {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene), size = box.getSize(new THREE.Vector3());
  const k = sp.size / (sp.axis === 'height' ? size.y : Math.max(size.x, size.z));
  const c = box.getCenter(new THREE.Vector3());
  const inner = new THREE.Group();
  scene.position.set(-c.x, -box.min.y, -c.z);
  inner.add(scene);
  inner.scale.setScalar(k);
  inner.rotation.y = Math.PI / 2;
  const root = new THREE.Group();
  root.add(inner);
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { root, clips: gltf.animations, height: size.y * k, length: Math.max(size.x, size.z) * k };
}

function cloneModel(model) {
  // skinned models (the fish) need their skeleton cloned too
  let skinned = false;
  model.root.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
  return skinned ? skeletonClone(model.root) : model.root.clone(true);
}

export class Fauna {
  constructor(models, preset, channel, height, rnd) {
    this.group = new THREE.Group();
    this.obstacles = [];
    this.items = [];
    this.splashes = [];
    this.channel = channel;
    this.height = height;
    this.models = models;
    this.rnd = rnd;
    const W = preset.halfWidth, L = channel.length, wild = preset.bank !== 'ville';
    const calm = preset.flow < 3;
    // a place on the bank side `side`, `off` metres beyond the waterline (> 0 on land), at s
    const spot = (s, side, off) => channel.point(s, side * (W + off));

    // hippos: pods on the wide, calm reaches
    if (models.hippo && W >= 150 && calm && preset.bank !== 'mangrove') {
      const pods = Math.min(7, Math.max(2, Math.round(L / 3500)));
      for (let i = 0; i < pods; i++) {
        const s = L * ((i + 0.5 + (rnd() - 0.5) * 0.6) / pods), side = rnd() < 0.5 ? -1 : 1;
        const n = 3 + Math.floor(rnd() * 4), c = spot(s, side, -(30 + rnd() * Math.min(120, W * 0.15)));
        for (let k = 0; k < n; k++) {
          const x = c.x + (rnd() - 0.5) * 16, z = c.z + (rnd() - 0.5) * 16;
          if (height(x, z) > -1.6) continue;
          this.add('hippo', { x, z, heading: rnd() * 6.28, state: 'up', timer: 5 + rnd() * 40, depth: 0, calf: k > 2 && rnd() < 0.5 });
        }
      }
    }
    // crocodiles on the beaches of the forest rivers
    if (models.croc && wild && W < 2000) {
      const n = Math.min(10, Math.max(2, Math.round(L / 900)));
      for (let i = 0; i < n; i++) {
        const s = L * ((i + rnd()) / n), side = rnd() < 0.5 ? -1 : 1;
        const p = spot(s, side, 1.5 + rnd() * 3);
        if (height(p.x, p.z) > 1.2) continue;
        this.add('croc', { x: p.x, z: p.z, heading: Math.atan2(side * p.fx, -side * p.fz) + Math.PI + (rnd() - 0.5) * 1.2, state: 'bask', side, s, timer: 0 });
      }
    }
    // wading birds at the waterline
    const birds = ['egret', 'heron', 'stork'].filter((b) => models[b]);
    if (birds.length && wild) {
      const n = Math.min(70, Math.max(6, Math.round(L / 160)));
      for (let i = 0; i < n; i++) {
        const s = L * ((i + rnd()) / n), side = rnd() < 0.5 ? -1 : 1;
        const p = spot(s, side, -0.6 + rnd() * 1.2);
        const h = height(p.x, p.z);
        if (h > 0.6) continue;
        this.add(birds[Math.floor(rnd() * birds.length)], { x: p.x, z: p.z, y0: Math.max(h, -0.25), heading: rnd() * 6.28, state: 'fish', side, s, timer: rnd() * 5 });
      }
    }
    // a few fish for the leaps (pooled)
    this.fish = [];
    if (models.fish) {
      for (let i = 0; i < 3; i++) {
        const obj = cloneModel(models.fish), mixer = new THREE.AnimationMixer(obj);
        if (models.fish.clips[0]) mixer.clipAction(models.fish.clips[0]).play();
        obj.visible = false;
        this.group.add(obj);
        this.fish.push({ obj, mixer, t: -1 });
      }
    }
    this.nextLeap = 4;
  }

  add(kind, o) {
    const obj = cloneModel(this.models[kind]);
    if (o.calf) obj.scale.setScalar(0.6);
    obj.visible = false;
    this.group.add(obj);
    o.kind = kind;
    o.obj = obj;
    o.phase = this.rnd() * 10;
    o.ox = o.x; o.oz = o.z;
    if (kind === 'hippo') { o.obstacle = { x: o.x, z: o.z, r: o.calf ? 1.4 : 2.3 }; this.obstacles.push(o.obstacle); }
    this.items.push(o);
  }

  // boat: {x, z} (the pirogue); t: scene time
  update(waves, t, dt, boat) {
    const near2 = 700 * 700;
    for (const o of this.items) {
      const dx = o.x - boat.x, dz = o.z - boat.z, d2 = dx * dx + dz * dz;
      o.obj.visible = d2 < near2 * 4;
      if (d2 > near2) continue;
      const d = Math.sqrt(d2);
      this[o.kind === 'hippo' ? 'hippo' : o.kind === 'croc' ? 'croc' : 'bird'](o, waves, t, dt, d, boat);
    }
    this.leaps(waves, t, dt, boat);
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const s = this.splashes[i];
      s.age += dt;
      const k = s.age / 1.2;
      s.mesh.scale.setScalar(0.4 + k * 2.4);
      s.mesh.material.opacity = 0.75 * (1 - k);
      if (k >= 1) { this.group.remove(s.mesh); s.mesh.material.dispose(); this.splashes.splice(i, 1); }
    }
  }

  hippo(o, waves, t, dt, d, boat) {
    // up: back and head out, bobbing; down: under for a while, coming up a little further on
    o.timer -= dt;
    if (o.state === 'up' && (o.timer <= 0 || d < 22)) {
      o.state = 'down'; o.timer = d < 22 ? 25 + this.rnd() * 20 : 8 + this.rnd() * 18;
      this.splash(o.x, o.z, waves, t, 1.6);
    } else if (o.state === 'down' && o.timer <= 0 && d > 30) {
      o.state = 'up'; o.timer = 15 + this.rnd() * 45;
      o.x = o.ox + (this.rnd() - 0.5) * 14; o.z = o.oz + (this.rnd() - 0.5) * 14;
      if (this.height(o.x, o.z) > -1.6) { o.x = o.ox; o.z = o.oz; }
      this.splash(o.x, o.z, waves, t, 1.2);
    }
    const target = o.state === 'up' ? 0 : 1;
    o.depth += (target - o.depth) * Math.min(1, dt * 0.8);
    if (o.state === 'up' && d < 120) {
      // turn to watch the boat
      const want = Math.atan2(boat.z - o.z, boat.x - o.x);
      o.heading += Math.atan2(Math.sin(want - o.heading), Math.cos(want - o.heading)) * Math.min(1, dt * 0.3);
    }
    const w = waveHeight(waves, o.x, o.z, t), body = o.calf ? 0.6 : 1;
    o.obj.position.set(o.x, w - (0.92 + o.depth * 2.5) * body + Math.sin(t * 0.7 + o.phase) * 0.06, o.z);
    o.obj.rotation.set(0, -o.heading, Math.sin(t * 0.5 + o.phase) * 0.03 + 0.09);
    o.obstacle.x = o.x; o.obstacle.z = o.z;
    o.obstacle.r = o.depth > 0.7 ? 0 : o.calf ? 1.4 : 2.3;
  }

  croc(o, waves, t, dt, d) {
    // basking on the sand; a boat close by sends it into the water, where it floats, eyes out
    if (o.state === 'bask' && d < 35) { o.state = 'slide'; o.timer = 0; }
    if (o.state === 'slide') {
      o.timer += dt;
      const q = this.channel.point(o.s, o.side * (this.channel.halfWidth - 5));
      o.x += (q.x - o.x) * Math.min(1, dt * 1.2);
      o.z += (q.z - o.z) * Math.min(1, dt * 1.2);
      o.heading = Math.atan2(q.z - o.oz, q.x - o.ox);
      if (o.timer > 2) { o.state = 'swim'; this.splash(o.x, o.z, waves, t, 1); }
    }
    let y;
    if (o.state === 'bask') y = this.height(o.x, o.z) + 0.02;
    else if (o.state === 'slide') y = Math.max(this.height(o.x, o.z), waveHeight(waves, o.x, o.z, t) - 0.3) + 0.02;
    else {
      y = waveHeight(waves, o.x, o.z, t) - 0.42;
      o.x += Math.cos(o.heading) * 0.15 * dt;
      o.z += Math.sin(o.heading) * 0.15 * dt;
    }
    o.obj.position.set(o.x, y, o.z);
    o.obj.rotation.set(0, -o.heading, 0);
  }

  bird(o, waves, t, dt, d, boat) {
    // fishing: still, with now and then a stab of the beak; a boat close by: walk up the bank
    if (o.state === 'fish' && d < 26) {
      o.state = 'walk';
      o.timer = 0;
    }
    let pitch = 0;
    if (o.state === 'walk') {
      o.timer += dt;
      const q = this.channel.point(o.s, o.side * (this.channel.halfWidth + 9));
      const vx = q.x - o.x, vz = q.z - o.z, L = Math.hypot(vx, vz);
      if (L > 0.5 && o.timer < 6) {
        o.heading = Math.atan2(vz, vx);
        o.x += (vx / L) * 1.1 * dt; o.z += (vz / L) * 1.1 * dt;
      } else if (d > 60) { o.state = 'back'; }
      pitch = Math.sin(o.timer * 9) * 0.04;
    } else if (o.state === 'back') {
      const vx = o.ox - o.x, vz = o.oz - o.z, L = Math.hypot(vx, vz);
      if (L < 0.3) o.state = 'fish';
      else { o.heading = Math.atan2(vz, vx); o.x += (vx / L) * 0.6 * dt; o.z += (vz / L) * 0.6 * dt; pitch = Math.sin(t * 7) * 0.03; }
    } else {
      o.timer -= dt;
      if (o.timer < 0) { o.timer = 3 + this.rnd() * 6; o.stab = 0.5; }
      if (o.stab > 0) { o.stab -= dt; pitch = Math.sin((1 - o.stab / 0.5) * Math.PI) * 0.6; }
      o.heading += Math.sin(t * 0.3 + o.phase) * dt * 0.1;
    }
    const y = Math.max(this.height(o.x, o.z), o.y0 ?? -0.25);
    o.obj.position.set(o.x, Math.max(y, -0.3), o.z);
    o.obj.rotation.set(0, -o.heading, -pitch);
  }

  leaps(waves, t, dt, boat) {
    if (!this.fish.length) return;
    this.nextLeap -= dt;
    if (this.nextLeap <= 0) {
      this.nextLeap = 3 + this.rnd() * 9;
      const f = this.fish.find((x) => x.t < 0);
      const a = this.rnd() * 6.28, r = 10 + this.rnd() * 30, x = boat.x + Math.cos(a) * r, z = boat.z + Math.sin(a) * r;
      if (f && this.height(x, z) < -1) {
        f.t = 0; f.x = x; f.z = z; f.h = this.rnd() * 6.28; f.dur = 0.9 + this.rnd() * 0.5; f.top = 0.7 + this.rnd() * 0.9;
        f.obj.visible = true;
        this.splash(x, z, waves, t, 0.5);
      }
    }
    for (const f of this.fish) {
      if (f.t < 0) continue;
      f.t += dt;
      f.mixer.update(dt * 2);
      const u = f.t / f.dur, run = 1.6;
      if (u >= 1) { f.t = -1; f.obj.visible = false; this.splash(f.x + Math.cos(f.h) * run, f.z + Math.sin(f.h) * run, waves, t, 0.5); continue; }
      const w = waveHeight(waves, f.x, f.z, t);
      f.obj.position.set(f.x + Math.cos(f.h) * run * u, w + 4 * f.top * u * (1 - u) - 0.1, f.z + Math.sin(f.h) * run * u);
      // nose along the arc
      f.obj.rotation.set(0, -f.h, Math.atan2(4 * f.top * (1 - 2 * u), run));
    }
  }

  splash(x, z, waves, t, size) {
    const mesh = new THREE.Mesh(SPLASH_GEO, new THREE.MeshBasicMaterial({ color: 0xf1ece0, transparent: true, opacity: 0.75, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, waveHeight(waves, x, z, t) + 0.05, z);
    mesh.scale.setScalar(size);
    this.group.add(mesh);
    this.splashes.push({ mesh, age: 0 });
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const s of this.splashes) s.mesh.material.dispose();
  }
}

const SPLASH_GEO = new THREE.RingGeometry(0.55, 0.8, 24);
