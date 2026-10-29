import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PRESETS } from './presets.js';
import { buildWaves, waveHeight } from './waves.js';
import { Sky } from './sky.js';
import { bakeWaterTextures } from './bake.js';
import { WaterSurface } from './WaterSurface.js';
import { PlanarReflection } from './PlanarReflection.js';
import { buildWorld } from './world.js';
import { straightChannel } from './channel.js';
import { Villagers } from './villagers.js';
import { Pirogue, Hyacinths, MooredPirogues, riverBoats, loadPirogues } from './floaters.js';
import { mulberry32 } from './noise.js';
import { Pilot } from './pilot.js';

// The 3D view: one renderer, rebuilt world per preset (setPlace), render loop that only
// runs while the view is visible.

export class RiverScene {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;   // rendered once per frame, before the main pass only
    this.renderer.localClippingEnabled = false;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.2, 30000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 2500;

    this.scene = new THREE.Scene();
    this.sky = new Sky();
    this.scene.add(this.sky.mesh);
    this.textures = bakeWaterTextures();
    this.water = new WaterSurface(this.sky, this.textures);
    this.water.mesh.renderOrder = 2;   // after the pirogue's depth-only lid
    this.scene.add(this.water.mesh);
    this.reflection = new PlanarReflection(0.5);
    this.water.uniforms.uRefl.value = this.reflection.target.texture;
    this.water.uniforms.uReflMatrix.value = this.reflection.textureMatrix;

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    this.hemi = new THREE.HemisphereLight(0xbfd4e6, 0x3a2a1a, 0.9);
    this.scene.add(this.sun, this.sun.target, this.hemi);

    // the pirogue GLBs load once; setPlace waits for them
    this.ready = loadPirogues(import.meta.env.BASE_URL).then((models) => {
      this.models = models;
      this.pirogue = new Pirogue(models);
      this.scene.add(this.pirogue.group);
    });

