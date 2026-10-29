import * as THREE from 'three';
import { createPerson } from './people.js';

// The people of the riverside villages (world.js `villages` spots): washing at the waterline,
// watching from the beach and waving at passing boats, walking between the huts.
// Each is a skinned person (people.js), so only those near the boat exist at a time: they are
// created when the boat comes within reach, animated while close, and dropped far behind.

const REACH = 340, KEEP = 520, MAX = 36;

export class Villagers {
  constructor(spots, channel) {
    this.group = new THREE.Group();
    this.channel = channel;
    this.slots = [];
    let seed = 400;
    for (const v of spots) {
      for (const p of v.people) this.slots.push({ ...p, seed: seed++, person: null, phase: (seed * 0.37) % 6.28 });
    }
    this.timer = 0;
    this.waving = 0;
  }

  // boat: {x, z}; t, dt: seconds
  update(boat, t, dt) {
    if ((this.timer -= dt) <= 0) {
      this.timer = 0.5;
      let alive = 0;
      for (const s of this.slots) {
        s.dist = Math.hypot(s.x - boat.x, s.z - boat.z);
        if (s.person && s.dist > KEEP) this.drop(s);
        if (s.person) alive++;
      }
      for (const s of this.slots) {
        if (alive >= MAX) break;
        if (!s.person && s.dist < REACH) { this.spawn(s); alive++; }
      }
    }
    for (const s of this.slots) {
      const p = s.person;
      if (!p) continue;
      const d = Math.hypot(s.x - boat.x, s.z - boat.z);
      if (s.role === 'watch') {
        // a wave for boats passing close, then back to watching
        const want = d < 90 ? 'wave' : 'stand';
        if (p.pose !== want) p.setPose(want);
        if (want === 'wave') p.group.rotation.y = -Math.atan2(boat.z - s.z, boat.x - s.x);
      } else if (s.role === 'walk') {
        // to and fro along the bank
        const k = Math.sin(t * 0.12 + s.phase), dir = Math.cos(t * 0.12 + s.phase) >= 0 ? 1 : -1;
        const fx = s.fx * dir, fz = s.fz * dir;
        p.group.position.set(s.x + s.fx * k * 9, s.y, s.z + s.fz * k * 9);
        p.group.rotation.y = -Math.atan2(fz, fx);
      }
      if (d < 260) p.update(t, dt, { speed: 1.1 });
    }
  }

  spawn(s) {
    const female = (s.seed * 7) % 10 < 6;
    const p = createPerson(s.seed, { female });
    const c = this.channel.at(this.channel.sample(s.x, s.z).s);
    s.fx = c.fx; s.fz = c.fz;
    p.setPose(s.role === 'wash' ? 'squat' : s.role === 'walk' ? 'walk' : 'stand');
    p.group.position.set(s.x, s.y, s.z);
    p.group.rotation.y = -s.face;
    s.person = p;
    this.group.add(p.group);
  }

  drop(s) {
    this.group.remove(s.person.group);
    s.person.material.dispose();
    s.person.mesh.skeleton.dispose();
    s.person = null;
  }

  dispose() {
    for (const s of this.slots) if (s.person) this.drop(s);
  }
}
