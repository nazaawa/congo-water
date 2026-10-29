import * as THREE from 'three';
import { PIROGUES } from './pirogues.js';

// Piloting the pirogue: a small boat model in the river frame (x downstream, z across).
// * Through the water: forward speed u with quadratic drag (top speed vmax at full
//   throttle), lateral speed v killed fast by the hull, yaw rate from the steering that
//   only bites once the boat moves.
// * Over the ground: add the current, full mid-river and slack near the banks, so a
//   crossing has to aim upstream or be carried down, as on the real Congo.
// * Banks and rocks stop the boat; reaching the landing ends the trip.
// A beacon (flag, ring, light shaft) marks the landing and wooden jetties stand at both ends.

const LIGHT = new THREE.Color(1, 0.84, 0.25);

function drcFlagTexture() {
  const c = document.createElement('canvas');
  c.width = 192; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#007fff'; g.fillRect(0, 0, 192, 128);
  // red diagonal edged with yellow, bottom-left to top-right
  g.save();
  g.translate(0, 128); g.rotate(-Math.atan2(128, 192));
  g.fillStyle = '#f7d618'; g.fillRect(-20, -22, 280, 44);
  g.fillStyle = '#ce1021'; g.fillRect(-20, -15, 280, 30);
  g.restore();
  // yellow star, top-left
  g.fillStyle = '#f7d618';
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 10 : 24, a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(36 + Math.cos(a) * r, 34 + Math.sin(a) * r);
  }
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// a wooden jetty from a point on the water `a` to the land `b`
function jetty(a, b) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b5138, roughness: 0.95 });
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(3, 0.16, len), wood);
  deck.position.set(len / 2, 0.85, 0);
  deck.rotation.y = Math.PI / 2;
  g.add(deck);
  for (let s = 0; s <= len; s += 3) {
    for (const side of [-1.35, 1.35]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 4, 6), wood);
      post.position.set(s, -1.1, side);
      g.add(post);
    }
  }
  g.position.set(a.x, 0, a.z);
  g.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function beacon(x, z, uniforms) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 11, 8), new THREE.MeshStandardMaterial({ color: 0xdedad2, roughness: 0.6 }));
  pole.position.set(x, 5.5, z);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(3, 2, 12, 1), new THREE.MeshStandardMaterial({ map: drcFlagTexture(), side: THREE.DoubleSide, roughness: 0.8 }));
  flag.geometry.translate(1.5, 0, 0);
  flag.position.set(x, 10, z);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(7, 0.35, 8, 48), new THREE.MeshBasicMaterial({ color: LIGHT, fog: false }));
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, 0.35, z);
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(5, 5, 160, 24, 1, true),
    new THREE.ShaderMaterial({
      uniforms: { uTime: uniforms.uTime, uColor: { value: LIGHT } },
      vertexShader: 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform float uTime; uniform vec3 uColor; varying float vY; void main(){ float a = (1.0 - vY) * (0.22 + 0.08 * sin(uTime * 3.0)); gl_FragColor = vec4(uColor * 1.6, a); }',
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }),
  );
  shaft.position.set(x, 80, z);
  pole.castShadow = flag.castShadow = true;
  g.add(pole, flag, ring, shaft);
  return { group: g, flag, ring };
}

export class Pilot {
  constructor(river) {
    this.river = river;
    this.active = false;
    this.input = { throttle: 0, steer: 0, boost: 1 };     // throttle is a lever (stays put), steer springs back
    this.timeScale = 1;
    this.group = new THREE.Group();
    this.flowDir = new THREE.Vector2(1, 0);
    this._c = {};
  }

  // mission: { start: {x, z}, end: {x, z} | null, heading, landSide: {start, end} }
  start(mission) {
    this.stop();
    const r = this.river, ch = r.channel;
    this.mission = mission;
    this.spec = PIROGUES[r.pirogue.kind];
    this.state = { x: mission.start.x, z: mission.start.z, heading: mission.heading, u: 0, v: 0, r: 0 };
    this.input.throttle = 0;
    this.input.steer = 0;
    this.time = 0;
    this.travelled = 0;
    this.trail = [[mission.start.x, mission.start.z]];
    this.arrived = false;
    this.grounded = 0;

    this.group = new THREE.Group();
    // jetties from just off the landing to dry land, square to the bank
    const pier = (P, side) => {
      const c = ch.sample(P.x, P.z);
      const a = ch.point(c.s, c.d + side * 4), b = ch.point(c.s, side * (ch.halfWidth + 8));
      this.group.add(jetty(a, b));
    };
    if (mission.landSide?.start) pier(mission.start, mission.landSide.start);
    if (mission.end) {
      const e = mission.end;
      if (mission.landSide?.end) pier(e, mission.landSide.end);
      this.beacon = beacon(e.x + 4, e.z, r.water.uniforms);
      this.group.add(this.beacon.group);
    }
    r.scene.add(this.group);
    this.active = true;
  }