    this.pilot = new Pilot(this);
    this.time = 0;
    this.timer = new THREE.Timer();
    this.active = false;
    this.mode = 'orbit';
    this.flowScale = 1;
    this.world = null;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio, w * h > 1.2e6 ? 1.5 : 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.reflection.setSize(w * dpr, h * dpr);
  }

  // opts: { channel (the river's course, else the preset's straight stretch), stationS / stationD
  // (where the boat waits, along / across the bed), fallS (lip of a waterfall along the bed) }
  setPlace(key, kind, opts = {}) {
    const p = PRESETS[key] ?? PRESETS.fleuve;
    this.pilot.stop();
    this.key = key;
    this.pirogue.setKind(kind ?? p.pirogue);
    this.preset = p;
    // tear down the previous world
    if (this.world) {
      this.scene.remove(this.world.group, this.hyacinths.mesh, this.boats.group, this.moored.group);
      if (this.upper) this.scene.remove(this.upper.mesh);
      this.world.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
      this.hyacinths.mesh.geometry.dispose();
      this.scene.remove(this.villagers.group);
      this.villagers.dispose();
      this.onTeardown?.();
    }
    const channel = this.channel = opts.channel ?? straightChannel(p);
    this.chanTex?.dispose();
    this.chanTex = new THREE.DataTexture(channel.textureData(), channel.nx, channel.nz, THREE.RGBAFormat, THREE.FloatType);
    const filter = this.renderer.extensions.has('OES_texture_float_linear') ? THREE.LinearFilter : THREE.NearestFilter;
    this.chanTex.magFilter = this.chanTex.minFilter = filter;
    this.chanTex.needsUpdate = true;
    this.water.setChannel(channel, this.chanTex);

    const straight = channel.kind === 'straight';
    const fallS = p.fall ? (straight ? channel.offset + p.fall.x : opts.fallS ?? null) : null;
    const stationS = opts.stationS ?? (straight ? channel.offset + (p.fall ? p.fall.x + 120 : 0) : channel.length / 2);
    const W = p.halfWidth;
    const stationD = opts.stationD ?? (p.flow > 4 ? -W + 75 : W < 100 ? 0 : -Math.min(W * 0.3, 260));
    this.station = { s: stationS, d: stationD };
    this.fallS = fallS;

    const flowed = { ...p, flow: p.flow * this.flowScale };
    this.waves = buildWaves(flowed, channel);
    this.world = buildWorld(p, this.water.uniforms, channel, { stationS, fallS });
    this.scene.add(this.world.group);
    const fall = fallS != null ? { s: fallS } : null;
    this.water.configure(flowed, this.waves, this.world.rocks, fall);

    // the pool above a waterfall: a second, clipped water surface at the lip height
    this.upper = null;
    if (fall) {
      this.upper = new WaterSurface(this.sky, this.textures);
      this.upper.setChannel(channel, this.chanTex);
      this.upper.configure({ ...p, foam: 0.15 }, this.waves, [], null);
      this.upper.uniforms.uBase.value = p.fall.height - 0.6;
      this.upper.uniforms.uClip.value.set(1, fallS + 1);
      this.upper.mesh.renderOrder = 2;
      this.scene.add(this.upper.mesh);
    }

    // boat station, bow upstream
    const st = channel.point(stationS, stationD);
    this.pirogue.place(st.x, st.z, Math.atan2(-st.fz, -st.fx));
    this.boatAt = new THREE.Vector3(st.x, 0, st.z);

    this.hyacinths = new Hyacinths(p.hyacinths, p, channel, this.boatAt);
    this.scene.add(this.hyacinths.mesh);
    this.boats = riverBoats(p, mulberry32(21), this.models, channel, stationS);
    this.scene.add(this.boats.group);
    this.moored = new MooredPirogues(this.models, p, channel, this.station, mulberry32(31), this.pirogue.kind, this.world.villages);
    this.scene.add(this.moored.group);
    this.rockTimer = 0;
    this.villagers = new Villagers(this.world.villages, channel);
    this.scene.add(this.villagers.group);
    this.onPlace?.(this.world);

    this.scene.fog = new THREE.FogExp2(0xffffff, p.haze);
    this.setSun(p.sun.elev, p.sun.azim);

    // camera: orbit around the pirogue; the preset's angle is relative to the river's direction
    const c = p.camera, a = THREE.MathUtils.degToRad(c.angle) + Math.atan2(st.fz, st.fx);
    this.controls.target.set(st.x, 1, st.z);
    this.camera.position.set(st.x + Math.cos(a) * c.dist, c.height, st.z + Math.sin(a) * c.dist);
    this.controls.update();
    this.applyMode();
  }

  setSun(elev, azim = this.preset.sun.azim) {
    this.sunElev = elev;
    const dir = this.sky.set(elev, azim, this.preset.cloud);
    const sc = this.sky.sunColor, hz = this.sky.horizon;
    this.sun.color.copy(sc).multiplyScalar(1 / Math.max(sc.r, 1e-3));
    this.sun.intensity = 2.6 * Math.max(sc.r, 0.02) * THREE.MathUtils.smoothstep(elev, -3, 6);
    const zen = this.sky.uniforms.uZenith.value;
    this.hemi.color.setRGB(zen.x * 1.6, zen.y * 1.6, zen.z * 1.6).lerp(hz, 0.5);
    this.hemi.intensity = 0.5 + 1.1 * THREE.MathUtils.smoothstep(elev, -6, 30);
    this.sunDir = dir.clone();
    this.scene.fog?.color.copy(hz);
    for (const u of this.world?.lit ?? []) u.value.copy(hz).lerp(sc, 0.5).multiplyScalar(0.9);
  }

  setPirogue(kind) {
    this.pirogue.setKind(kind);
    this.applyMode();
    this.scene.remove(this.moored.group);
    this.moored = new MooredPirogues(this.models, this.preset, this.channel, this.station, mulberry32(31), kind, this.world.villages);
    this.scene.add(this.moored.group);
  }

  setFlowScale(s) {
    this.flowScale = s;
    const p = { ...this.preset, flow: this.preset.flow * s };
    this.waves = buildWaves(p, this.channel);
    this.water.configure(p, this.waves, this.world.rocks, this.fallS != null ? { s: this.fallS } : null);
    this.hyacinths.flow = p.flow * 0.92;
  }

  setMode(mode) {
    this.mode = mode;
    this.applyMode();
  }

  applyMode() {
    this.chaseH = null;
    this.controls.enabled = this.mode === 'orbit';
    if (this.mode !== 'onboard') this.pirogue.firstPerson(false);
    if (this.mode === 'orbit') {
      const st = this.channel.point(this.station.s, this.station.d);
      const c = this.preset.camera, a = THREE.MathUtils.degToRad(c.angle) + Math.atan2(st.fz, st.fx);
      this.camera.position.set(this.boatAt.x + Math.cos(a) * c.dist, c.height, this.boatAt.z + Math.sin(a) * c.dist);
      this.controls.target.set(this.boatAt.x, 1, this.boatAt.z);
    }
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.timer.update();
    const loop = () => {
      if (!this.active) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.active = false;
    cancelAnimationFrame(this.raf);
  }

  frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 1 / 20);
    this.time += dt;
    const t = this.time;
    this.water.uniforms.uTime.value = t;
    if (this.upper) this.upper.uniforms.uTime.value = t;
    this.sky.uniforms.uTime.value = t;

    let pose = null, effort = 1;
    if (this.pilot.active) {
      pose = this.pilot.step(dt);
      effort = Math.abs(this.pilot.input.throttle);
    }
    this.pirogue.update(this.waves, t, dt, pose, effort);
    this.moored.update(this.waves, t);
    const bp = this.pirogue.group.position;
    this.hyacinths.update(this.waves, t, dt, this.pilot.active ? bp : this.boatAt);
    // the rocks nearest the boat drive the foam in the water shader
    if ((this.rockTimer -= dt) <= 0 && this.world.rocks.length > 24) {
      this.rockTimer = 0.5;
      this.water.setRocks([...this.world.rocks].sort((a, b) => Math.hypot(a.x - bp.x, a.z - bp.z) - Math.hypot(b.x - bp.x, b.z - bp.z)));
    }
    this.world.birds.value.lerp(bp, 1 - Math.exp(-dt * 0.3));
    this.villagers.update(bp, t, dt);
    this.onFrame?.(t, dt);
    // wake under the pirogue (only when it actually moves through the water)
    const wake = this.water.uniforms.uWake.value;
    wake.set(bp.x, bp.z, this.pirogue.heading, this.pilot.active ? Math.abs(this.pilot.state.u) : 0);
    this.water.uniforms.uWakeSize.value.set(this.pirogue.L / 2, this.pirogue.halfBeam);
    for (const b of this.boats.boats) {
      b.s += b.speed * dt;
      if (Math.abs(b.s - b.s0) > b.span) b.s = b.s0 - Math.sign(b.s - b.s0) * b.span;
      const q = this.channel.point(b.s, b.d);
      b.obj.position.set(q.x, waveHeight(this.waves, q.x, q.z, t), q.z);
      b.obj.rotation.y = -Math.atan2(q.fz, q.fx) + (b.speed < 0 ? Math.PI : 0);
    }

    const g = this.pirogue.group;
    if (this.mode === 'onboard') {
      // standing at the stern behind the paddlers, riding the hull
      const eye = this.pirogue.firstPerson(true).applyMatrix4(g.matrixWorld);
      const ahead = new THREE.Vector3(this.pirogue.L * 0.5 + 10, 0.2, 0).applyMatrix4(g.matrixWorld);
      this.camera.position.copy(eye);
      this.camera.lookAt(ahead);
    } else if (this.mode === 'chase') {
      // behind and above the stern, swinging round smoothly as the boat turns
      // (relative to the boat, so it keeps up when time is sped up)
      const L = this.pirogue.L, target = this.pirogue.heading;
      this.chaseH ??= target;
      this.chaseH += Math.atan2(Math.sin(target - this.chaseH), Math.cos(target - this.chaseH)) * (1 - Math.exp(-dt * 2.5));
      const h = this.chaseH;
      this.camera.position.set(g.position.x - Math.cos(h) * (L + 14), 4.5 + L * 0.3, g.position.z - Math.sin(h) * (L + 14));
      this.camera.lookAt(g.position.x + Math.cos(h) * 12, 1.2, g.position.z + Math.sin(h) * 12);
    } else {
      // keep orbiting the boat as it sways
      const d = new THREE.Vector3(g.position.x, 1 + g.position.y, g.position.z).sub(this.controls.target);
      this.controls.target.add(d);
      this.camera.position.add(d);
      this.controls.update();
      if (this.camera.position.y < 0.6 + waveHeight(this.waves, this.camera.position.x, this.camera.position.z, t)) this.camera.position.y += 0.05;
    }

    // shadow camera fitted around the boat
    const sd = this.sunDir;
    this.sun.position.set(g.position.x + sd.x * 400, sd.y * 400, g.position.z + sd.z * 400);
    this.sun.target.position.copy(g.position);
    const sc = this.sun.shadow.camera, ext = Math.min(220, Math.max(60, this.preset.halfWidth));
    if (sc.right !== ext) { Object.assign(sc, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 1200 }); sc.updateProjectionMatrix(); }

    this.water.follow(this.camera);
    if (this.upper) this.upper.follow(this.camera);
    this.camera.updateMatrixWorld();
    const hide = [this.water.mesh];
    if (this.upper) hide.push(this.upper.mesh);
    this.renderer.shadowMap.needsUpdate = true;   // drawn by the first pass (the reflection), reused by the main one
    const ok = this.reflection.render(this.renderer, this.scene, this.camera, 0, hide);
    this.water.uniforms.uUseRefl.value = ok ? 1 : 0;
    this.renderer.render(this.scene, this.camera);
  }
}
