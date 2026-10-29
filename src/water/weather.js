import * as THREE from 'three';

// A living river: the afternoon storm, the seasons and the night.
// * Storm (0..1, eased): the sky closes in and darkens, gusts raise the chop and push the
//   boat, rain streaks round the camera, lightning flashes with its thunder a moment later.
// * Seasons: RiverScene rebuilds the place with the ground raised (dry season, the sandbanks out,
//   a slower river) or lowered (high water, the forest in the flood, a faster river, more hyacinth).
// * Night: lanterns on the fishing pirogues and in the villages, a lamp on your own boat.

export const SEASONS = {
  pluies: { label: 'Saison des pluies (hautes eaux)', level: -0.6, flow: 1.3, hyacinths: 1.8 },
  seche: { label: 'Saison sèche (basses eaux)', level: 0.9, flow: 0.75, hyacinths: 0.6 },
};

const RAIN = 2600, BOX = 60;

function rainMesh() {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(RAIN * 2 * 3), end = new Float32Array(RAIN * 2);
  for (let i = 0; i < RAIN; i++) {
    const x = Math.random() * BOX, y = Math.random() * BOX, z = Math.random() * BOX;
    pos.set([x, y, z, x, y, z], i * 6);
    end[i * 2 + 1] = 1;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2() }, uAmount: { value: 0 }, uColor: { value: new THREE.Color(0.85, 0.88, 0.9) } },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform vec3 uCam; uniform vec2 uWind; uniform float uAmount;
      attribute float aEnd; varying float vA;
      void main() {
        vec3 v = vec3(uWind.x, -9.0, uWind.y);
        vec3 p = position + v * uTime;
        p = mod(p - uCam + ${BOX / 2}.0, ${BOX}.0) + uCam - ${BOX / 2}.0;
        p -= v * aEnd * 0.06;                         // the streak: where the drop was a moment ago
        vA = step(fract(position.x * 7.13 + position.z * 3.7), uAmount) * (0.35 + 0.65 * aEnd);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vA;
      void main() { if (vA < 0.01) discard; gl_FragColor = vec4(uColor, vA * 0.75); }`,
    transparent: true, depthWrite: false,
  });
  const mesh = new THREE.LineSegments(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,240,200,1)');
  r.addColorStop(0.18, 'rgba(255,200,110,0.85)');
  r.addColorStop(0.5, 'rgba(255,150,60,0.18)');
  r.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const GLOW = { tex: null };

export class Weather {
  constructor(river) {
    this.river = river;
    this.storm = 0;           // current, eased
    this.target = 0;
    this.gust = 0;
    this.wind = new THREE.Vector2();
    this.flash = 0;
    this.nextFlash = 6;
    this.pendingThunder = [];
    this.rain = rainMesh();
    river.scene.add(this.rain);
    this.lamps = new THREE.Group();
    river.scene.add(this.lamps);
    this.waveTimer = 0;
    this.onThunder = null;    // (distance01) for the audio
    this.onFlash = null;
  }

  setStorm(v) { this.target = THREE.MathUtils.clamp(v, 0, 1); }

  // lanterns for a new place: on the moored and fishing pirogues, in the villages, on your boat
  place(world, moored) {
    this.lamps.clear();
    GLOW.tex ??= glowTexture();
    const mat = new THREE.SpriteMaterial({ map: GLOW.tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
    this.lampMat = mat;
    this.items = [];
    const add = (parent, x, y, z, size) => {
      const s = new THREE.Sprite(mat);
      s.position.set(x, y, z);
      s.scale.setScalar(size);
      parent.add(s);
      this.items.push({ s, size, phase: Math.random() * 10 });
    };
    for (const it of moored.items) add(it.g, -it.L * 0.3, 1.3, 0, 1.6);
    for (const v of world.villages) {
      for (let k = 0; k < 3; k++) add(this.lamps, v.centre.x + (Math.random() - 0.5) * 30, 1.6, v.centre.z + (Math.random() - 0.5) * 30, 2.2);
    }
    // your own boat: a lantern at the bow and a real light that reaches the water
    const g = this.river.pirogue.group;
    this.boatLamp?.parent?.remove(this.boatLamp);
    this.boatLamp = new THREE.PointLight(0xffb060, 0, 40, 1.6);
    this.boatLamp.position.set(this.river.pirogue.L * 0.3, 1.8, 0);
    g.add(this.boatLamp);
    add(this.boatLamp, 0, 0, 0, 1.4);
  }

  // per frame; returns whether the waves need rebuilding (the gusts changed them enough)
  update(dt, t, camera) {
    const r = this.river;
    this.storm += (this.target - this.storm) * Math.min(1, dt * 0.08);
    const s = this.storm;
    // gusts: slow noise, much stronger in the storm
    this.gust = 0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.077 + 1.3);
    const windSpeed = s * (4 + 10 * this.gust);
    const a = r.channel.meanAngle + 0.9 + Math.sin(t * 0.013) * 0.5;
    this.wind.set(Math.cos(a) * windSpeed, Math.sin(a) * windSpeed);

    // rain
    const u = this.rain.material.uniforms;
    u.uTime.value = t;
    u.uCam.value.copy(camera.position);
    u.uWind.value.copy(this.wind).multiplyScalar(0.35);
    u.uAmount.value = THREE.MathUtils.smoothstep(s, 0.35, 0.9);
    this.rain.visible = u.uAmount.value > 0.01;

    // lightning, thunder after the light (≈ 3 s a kilometre)
    this.flash = Math.max(0, this.flash - dt * 5);
    if (s > 0.6 && (this.nextFlash -= dt) <= 0) {
      this.nextFlash = 4 + Math.random() * 14 / s;
      const dist = Math.random();
      this.flash = 1 - dist * 0.6;
      this.onFlash?.(this.flash);
      this.pendingThunder.push({ at: t + 0.6 + dist * 6, dist });
    }
    for (let i = this.pendingThunder.length - 1; i >= 0; i--) {
      if (t >= this.pendingThunder[i].at) { this.onThunder?.(this.pendingThunder[i].dist); this.pendingThunder.splice(i, 1); }
    }

    // night lanterns, flickering; the boat lamp when the sun is down or the storm dark
    const night = 1 - THREE.MathUtils.smoothstep(r.sunElev ?? 30, -4, 5);
    const dark = Math.max(night, s * 0.5);
    for (const it of this.items ?? []) {
      it.s.visible = dark > 0.05;
      it.s.scale.setScalar(it.size * (0.9 + 0.12 * Math.sin(t * 9 + it.phase) * Math.sin(t * 3.1 + it.phase)) * Math.max(0.3, dark));
    }
    if (this.lampMat) this.lampMat.opacity = dark;
    if (this.boatLamp) this.boatLamp.intensity = dark * 14;
    this.night = night;

    this.waveTimer -= dt;
    if (this.waveTimer <= 0) { this.waveTimer = 0.4; return true; }
    return false;
  }

  // the factors RiverScene applies to the preset and the light
  get chop() { return 1 + this.storm * (1.2 + 1.6 * this.gust); }
  get darkness() { return this.storm * 0.62; }
  get haze() { return 1 + this.storm * 3.5; }
}