  stop() {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose?.(); });
    this.beacon = null;
    this.active = false;
  }

  // the current along the bed: full mid-river, slack near the banks. Returns its speed and
  // fills this.flowDir with its direction
  current(x, z) {
    const r = this.river, p = r.preset, c = r.channel.sample(x, z, this._c);
    this.flowDir.set(c.fx, c.fz);
    const profile = THREE.MathUtils.smoothstep(p.halfWidth - Math.abs(c.d), 0, Math.min(80, p.halfWidth * 0.6));
    return p.flow * r.flowScale * profile;
  }

  blocked(x, z) {
    const w = this.river.world, c = this.river.channel.sample(x, z, this._c);
    if (c.s < 15 || c.s > this.river.channel.length - 15 || w.height(x, z) > -0.35) return true;   // ends of the modelled river, or the bank
    for (const r of w.rocks) if (Math.abs(x - r.x) < r.r + 1 && Math.hypot(x - r.x, z - r.z) < r.r * 0.9 + 0.5) return true;
    for (const h of this.river.fauna?.obstacles ?? []) if (h.r > 0 && Math.hypot(x - h.x, z - h.z) < h.r) return true;   // hippos
    return false;
  }

  step(dt) {
    const s = this.state, spec = this.spec, inp = this.input;
    this.river.pirogue.steer = inp.steer;
    if (!this.arrived) {
      let left = dt * this.timeScale;
      while (left > 1e-4) {
        const h = Math.min(left, 0.05);
        left -= h;
        // through the water
        const A = spec.vmax * 0.35;
        // boost: paddling in time with the chant (pilot UI), up to a third more push
        const thrust = inp.throttle >= 0 ? inp.throttle * (inp.boost ?? 1) : inp.throttle * 0.5;
        s.u += (thrust * A - (A / (spec.vmax * spec.vmax)) * s.u * Math.abs(s.u)) * h;
        s.v += -s.v * 2.5 * h;
        const bite = THREE.MathUtils.clamp(0.3 + Math.abs(s.u) / spec.vmax, 0.3, 1) * (s.u < -0.1 ? -1 : 1);
        s.r += (inp.steer * spec.turn * bite - s.r) * Math.min(1, h * 3);
        s.heading += s.r * h;
        // over the ground: add the current
        const fx = Math.cos(s.heading), fz = Math.sin(s.heading);
        const cur = this.current(s.x, s.z);
        // the wind leans on the boat too (a few percent of its speed, more for big hulls)
        const wind = this.river.weather?.wind, wk = 0.035 * Math.min(1.5, this.river.pirogue.L / 10);
        const vx = fx * s.u - fz * s.v + cur * this.flowDir.x + (wind ? wind.x * wk : 0), vz = fz * s.u + fx * s.v + cur * this.flowDir.y + (wind ? wind.y * wk : 0);
        const nx = s.x + vx * h, nz = s.z + vz * h;
        const bowX = nx + fx * this.river.pirogue.L * 0.45, bowZ = nz + fz * this.river.pirogue.L * 0.45;
        const bowHit = this.blocked(bowX, bowZ);
        if (bowHit || this.blocked(nx, nz)) {
          // ramming with the bow bounces back; otherwise (pushed sideways or backwards by the
          // current) slide along the obstacle and keep way on, so you can always motor off
          if (bowHit && s.u > 0.3) { s.u *= -0.25; this.grounded = 1.5; }
          s.v = 0;
          if (!this.blocked(nx, s.z) && !this.blocked(bowX, s.z + fz * this.river.pirogue.L * 0.45)) s.x = nx;
          else if (!this.blocked(s.x, nz) && !this.blocked(s.x + fx * this.river.pirogue.L * 0.45, bowZ)) s.z = nz;
        } else {
          this.travelled += Math.hypot(nx - s.x, nz - s.z);
          s.x = nx; s.z = nz;
        }
        this.time += h;
      }
      const last = this.trail.at(-1);
      if (Math.hypot(s.x - last[0], s.z - last[1]) > 4) this.trail.push([s.x, s.z]);
      const e = this.mission.end;
      if (e && Math.hypot(s.x - e.x, s.z - e.z) < 18) this.arrived = true;
    }
    this.grounded = Math.max(0, this.grounded - dt);

    if (this.beacon) {
      this.beacon.ring.scale.setScalar(1 + 0.08 * Math.sin(this.river.time * 3));
      const pos = this.beacon.flag.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 2.2 - this.river.time * 6) * 0.12 * (pos.getX(i) / 3));
      pos.needsUpdate = true;
    }
    return s;
  }

  // numbers for the HUD
  status() {
    const s = this.state, e = this.mission.end;
    return {
      x: s.x, z: s.z, heading: s.heading,
      speedWater: s.u,
      speedGround: (() => { const c = this.current(s.x, s.z); return Math.hypot(Math.cos(s.heading) * s.u + c * this.flowDir.x, Math.sin(s.heading) * s.u + c * this.flowDir.y); })(),
      current: this.current(s.x, s.z),
      remaining: e ? Math.hypot(e.x - s.x, e.z - s.z) : null,
      bearingToEnd: e ? Math.atan2(e.z - s.z, e.x - s.x) : null,
      time: this.time, travelled: this.travelled, arrived: this.arrived, grounded: this.grounded > 0,
      throttle: this.input.throttle,
    };
  }
}
