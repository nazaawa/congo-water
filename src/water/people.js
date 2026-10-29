import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';

// People on the boats and the banks: skinned, lofted bodies after mrdoob's slop-newyork
// (https://github.com/mrdoob/slop-newyork, MIT): a 15-bone skeleton, a body lofted from
// superellipse rings (profiles, head sculpting, hair shell and shoes are that project's),
// a female shape and hair volume as morph targets, and a seeded appearance. Ported to the
// WebGL renderer: one shared geometry, a SkinnedMesh per person, clothes painted per body
// part in a patched MeshStandardMaterial (Congolese wax prints, shirts, Léopards jerseys).
// Poses are FK plus two-bone IK for the arms on the paddle or pole and the legs when seated.

// ============================================================================
// 1. SKELETON & PROFILES (from slop-newyork)
// ============================================================================
const BONE = {
  PELVIS: 0,
  CHEST: 1,
  HEAD: 2,
  UPPER_ARM_L: 3,
  FOREARM_L: 4,
  UPPER_ARM_R: 5,
  FOREARM_R: 6,
  THIGH_L: 7,
  SHIN_L: 8,
  FOOT_L: 9,
  TOE_L: 10,
  THIGH_R: 11,
  SHIN_R: 12,
  FOOT_R: 13,
  TOE_R: 14
};
const BONE_COUNT = 15;

// Bind pose (metres, a 1.75 m person standing at the origin facing +Z, +X on their left): legs straight down, arms
// hanging 8 degrees out from the body
const THIGH = 0.42;
const SHIN = 0.42;
const ANKLE_H = 0.08;
const HIP_X = 0.09;
const UPPER_ARM = 0.3;
const FOREARM = 0.255;
const ARM_BIND_ABDUCTION = 0.14;
const PELVIS_Y = 0.96;
const HIP_Y = ANKLE_H + SHIN + THIGH;
const SIDES = [1, -1]; // left (+X), right (-X)
const LIMB = {
  upperArm: [BONE.UPPER_ARM_L, BONE.UPPER_ARM_R],
  forearm: [BONE.FOREARM_L, BONE.FOREARM_R],
  thigh: [BONE.THIGH_L, BONE.THIGH_R],
  shin: [BONE.SHIN_L, BONE.SHIN_R],
  foot: [BONE.FOOT_L, BONE.FOOT_R],
  toe: [BONE.TOE_L, BONE.TOE_R]
};

function shoulderJoint(female) {
  return female ? [0.165, 1.415, -0.015] : [0.185, 1.43, -0.015];
}

function bindJoints(female) {
  const sh = shoulderJoint(female);
  const ax = Math.sin(ARM_BIND_ABDUCTION) * UPPER_ARM;
  const ay = -Math.cos(ARM_BIND_ABDUCTION) * UPPER_ARM;
  const j = [];
  j[BONE.PELVIS] = new THREE.Vector3(0, PELVIS_Y, 0);
  j[BONE.CHEST] = new THREE.Vector3(0, 1.12, -0.01);
  j[BONE.HEAD] = new THREE.Vector3(0, 1.52, -0.012);
  SIDES.forEach((side, k) => {
    j[LIMB.upperArm[k]] = new THREE.Vector3(side * sh[0], sh[1], sh[2]);
    j[LIMB.forearm[k]] = new THREE.Vector3(side * (sh[0] + ax), sh[1] + ay, sh[2]);
    j[LIMB.thigh[k]] = new THREE.Vector3(side * HIP_X, HIP_Y, 0);
    j[LIMB.shin[k]] = new THREE.Vector3(side * HIP_X, ANKLE_H + SHIN, 0);
    j[LIMB.foot[k]] = new THREE.Vector3(side * HIP_X, ANKLE_H, 0);
    j[LIMB.toe[k]] = new THREE.Vector3(side * HIP_X, 0.02, 0.135);
  });
  return j;
}
const BIND = [bindJoints(false), bindJoints(true)];


// Superellipse ring around a vertical axis (x across, z to the front `rzF` or back `rzB`); `bump(a)` pushes points out
function ringY(y, rx, rzF, rzB, cz, n, ex = 2, bump = null, cx = 0) {
  const e = 2 / ex;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let x = Math.sign(c) * Math.abs(c) ** e * rx;
    let z = Math.sign(s) * Math.abs(s) ** e * (s >= 0 ? rzF : rzB);
    const b = bump ? bump(a) : 0;
    if (b) {
      const r = Math.hypot(x, z) || 1;
      x += (x / r) * b;
      z += (z / r) * b;
    }
    out.push(new THREE.Vector3(cx + x, y, cz + z));
  }
  return out;
}

const _down = new THREE.Vector3(0, -1, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
// Ring around a limb axis `dir` (rows run along it): x stays roughly across the body, z to the front; `twist` turns
// the ring about the axis
function limbRing(center, dir, rx, rz, n, ex = 2, twist = 0) {
  const q = new THREE.Quaternion().setFromUnitVectors(_down, dir);
  return ringY(0, rx, rz, rz, 0, n, ex).map((p) => p.applyAxisAngle(_yAxis, twist).applyQuaternion(q).add(center));
}

// Gaussian bump around angle a0 (wrapping)
function lobe(a, a0, width) {
  let d = a - a0;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  return Math.exp(-(d * d) / (width * width));
}

// Closed loft through rings of equal size (rows of the surface), with optional flat caps (centroid fans). Returns
// positions, uvs (u along the rows, v around), indices and the row each vertex belongs to; rings with the same layout
// give vertex-for-vertex matching positions, which the morph targets rely on.
function loftRings(sections, capStart, capEnd) {
  const rows = sections.length;
  const columns = sections[0].length;
  const per = columns + 1;
  const positions = [];
  const uvs = [];
  const indices = [];
  const rowOf = [];
  const rowU = [0];
  for (let i = 1; i < rows; i++) {
    let d = 0;
    for (let j = 0; j < columns; j++) d += sections[i][j].distanceTo(sections[i - 1][j]);
    rowU.push(rowU[i - 1] + d / columns);
  }
  const totalU = rowU[rows - 1] || 1;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < per; j++) {
      const p = sections[i][j % columns];
      positions.push(p.x, p.y, p.z);
      uvs.push(rowU[i] / totalU, j / columns);
      rowOf.push(i);
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < columns; j++) {
      const a = i * per + j;
      const b = a + 1;
      const c = a + per + 1;
      const d = a + per;
      indices.push(a, b, d, b, c, d);
    }
  }
  const cap = (row, flip) => {
    const start = positions.length / 3;
    const centre = new THREE.Vector3();
    for (let j = 0; j < columns; j++) {
      const p = sections[row][j];
      centre.add(p);
      positions.push(p.x, p.y, p.z);
      uvs.push(row === 0 ? 0 : 1, j / columns);
      rowOf.push(row);
    }
    centre.divideScalar(columns);
    positions.push(centre.x, centre.y, centre.z);
    uvs.push(row === 0 ? 0 : 1, 0.5);
    rowOf.push(row);
    const c = start + columns;
    for (let j = 0; j < columns; j++) {
      const a = start + j;
      const b = start + ((j + 1) % columns);
      if (flip) indices.push(c, b, a);
      else indices.push(c, a, b);
    }
  };
  // rings run counter-clockwise looking back along the rows: the first cap faces back, the last one forward
  if (capStart) cap(0, true);
  if (capEnd) cap(rows - 1, false);
  return { positions, uvs, indices, rowOf, rows, per };
}

const _seam = new THREE.Vector3();

// Profiles: [y, rx, rzFront, rzBack, centreZ, keepInFarLod] for the male base and the female morph target
const TORSO = {
  m: [
    [1.615, 0.046, 0.044, 0.048, -0.004, 1],
    [1.575, 0.051, 0.049, 0.053, -0.008, 0],
    [1.53, 0.058, 0.053, 0.057, -0.013, 1],
    [1.5, 0.1, 0.064, 0.07, -0.018, 0],
    [1.47, 0.163, 0.08, 0.082, -0.02, 1],
    [1.44, 0.188, 0.095, 0.089, -0.018, 1],
    [1.4, 0.186, 0.108, 0.093, -0.014, 0],
    [1.34, 0.177, 0.118, 0.096, -0.01, 1],
    [1.27, 0.167, 0.117, 0.093, -0.006, 0],
    [1.2, 0.157, 0.11, 0.089, -0.002, 1],
    [1.13, 0.15, 0.104, 0.086, 0, 0],
    [1.06, 0.154, 0.101, 0.089, 0, 1],
    [0.99, 0.163, 0.099, 0.099, 0, 0],
    [0.935, 0.166, 0.095, 0.106, 0, 1],
    [0.885, 0.152, 0.078, 0.1, 0, 0],
    [0.845, 0.1, 0.055, 0.075, 0, 1]
  ],
  f: [
    [1.615, 0.042, 0.04, 0.044, -0.004],
    [1.575, 0.045, 0.043, 0.047, -0.008],
    [1.53, 0.051, 0.047, 0.051, -0.012],
    [1.5, 0.086, 0.056, 0.062, -0.016],
    [1.47, 0.142, 0.072, 0.074, -0.018],
    [1.44, 0.164, 0.085, 0.081, -0.016],
    [1.4, 0.163, 0.1, 0.084, -0.012],
    [1.34, 0.157, 0.122, 0.087, -0.006],
    [1.27, 0.148, 0.118, 0.084, -0.002],
    [1.2, 0.136, 0.097, 0.08, 0],
    [1.13, 0.127, 0.09, 0.078, 0],
    [1.06, 0.144, 0.094, 0.086, 0],
    [0.99, 0.165, 0.098, 0.103, 0],
    [0.935, 0.174, 0.096, 0.112, 0],
    [0.885, 0.16, 0.08, 0.106, 0],
    [0.845, 0.104, 0.056, 0.078, 0]
  ]
};

function torsoSkin(y) {
  if (y > 1.6) return [BONE.CHEST, BONE.HEAD, 1];
  if (y > 1.56) return [BONE.CHEST, BONE.HEAD, 0.65];
  if (y > 1.52) return [BONE.CHEST, BONE.HEAD, 0.2];
  if (y > 1.15) return [BONE.CHEST, BONE.CHEST, 0];
  if (y > 1.1) return [BONE.PELVIS, BONE.CHEST, 0.5];
  if (y > 1.03) return [BONE.PELVIS, BONE.CHEST, 0.15];
  return [BONE.PELVIS, BONE.PELVIS, 0];
}

// [y, rx, rzFront, rzBack, centreZ, keepInFarLod] around each leg's axis (x = +-HIP_X)
const LEG = {
  m: [
    [0.975, 0.054, 0.054, 0.054, 0, 1],
    [0.925, 0.062, 0.072, 0.075, 0, 0],
    [0.865, 0.083, 0.088, 0.091, 0.003, 1],
    [0.77, 0.078, 0.083, 0.083, 0.006, 0],
    [0.67, 0.071, 0.075, 0.073, 0.008, 1],
    [0.59, 0.064, 0.067, 0.064, 0.008, 0],
    [0.535, 0.058, 0.062, 0.058, 0.008, 1],
    [0.5, 0.056, 0.061, 0.056, 0.008, 1],
    [0.465, 0.054, 0.058, 0.056, 0.004, 1],
    [0.415, 0.054, 0.056, 0.06, 0, 0],
    [0.335, 0.053, 0.054, 0.061, -0.004, 1],
    [0.245, 0.051, 0.052, 0.054, -0.003, 0],
    [0.17, 0.051, 0.053, 0.053, 0, 1],
    [0.13, 0.052, 0.055, 0.053, 0.004, 0],
    [0.1, 0.044, 0.046, 0.044, 0.004, 1]
  ],
  f: [
    [0.975, 0.056, 0.056, 0.056, 0],
    [0.925, 0.066, 0.074, 0.08, 0],
    [0.865, 0.087, 0.087, 0.094, 0.003],
    [0.77, 0.078, 0.079, 0.08, 0.006],
    [0.67, 0.067, 0.069, 0.067, 0.008],
    [0.59, 0.057, 0.059, 0.057, 0.008],
    [0.535, 0.051, 0.055, 0.051, 0.008],
    [0.5, 0.049, 0.053, 0.049, 0.008],
    [0.465, 0.047, 0.051, 0.049, 0.004],
    [0.415, 0.047, 0.049, 0.054, 0],
    [0.335, 0.046, 0.047, 0.056, -0.004],
    [0.245, 0.04, 0.042, 0.045, -0.003],
    [0.17, 0.035, 0.037, 0.037, 0],
    [0.13, 0.034, 0.036, 0.035, 0.003],
    [0.1, 0.031, 0.033, 0.032, 0.003]
  ]
};

function legSkin(y, k) {
  const thigh = LIMB.thigh[k];
  const shin = LIMB.shin[k];
  const foot = LIMB.foot[k];
  // the hip bends over 0.75-0.95 m, below the jacket's hem, so the thigh tops stay inside the pelvis
  if (y > 0.95) return [BONE.PELVIS, thigh, 0.05];
  if (y > 0.9) return [BONE.PELVIS, thigh, 0.3];
  if (y > 0.84) return [BONE.PELVIS, thigh, 0.72];
  if (y > 0.74) return [BONE.PELVIS, thigh, 0.93];
  if (y > 0.55) return [thigh, thigh, 0];
  if (y > 0.52) return [thigh, shin, 0.12];
  if (y > 0.48) return [thigh, shin, 0.5];
  if (y > 0.44) return [thigh, shin, 0.88];
  if (y > 0.15) return [shin, shin, 0];
  if (y > 0.115) return [shin, foot, 0.25];
  return [shin, foot, 0.5];
}

// [distance along the arm from the shoulder, rx, rz, offset towards the body's side, offset forward, keepInFarLod]
const ARM = [
  [-0.022, 0.026, 0.032, -0.024, 0, 1],
  [-0.008, 0.042, 0.05, -0.014, 0, 0],
  [0.012, 0.052, 0.057, -0.006, 0, 1],
  [0.05, 0.055, 0.057, 0.001, 0, 0],
  [0.1, 0.052, 0.052, 0.003, 0, 1],
  [0.16, 0.048, 0.049, 0.001, 0.003, 0],
  [0.23, 0.044, 0.046, 0, 0, 1],
  [0.272, 0.042, 0.043, 0, -0.003, 0],
  [0.3, 0.041, 0.042, 0, -0.005, 1],
  [0.328, 0.042, 0.043, 0, -0.003, 0],
  [0.39, 0.043, 0.042, 0, 0, 1],
  [0.465, 0.038, 0.035, 0, 0, 0],
  [0.525, 0.034, 0.031, 0, 0, 1],
  [0.542, 0.036, 0.033, 0, 0, 1],
  [0.55, 0.028, 0.026, 0, 0, 1]
];
// [distance along the arm, thickness (across), width (front-back), offset forward, keepInFarLod]
const HAND = [
  [0.525, 0.023, 0.026, 0, 1],
  [0.555, 0.021, 0.03, 0.002, 0],
  [0.595, 0.023, 0.04, 0.004, 1],
  [0.64, 0.021, 0.042, 0.004, 0],
  [0.68, 0.017, 0.037, 0.002, 1],
  [0.712, 0.013, 0.028, 0, 0],
  [0.728, 0.008, 0.015, 0, 1]
];
const HAND_TWIST = 0.45; // relaxed hands: palms turned from facing the thighs towards the back

function armSkin(d, k) {
  const ua = LIMB.upperArm[k];
  const fa = LIMB.forearm[k];
  if (d < -0.03) return [BONE.CHEST, ua, 0.32];
  if (d < 0) return [BONE.CHEST, ua, 0.6];
  if (d < 0.06) return [BONE.CHEST, ua, 0.88];
  if (d < 0.26) return [ua, ua, 0];
  if (d < 0.29) return [ua, fa, 0.15];
  if (d < 0.315) return [ua, fa, 0.5];
  if (d < 0.36) return [ua, fa, 0.85];
  return [fa, fa, 0];
}

// [y, rx, rzFront, rzBack, centreZ, keepInFarLod]
const HEAD = {
  m: [
    [1.752, 0.018, 0.018, 0.02, -0.012, 1],
    [1.738, 0.056, 0.058, 0.064, -0.013, 0],
    [1.712, 0.078, 0.082, 0.092, -0.013, 1],
    [1.682, 0.087, 0.09, 0.102, -0.011, 0],
    [1.652, 0.088, 0.093, 0.103, -0.009, 1],
    [1.622, 0.084, 0.094, 0.098, -0.007, 0],
    [1.592, 0.078, 0.095, 0.09, -0.005, 1],
    [1.562, 0.071, 0.091, 0.078, -0.002, 0],
    [1.537, 0.063, 0.085, 0.066, 0.002, 1],
    [1.514, 0.052, 0.074, 0.054, 0.008, 0],
    [1.497, 0.03, 0.048, 0.032, 0.016, 1]
  ],
  f: [
    [1.748, 0.017, 0.017, 0.019, -0.012],
    [1.734, 0.053, 0.055, 0.061, -0.013],
    [1.709, 0.074, 0.078, 0.088, -0.013],
    [1.68, 0.083, 0.086, 0.097, -0.011],
    [1.651, 0.083, 0.089, 0.098, -0.009],
    [1.622, 0.079, 0.09, 0.093, -0.007],
    [1.594, 0.073, 0.09, 0.085, -0.005],
    [1.566, 0.066, 0.086, 0.073, -0.002],
    [1.543, 0.058, 0.08, 0.061, 0.002],
    [1.522, 0.046, 0.068, 0.049, 0.008],
    [1.507, 0.026, 0.042, 0.028, 0.014]
  ]
};

// Nose, brow, cheekbones, chin & ears pushed out of the head's rings
function headBump(y) {
  const front = Math.PI / 2;
  return (a) => {
    let b = 0;
    if (Math.abs(y - 1.592) < 0.02) b += 0.017 * lobe(a, front, 0.16); // nose tip
    if (Math.abs(y - 1.622) < 0.02) b += 0.007 * lobe(a, front, 0.14); // bridge
    if (Math.abs(y - 1.652) < 0.02) b += 0.004 * lobe(a, front, 0.6); // brow ridge
    if (Math.abs(y - 1.562) < 0.02) b += 0.004 * lobe(a, front, 0.2) + 0.004 * (lobe(a, front - 0.75, 0.3) + lobe(a, front + 0.75, 0.3));
    if (Math.abs(y - 1.514) < 0.012) b += 0.006 * lobe(a, front, 0.35); // chin
    if (y < 1.64 && y > 1.575) b += 0.011 * (lobe(a, -0.12, 0.22) + lobe(a, Math.PI + 0.12, 0.22)); // ears
    return b;
  };
}

// Head profile at any height (for the hair shell)
function headAt(table, y) {
  if (y >= table[0][0]) return table[0];
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i];
    const b = table[i + 1];
    if (y <= a[0] && y >= b[0]) {
      const t = (a[0] - y) / (a[0] - b[0]);
      return a.map((v, k) => v + (b[k] - v) * t);
    }
  }
  return table[table.length - 1];
}

const hairlineY = (a) => 1.62 + 0.055 * Math.sin(a) - 0.005 * Math.cos(2 * a);

// Hair shell over the scalp, from the crown to the hairline, `t` thick (thinning to a soft edge at the hairline)
function hairShellRing(table, f, t, n) {
  const crown = table[0][0];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const y = crown + (hairlineY(a) - crown) * f;
    const [, rx, rzF, rzB, cz] = headAt(table, y);
    const p = new THREE.Vector3(Math.cos(a) * rx, y, cz + Math.sin(a) * (Math.sin(a) >= 0 ? rzF : rzB));
    const k = t * (1 - 0.75 * f * f);
    const c = new THREE.Vector3(0, 1.635, -0.012);
    out.push(p.sub(c).multiplyScalar(1 + k / Math.max(0.05, p.length())).add(c));
  }
  return out;
}

// [z from the ankle, half width, top, sole, keepInFarLod] (relative to the ankle joint)
const SHOE = [
  [-0.088, 0.02, -0.02, -0.066, 1],
  [-0.078, 0.034, 0.016, -0.08, 0],
  [-0.05, 0.042, 0.036, -0.08, 1],
  [-0.01, 0.045, 0.032, -0.08, 0],
  [0.04, 0.048, 0.006, -0.08, 1],
  [0.09, 0.05, -0.022, -0.08, 0],
  [0.13, 0.051, -0.035, -0.08, 1],
  [0.165, 0.048, -0.044, -0.08, 0],
  [0.192, 0.039, -0.05, -0.079, 1],
  [0.208, 0.022, -0.056, -0.075, 1]
];

function shoeRing(cx, z, hw, top, sole, n) {
  const out = [];
  const mid = sole + (top - sole) * 0.38;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = Math.sign(c) * Math.abs(c) ** 0.6 * hw;
    const y = s >= 0 ? mid + (top - mid) * s ** 0.85 : mid - (mid - sole) * Math.abs(s) ** 0.35;
    out.push(new THREE.Vector3(cx + x, ANKLE_H + y, z));
  }
  return out;
}

function shoeSkin(z, k) {
  const foot = LIMB.foot[k];
  const toe = LIMB.toe[k];
  if (z < 0.07) return [foot, foot, 0];
  if (z < 0.11) return [foot, toe, 0.12];
  if (z < 0.15) return [foot, toe, 0.55];
  return [toe, toe, 0];
}


// ============================================================================
// 2. GEOMETRY: LOFTED, SKINNED (4 influences), FEMALE / HAIR / GIRTH MORPHS
// ============================================================================
const PART = { BODY: 0, LEG: 1, SHOE: 2, ARM: 3, HAND: 4, HEAD: 5, HAIR: 6, SKIRT: 8, WRAP: 9 };

// rows: { pts, ptsF, ptsH, axis, skin: [boneA, boneB, weightB] | skinFn: (x, y, z) => [[bone, weight], ...] }
function loft(out, rows, part, { capStart = false, capEnd = false, flattenBelow = -1 } = {}) {
  const lo = loftRings(rows.map((r) => r.pts), capStart, capEnd);
  const variant = (key) => (rows.some((r) => r[key]) ? loftRings(rows.map((r) => r[key] || r.pts), capStart, capEnd).positions : null);
  const fem = variant('ptsF'), vol = variant('ptsH');
  const pos = lo.positions, count = pos.length / 3;
  const geo = new THREE.BufferGeometry();
  geo.setIndex(lo.indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  // weld the normals along the seam of every ring; soften downward normals low on the trousers
  const normals = geo.attributes.normal;
  for (let i = 0; i < lo.rows; i++) {
    const a = i * lo.per, b = a + lo.per - 1;
    _seam.set(normals.getX(a) + normals.getX(b), normals.getY(a) + normals.getY(b), normals.getZ(a) + normals.getZ(b)).normalize();
    normals.setXYZ(a, _seam.x, _seam.y, _seam.z);
    normals.setXYZ(b, _seam.x, _seam.y, _seam.z);
  }
  for (let v = 0; v < count; v++) {
    if (pos[v * 3 + 1] >= flattenBelow || normals.getY(v) >= 0) continue;
    _seam.set(normals.getX(v), normals.getY(v) * 0.3, normals.getZ(v)).normalize();
    normals.setXYZ(v, _seam.x, _seam.y, _seam.z);
  }
  const si = new Uint16Array(count * 4), sw = new Float32Array(count * 4), pa = new Float32Array(count).fill(part);
  const dF = new Float32Array(count * 3), dH = new Float32Array(count * 3), dG = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const row = rows[lo.rowOf[v]], x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const inf = row.skinFn ? row.skinFn(x, y, z) : [[row.skin[0], 1 - row.skin[2]], [row.skin[1], row.skin[2]]];
    const merged = new Map();
    for (const [b, w] of inf) if (w > 0) merged.set(b, (merged.get(b) ?? 0) + w);
    const list = [...merged].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const tot = list.reduce((s, e) => s + e[1], 0) || 1;
    list.forEach(([b, w], k) => { si[v * 4 + k] = b; sw[v * 4 + k] = w / tot; });
    if (row.axis) {
      // girth: push out from the ring's axis (horizontally on the torso, radially on the limbs)
      dG[v * 3] = (x - row.axis.x) * 0.28;
      dG[v * 3 + 1] = (y - row.axis.y) * 0.28;
      dG[v * 3 + 2] = (z - row.axis.z) * 0.28;
    }
    for (let k = 0; k < 3; k++) {
      if (fem) dF[v * 3 + k] = fem[v * 3 + k] - pos[v * 3 + k];
      if (vol) dH[v * 3 + k] = vol[v * 3 + k] - pos[v * 3 + k];
    }
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geo.setAttribute('part', new THREE.Float32BufferAttribute(pa, 1));
  geo.morphAttributes.position = [dF, dH, dG].map((d) => new THREE.Float32BufferAttribute(d, 3));
  geo.morphTargetsRelative = true;
  out.push(geo);
}

// Wrap skirt (pagne) over both legs: pelvis at the waist, then the thighs, the shins below the knee
const SKIRT = [
  [1.05, 0.152, 0.104, 0.098], [0.99, 0.172, 0.118, 0.12], [0.92, 0.188, 0.128, 0.134], [0.82, 0.19, 0.128, 0.13],
  [0.7, 0.186, 0.122, 0.122], [0.6, 0.181, 0.116, 0.114], [0.5, 0.176, 0.11, 0.108], [0.4, 0.17, 0.105, 0.104], [0.3, 0.166, 0.102, 0.1],
];
function skirtSkin(x, y) {
  const s = THREE.MathUtils.clamp(0.5 + x / 0.2, 0, 1);    // share of the left leg (+X)
  if (y > 0.5) {
    const legW = THREE.MathUtils.clamp((1.0 - y) / 0.4, 0, 1) * (0.55 + 0.45 * Math.min(1, Math.abs(x) / 0.08));
    return [[BONE.PELVIS, 1 - legW], [BONE.THIGH_L, legW * s], [BONE.THIGH_R, legW * (1 - s)]];
  }
  const t = THREE.MathUtils.clamp((0.5 - y) / 0.16, 0, 1) * 0.85;
  return [[BONE.THIGH_L, s * (1 - t)], [BONE.SHIN_L, s * t], [BONE.THIGH_R, (1 - s) * (1 - t)], [BONE.SHIN_R, (1 - s) * t]];
}

const _geoCache = new Map();
function personGeometry(skirt) {
  if (_geoCache.has(skirt)) return _geoCache.get(skirt);
  const G = [];
  const nTorso = 16, nLeg = 12, nArm = 10, nHand = 8, nHead = 20, nShoe = 12;
  const bust = (a) => 0.011 * (lobe(a, Math.PI / 2 - 0.5, 0.38) + lobe(a, Math.PI / 2 + 0.5, 0.38));
  loft(G, TORSO.m.map((m, i) => {
    const f = TORSO.f[i], ex = m[0] > 1.5 ? 2 : m[0] > 1.0 ? 2.35 : 2.15;
    const fBump = m[0] < 1.37 && m[0] > 1.25 ? bust : null;
    return {
      pts: ringY(m[0], m[1], m[2], m[3], m[4], nTorso, ex), ptsF: ringY(f[0], f[1], f[2], f[3], f[4], nTorso, ex, fBump),
      skin: torsoSkin(m[0]), axis: new THREE.Vector3(0, m[0], m[4]),
    };
  }), PART.BODY, { capEnd: true, flattenBelow: 0.95 });

  SIDES.forEach((side, k) => {
    const cx = side * HIP_X;
    loft(G, LEG.m.map((m, i) => {
      const f = LEG.f[i];
      return {
        pts: ringY(m[0], m[1], m[2], m[3], m[4], nLeg, 2, null, cx), ptsF: ringY(f[0], f[1], f[2], f[3], f[4], nLeg, 2, null, cx),
        skin: legSkin(m[0], k), axis: new THREE.Vector3(cx, m[0], m[4]),
      };
    }), PART.LEG, { capStart: true, capEnd: true });
  });

  SIDES.forEach((side, k) => {
    const dir = new THREE.Vector3(side * Math.sin(ARM_BIND_ABDUCTION), -Math.cos(ARM_BIND_ABDUCTION), 0);
    const shM = new THREE.Vector3(...shoulderJoint(false)), shF = new THREE.Vector3(...shoulderJoint(true));
    shM.x *= side; shF.x *= side;
    const at = (sh, d, ox, oz) => sh.clone().addScaledVector(dir, d).add(new THREE.Vector3(side * ox, 0, oz));
    loft(G, ARM.map(([d, rx, rz, ox, oz]) => {
      const c = at(shM, d, ox, oz);
      return { pts: limbRing(c, dir, rx, rz, nArm), ptsF: limbRing(at(shF, d, ox * 0.9, oz), dir, rx * 0.84, rz * 0.84, nArm), skin: armSkin(d, k), axis: c };
    }), PART.ARM, { capStart: true, capEnd: true });
    const twist = -side * HAND_TWIST;
    loft(G, HAND.map(([d, rx, rz, oz]) => ({
      pts: limbRing(at(shM, d, 0, oz), dir, rx, rz, nHand, 2, twist),
      ptsF: limbRing(at(shF, d * 0.985, 0, oz), dir, rx * 0.88, rz * 0.88, nHand, 2, twist),
      skin: [LIMB.forearm[k], LIMB.forearm[k], 0],
    })), PART.HAND, { capStart: true, capEnd: true });
    const thumb = [[0.565, 0.026, 0.011], [0.605, 0.038, 0.0105], [0.64, 0.044, 0.008]].map(([d, oz, r]) => {
      const off = new THREE.Vector3(side * -0.006, 0, oz).applyAxisAngle(_yAxis, twist);
      return {
        pts: limbRing(shM.clone().addScaledVector(dir, d).add(off), dir, r, r, 6),
        ptsF: limbRing(shF.clone().addScaledVector(dir, d * 0.985).addScaledVector(off, 0.9), dir, r * 0.88, r * 0.88, 6),
        skin: [LIMB.forearm[k], LIMB.forearm[k], 0],
      };
    });
    loft(G, thumb, PART.HAND, { capStart: true, capEnd: true });
  });

  loft(G, HEAD.m.map((m, i) => {
    const f = HEAD.f[i];
    return {
      pts: ringY(m[0], m[1], m[2], m[3], m[4], nHead, 2, headBump(m[0])),
      ptsF: ringY(f[0], f[1], f[2], f[3], f[4], nHead, 2, headBump(m[0])),
      skin: [BONE.HEAD, BONE.HEAD, 0],
    };
  }), PART.HEAD, { capStart: true, capEnd: true });

  // hair shell: close-cropped, with a volume morph for an afro
  loft(G, [0.04, 0.22, 0.45, 0.68, 0.86, 1].map((f) => ({
    pts: hairShellRing(HEAD.m, f, 0.006, nHead), ptsF: hairShellRing(HEAD.f, f, 0.006, nHead), ptsH: hairShellRing(HEAD.m, f, 0.03, nHead),
    skin: [BONE.HEAD, BONE.HEAD, 0],
  })), PART.HAIR, { capStart: true });

  SIDES.forEach((side, k) => {
    loft(G, SHOE.map(([z, hw, top, sole]) => ({
      pts: shoeRing(side * HIP_X, z, hw, top, sole, nShoe),
      ptsF: shoeRing(side * HIP_X, z * 0.93, hw * 0.88, top * 0.92, sole, nShoe),
      skin: shoeSkin(z, k),
    })), PART.SHOE, { capStart: true, capEnd: true });
  });

  if (skirt) {
    loft(G, SKIRT.map(([y, rx, rzF, rzB]) => ({ pts: ringY(y, rx, rzF, rzB, 0.004, 18, 2.2), skinFn: skirtSkin })), PART.SKIRT, {});
  }
  const geo = mergeGeometries(G);
  geo.morphTargetsRelative = true;
  geo.computeBoundingSphere();
  _geoCache.set(skirt, geo);
  return geo;
}

// head wrap (foulard / gele) in the bind space of the head
let _wrapGeo = null;
function wrapGeometry() {
  if (_wrapGeo) return _wrapGeo;
  const prof = [[0.098, 1.648], [0.106, 1.69], [0.108, 1.735], [0.1, 1.78], [0.082, 1.815], [0.05, 1.836], [0.001, 1.842]].map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(prof, 22).translate(0, 0, -0.012);
  const knot = new THREE.SphereGeometry(0.05, 10, 8).scale(1.2, 0.8, 1).translate(0, 1.79, -0.09);
  const fold = new THREE.TorusGeometry(0.1, 0.014, 6, 22).rotateX(Math.PI / 2).scale(1.02, 1, 1.08).translate(0, 1.72, -0.012);
  _wrapGeo = mergeGeometries([g, knot, fold]);
  _wrapGeo.setAttribute('part', new THREE.Float32BufferAttribute(new Float32Array(_wrapGeo.attributes.position.count).fill(PART.WRAP), 1));
  return _wrapGeo;
}
let _hatGeo = null;
function hatGeometry() {
  // brimmed bucket / straw hat
  _hatGeo ??= new THREE.LatheGeometry([[0.001, 1.835], [0.088, 1.83], [0.1, 1.79], [0.106, 1.72], [0.175, 1.7], [0.185, 1.69], [0.112, 1.705], [0.098, 1.705]]
    .map(([r, y]) => new THREE.Vector2(r, y)), 24).translate(0, 0, -0.012);
  return _hatGeo;
}

// ============================================================================
// 3. MATERIAL: CLOTHES PAINTED PER BODY PART
// ============================================================================
const SKIN = [0x3b2417, 0x4a2c1c, 0x5a3622, 0x6b4029, 0x2e1c12, 0x553220];
const SKIN_TOURIST = [0xc68863, 0xd9a077, 0xa96f4c, 0x8a5535, 0x4a2c1c];
const WAX = [0xf2b705, 0xd7263d, 0x1b4f9c, 0x2a9d8f, 0xf46036, 0x7b2d8e, 0x1f7a3a, 0x12100e, 0xf3ead6];
const SHIRT = [0xf1ede4, 0x2c5f8a, 0xd8cfb8, 0x8a3b2c, 0x3f6b3a, 0x9aa7b8, 0xe0b23a, 0x5b3b6e, 0x222024];
const TROUSERS = [0x23262e, 0x35485b, 0x51473d, 0x6e6452, 0x1d1d20, 0x3a4530];
const TOURIST = [0xf6f2ea, 0xa9c6e0, 0xe8d9b0, 0xd9e8d0, 0xf2c6b8];
const SHOES = [0x15130f, 0x2c5f8a, 0xd7263d, 0x3a2a1c, 0xe9e4d8];
const PAT = { plain: 0, stripes: 1, wax: 2, jersey: 3, vest: 4, checks: 5 };

const personVertex = (src) => src
  .replace('#include <common>', 'attribute float part;\nvarying vec3 vBind;\nvarying float vPart;\n#include <common>')
  .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;\nvPart = part;');

const personFragment = (src) => src
  .replace('#include <common>', `#include <common>
uniform vec3 uSkin, uTop, uArm, uBottom, uHair, uShoe, uW1, uW2, uW3;
uniform float uTopPat, uSleeve, uShorts, uWaist, uHide, uSeed;
varying vec3 vBind;
varying float vPart;
float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// wax print: medallions, rings and lozenges on a tile grid, the motif chosen by the seed
vec3 waxPrint(vec2 q, float sc) {
  q *= sc;
  vec2 c = floor(q), f = fract(q) - 0.5;
  float style = floor(fract(uSeed * 7.13) * 3.0), r = length(f), h = pHash(c + uSeed);
  vec3 col = uW1;
  if (style < 0.5) {
    col = mix(col, uW2, smoothstep(0.4, 0.37, r) - smoothstep(0.27, 0.24, r));
    col = mix(col, uW3, smoothstep(0.15, 0.12, r));
    vec2 g = fract(q + 0.5) - 0.5;
    col = mix(col, uW3, step(abs(g.x) + abs(g.y), 0.1) * step(0.35, h));
  } else if (style < 1.5) {
    float d = abs(f.x) + abs(f.y);
    col = mix(col, uW2, step(abs(d - 0.32), 0.07));
    col = mix(col, uW3, step(d, 0.12));
    col = mix(col, uW2, step(0.46, abs(f.y)) * step(0.5, h));
  } else {
    float band = fract(q.y * 0.5 + 0.15 * sin(q.x * 3.1416));
    col = mix(uW1, uW2, step(0.5, band));
    col = mix(col, uW3, smoothstep(0.2, 0.16, length(vec2(f.x, fract(q.y) - 0.5))) * step(0.5, band));
  }
  return col;
}
vec3 topColor(vec2 q) {
  if (uTopPat < 0.5) return uTop;
  if (uTopPat < 1.5) return mix(uTop, uW1, step(0.5, fract(q.y * 14.0)));
  if (uTopPat < 2.5) return waxPrint(q, 9.0);
  if (uTopPat < 3.5) {
    // Léopards jersey: a red sash edged with yellow across the blue
    float t = q.x * 0.8 + (q.y - 1.26);
    return mix(mix(uTop, vec3(0.93, 0.74, 0.02), step(abs(t), 0.07)), vec3(0.75, 0.02, 0.05), step(abs(t), 0.045));
  }
  if (uTopPat < 4.5) return mix(uTop, vec3(0.75), step(abs(q.y - 1.2), 0.018));
  vec2 g = step(0.5, fract(q * 11.0));
  return mix(uTop, uW1, 0.55 * max(g.x, g.y));
}
vec3 personColor() {
  int part = int(vPart + 0.5);
  vec2 q = vec2(vBind.x + vBind.z, vBind.y);
  if (part == 0) return vBind.y > 1.49 ? uSkin : vBind.y < uWaist ? uBottom : topColor(q);
  if (part == 1) return vBind.y < uShorts ? uSkin : uBottom;
  if (part == 2) return uShoe;
  if (part == 3) return vBind.y < uSleeve ? uSkin : (uTopPat > 1.5 && uTopPat < 2.5 ? waxPrint(q, 9.0) : uArm);
  if (part == 5) {
    // face: eyes, brows, lips; close-cropped hair above the hairline
    vec2 hd = normalize(vec2(vBind.x, vBind.z + 0.01));
    float hairline = 1.62 + 0.055 * hd.y - 0.005 * (hd.x * hd.x - hd.y * hd.y);
    float front = smoothstep(0.06, 0.08, vBind.z), ex = abs(abs(vBind.x) - 0.031);
    float eyes = smoothstep(0.011, 0.006, ex) * smoothstep(0.0055, 0.002, abs(vBind.y - 1.627)) * front;
    float white = smoothstep(0.014, 0.009, ex) * smoothstep(0.0065, 0.004, abs(vBind.y - 1.627)) * front;
    float mouth = smoothstep(0.022, 0.014, abs(vBind.x)) * smoothstep(0.0045, 0.0015, abs(vBind.y - 1.549)) * front;
    vec3 c = mix(uSkin, vec3(0.62, 0.58, 0.52), white * 0.35);
    c = mix(c, vec3(0.02), eyes * 0.9);
    c = mix(c, uSkin * vec3(0.7, 0.45, 0.42), mouth * 0.8);
    return mix(c, uHair, smoothstep(hairline - 0.004, hairline + 0.004, vBind.y));
  }
  if (part == 6) return uHair;
  if (part == 8 || part == 9) return waxPrint(q, part == 9 ? 12.0 : 8.0);
  return uSkin;
}`)
  .replace('#include <color_fragment>', `#include <color_fragment>
{
  int hp = int(vPart + 0.5);
  if (uHide > 0.5 && (hp == 0 || hp == 5 || hp == 6 || hp == 9)) discard;
  diffuseColor.rgb = personColor();
}`);

function personMaterial(u) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0 });
  m.userData.uniforms = u;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = personVertex(shader.vertexShader);
    shader.fragmentShader = personFragment(shader.fragmentShader);
  };
  m.customProgramCacheKey = () => 'cw-person';
  return m;
}

// ============================================================================
// 4. PERSON: FK POSES, TWO-BONE IK, PADDLE & POLE
// ============================================================================
const clamp = THREE.MathUtils.clamp;
const smooth = (x) => x * x * (3 - 2 * x);
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const DOWN = new THREE.Vector3(0, -1, 0);
const GRIP = 0.34;              // elbow to the middle of the palm
const ARM_BIND = SIDES.map((s) => new THREE.Vector3(s * Math.sin(ARM_BIND_ABDUCTION), -Math.cos(ARM_BIND_ABDUCTION), 0));
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _n = new THREE.Vector3(), _pp = new THREE.Vector3();
const _mid = new THREE.Vector3(), _end = new THREE.Vector3(), _root = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _qw = new THREE.Quaternion();
const _du = new THREE.Vector3(), _dl = new THREE.Vector3();
const qEuler = (q, x, y, z) => q.setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));

// two-bone IK: the middle joint bends towards `pole` (a direction)
function ik2(root, target, l1, l2, pole, mid, end) {
  _n.subVectors(target, root);
  let d = _n.length();
  _n.divideScalar(d || 1);
  d = clamp(d, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-4);
  const a = (l1 * l1 + d * d - l2 * l2) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _pp.copy(pole).addScaledVector(_n, -pole.dot(_n)).normalize();
  mid.copy(root).addScaledVector(_n, a).addScaledVector(_pp, h);
  end.copy(root).addScaledVector(_n, d);
}

function paddleMesh() {
  const g = new THREE.Group(), wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.8 });
  // origin at the top end, shaft down -Y; a long Congolese paddle with a leaf blade
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.02, 1.9, 7).translate(0, -0.95, 0), wood);
  const blade = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10).scale(0.12, 0.36, 0.014).translate(0, -2.06, 0), wood);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), wood);
  g.add(shaft, blade, knob);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}
function poleMesh() {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 5, 7).translate(0, -2.5, 0), new THREE.MeshStandardMaterial({ color: 0x7a6040, roughness: 0.85 }));
  m.castShadow = true;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

export class Person {
  constructor(seed, o) {
    const rnd = mulberry32(seed * 7919 + 17);
    this.seed = seed;
    this.o = o;
    this.female = o.female;
    this.phase = rnd() * 10;
    const J = (this.J = BIND[o.female ? 1 : 0]);
    this.group = new THREE.Group();
    // the rig is built facing +Z; turned so the person faces +X, their right on +Z
    this.rig = new THREE.Group();
    this.rig.rotation.y = Math.PI / 2;
    this.rig.scale.setScalar(o.height / 1.75);
    this.group.add(this.rig);

    const u = (this.uniforms = {
      uSkin: { value: new THREE.Color(o.skin) }, uTop: { value: new THREE.Color(o.top) }, uArm: { value: new THREE.Color(o.arm) },
      uBottom: { value: new THREE.Color(o.bottom) }, uHair: { value: new THREE.Color(o.hair) }, uShoe: { value: new THREE.Color(o.shoe) },
      uW1: { value: new THREE.Color(o.w[0]) }, uW2: { value: new THREE.Color(o.w[1]) }, uW3: { value: new THREE.Color(o.w[2]) },
      uTopPat: { value: o.topPat }, uSleeve: { value: o.sleeve }, uShorts: { value: o.shorts }, uWaist: { value: o.skirt ? 0 : 0.96 }, uHide: { value: 0 }, uSeed: { value: rnd() },
    });
    const mat = (this.material = personMaterial(u));
    const mesh = (this.mesh = new THREE.SkinnedMesh(personGeometry(o.skirt), mat));
    mesh.morphTargetInfluences = [o.female ? 1 : 0, o.hairVolume, o.girth];
    mesh.castShadow = true;
    mesh.frustumCulled = false;

    // bones at the bind joints, bound with the mesh at the origin
    const parent = [-1, BONE.PELVIS, BONE.CHEST, BONE.CHEST, BONE.UPPER_ARM_L, BONE.CHEST, BONE.UPPER_ARM_R,
      BONE.PELVIS, BONE.THIGH_L, BONE.SHIN_L, BONE.FOOT_L, BONE.PELVIS, BONE.THIGH_R, BONE.SHIN_R, BONE.FOOT_R];
    this.bones = J.map(() => new THREE.Bone());
    this.bones.forEach((b, i) => {
      if (parent[i] < 0) { b.position.copy(J[i]); mesh.add(b); } else { b.position.copy(J[i]).sub(J[parent[i]]); this.bones[parent[i]].add(b); }
    });
    mesh.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(this.bones));
    this.rig.add(mesh);

    this.extras = [];
    const onHead = (geo, material) => {
      const m = new THREE.Mesh(geo, material);
      m.position.copy(J[BONE.HEAD]).negate();     // geometry is in bind space
      m.castShadow = true;
      this.bones[BONE.HEAD].add(m);
      this.extras.push(m);
    };
    if (o.headwrap) onHead(wrapGeometry(), mat);
    if (o.hat) onHead(hatGeometry(), new THREE.MeshStandardMaterial({ color: o.hatColor, roughness: 0.9, side: THREE.DoubleSide }));

    // pose state (rig space, +Z forward, +X the person's left)
    this.P = new THREE.Vector3().copy(J[BONE.PELVIS]);
    this.qP = new THREE.Quaternion();
    this.qC = new THREE.Quaternion();
    this.qH = new THREE.Quaternion();
    this.knees = [new THREE.Vector3(), new THREE.Vector3()];
    this.walkPhase = 0;
    this.setPose('stand');
  }

  setPose(name, opts = {}) {
    this.pose = name;
    this.popts = { seat: 0.45, side: 1, ...opts };
    if (this.tool) { this.rig.remove(this.tool); this.tool = null; }
    if (name === 'paddle') this.tool = paddleMesh();
    if (name === 'pole') this.tool = poleMesh();
    if (this.tool) this.rig.add(this.tool);
    this.update(0, 0);
    return this;
  }

  setFirstPerson(on) {
    this.uniforms.uHide.value = on ? 1 : 0;
    for (const e of this.extras) e.visible = !on;
  }

  // eye position in group space
  eye() {
    const J = this.J;
    _v.copy(J[BONE.CHEST]).sub(J[BONE.PELVIS]).applyQuaternion(this.qP).add(this.P);
    _qw.copy(this.qP).multiply(this.qC);
    _v.add(_v2.copy(J[BONE.HEAD]).sub(J[BONE.CHEST]).applyQuaternion(_qw));
    _qw.multiply(this.qH);
    _v.add(_v2.set(0, 1.632, 0.06).sub(J[BONE.HEAD]).applyQuaternion(_qw));
    this.rig.updateMatrix();
    return _v.clone().applyMatrix4(this.rig.matrix);
  }

  // rig-space positions of the shoulders and hips for the current pelvis / chest
  shoulder(k, out) {
    const J = this.J;
    out.copy(J[BONE.CHEST]).sub(J[BONE.PELVIS]).applyQuaternion(this.qP).add(this.P);
    _qw.copy(this.qP).multiply(this.qC);
    return out.add(_v2.copy(J[LIMB.upperArm[k]]).sub(J[BONE.CHEST]).applyQuaternion(_qw));
  }
  hip(k, out) {
    return out.copy(this.J[LIMB.thigh[k]]).sub(this.J[BONE.PELVIS]).applyQuaternion(this.qP).add(this.P);
  }

  // a two-bone chain to world directions; returns the lower bone's world rotation
  chain(upper, lower, parentQ, bind, root, mid, end) {
    _du.subVectors(mid, root).normalize();
    _dl.subVectors(end, mid).normalize();
    _qa.setFromUnitVectors(bind, _du);
    _qb.setFromUnitVectors(_du, _dl).multiply(_qa);
    upper.quaternion.copy(parentQ).invert().multiply(_qa);
    lower.quaternion.copy(_qa).invert().multiply(_qb);
    return _qb;
  }

  armTo(k, target, pole) {
    this.shoulder(k, _root);
    ik2(_root, target, UPPER_ARM, GRIP, pole, _mid, _end);
    _qc.copy(this.qP).multiply(this.qC);
    this.chain(this.bones[LIMB.upperArm[k]], this.bones[LIMB.forearm[k]], _qc, ARM_BIND[k], _root, _mid, _end);
  }

  armRelaxed(k, swing = 0, out = 0.08, bend = 0.25) {
    const side = SIDES[k];
    qEuler(this.bones[LIMB.upperArm[k]].quaternion, swing, 0, side * out);
    this.bones[LIMB.forearm[k]].quaternion.setFromAxisAngle(AX, -bend);
  }

  legTo(k, ankle, pole) {
    this.hip(k, _root);
    ik2(_root, ankle, THIGH, SHIN, pole, _mid, _end);
    this.knees[k].copy(_mid);
    const qShin = this.chain(this.bones[LIMB.thigh[k]], this.bones[LIMB.shin[k]], this.qP, DOWN, _root, _mid, _end);
    this.bones[LIMB.foot[k]].quaternion.copy(qShin).invert();     // foot flat on the floor
    this.bones[LIMB.toe[k]].quaternion.identity();
  }

  legStraight(k, x = 0, bend = 0) {
    this.bones[LIMB.thigh[k]].quaternion.setFromAxisAngle(AX, x);
    this.bones[LIMB.shin[k]].quaternion.setFromAxisAngle(AX, bend);
    this.bones[LIMB.foot[k]].quaternion.setFromAxisAngle(AX, -(x + bend));
    this.bones[LIMB.toe[k]].quaternion.identity();
  }

  // stand with the feet planted (slightly apart), pelvis lowered by `drop`
  plant(drop, stagger = 0.06, wide = 0.12) {
    this.P.y -= drop;
    for (let k = 0; k < 2; k++) {
      _end.set(SIDES[k] * wide, ANKLE_H, SIDES[k] * stagger);
      this.legTo(k, _end.clone(), AZ);
    }
  }

  setTool(top, dir) {
    this.tool.position.copy(top);
    this.tool.quaternion.setFromUnitVectors(DOWN, dir);
  }

  update(t, dt, p = {}) {
    const J = this.J, o = this.popts, ph = this.phase;
    const breathe = Math.sin(t * 1.6 + ph) * 0.015;
    this.P.copy(J[BONE.PELVIS]);
    this.qP.identity();
    this.qC.identity();
    this.qH.identity();
    const sx = -o.side;            // the paddle's side in rig x (+z in the group is the person's right, rig -X)
    const kOut = sx > 0 ? 0 : 1, kIn = 1 - kOut;
    switch (this.pose) {
      case 'sit': {
        this.P.set(0, o.seat + 0.14, 0);
        qEuler(this.qC, 0.1 + breathe, Math.sin(t * 0.3 + ph) * 0.15, 0);
        qEuler(this.qH, Math.sin(t * 0.4 + ph) * 0.1, Math.sin(t * 0.23 + ph * 2) * 0.5, 0);
        for (let k = 0; k < 2; k++) {
          const s = SIDES[k], feetY = Math.max(ANKLE_H, o.seat + 0.1 - 0.83);
          this.legTo(k, new THREE.Vector3(s * 0.12, feetY, 0.4), new THREE.Vector3(s * 0.15, 0.4, 1));
        }
        for (let k = 0; k < 2; k++) this.armTo(k, _v.copy(this.knees[k]).add(new THREE.Vector3(-SIDES[k] * 0.03, 0.07, 0.02)), new THREE.Vector3(SIDES[k], -0.3, -1));
        break;
      }
      case 'squat': {
        this.P.set(0, 0.5, -0.12);
        qEuler(this.qP, 0.35, 0, 0);
        qEuler(this.qC, 0.2 + breathe, 0, 0);
        qEuler(this.qH, -0.35, Math.sin(t * 0.3 + ph) * 0.4, 0);
        for (let k = 0; k < 2; k++) this.legTo(k, new THREE.Vector3(SIDES[k] * 0.15, ANKLE_H, 0.12), new THREE.Vector3(SIDES[k] * 0.4, 0.2, 1));
        for (let k = 0; k < 2; k++) this.armTo(k, _v.copy(this.knees[k]).add(new THREE.Vector3(-SIDES[k] * 0.02, 0.06, 0.06)), new THREE.Vector3(SIDES[k], -0.5, -0.5));
        break;
      }
      case 'paddle': {
        // stroke: long pull (blade in the water, bow -> stern), then a quick recovery out of it
        const st = ((p.stroke ?? t * 0.5) % 1 + 1) % 1;
        const pull = st < 0.65, u = pull ? st / 0.65 : (st - 0.65) / 0.35;
        const z = pull ? 0.6 - 1.15 * smooth(u) : -0.55 + 1.15 * smooth(u);
        const B = new THREE.Vector3(sx * (pull ? 0.62 : 0.75), pull ? -0.4 : -0.4 + 0.5 * Math.sin(Math.PI * u), z);
        const reach = pull ? 1 - u : u;           // 1 at the catch
        qEuler(this.qP, 0.08 + 0.1 * reach, -sx * 0.12 * (reach - 0.4), 0);
        qEuler(this.qC, 0.12 + 0.2 * reach + breathe, -sx * 0.35 * (reach - 0.35), 0);
        qEuler(this.qH, -0.2 - 0.15 * reach, sx * 0.25 * (reach - 0.35), 0);
        this.plant(0.05 + 0.03 * reach, 0.1, 0.13);
        const T0 = new THREE.Vector3(sx * 0.18, 1.85, 0.2 + z * 0.2);   // top hand high, the shaft near upright
        const dir = B.clone().sub(T0).normalize(), top = B.clone().addScaledVector(dir, -2.06);
        this.setTool(top, dir);
        this.armTo(kIn, top.clone().addScaledVector(dir, 0.05), new THREE.Vector3(-sx, -0.4, -0.6));
        this.armTo(kOut, top.clone().addScaledVector(dir, 0.78), new THREE.Vector3(sx, -0.2, -0.8));
        break;
      }
      case 'pole': {
        const st = ((p.stroke ?? t * 0.25) % 1 + 1) % 1;
        const push = st < 0.7, u = push ? st / 0.7 : (st - 0.7) / 0.3;
        const B = new THREE.Vector3(sx * 0.75, push ? -1.6 : -1.6 + 1.2 * Math.sin(Math.PI * u), push ? 0.5 - 1.6 * smooth(u) : -1.1 + 1.6 * smooth(u));
        const lean = push ? 0.15 + 0.35 * u : 0.5 - 0.35 * u;
        qEuler(this.qP, lean * 0.4, 0, 0);
        qEuler(this.qC, lean + breathe, -sx * 0.25, 0);
        qEuler(this.qH, -lean * 0.8, sx * 0.2, 0);
        this.plant(0.04 + 0.06 * lean, 0.16, 0.14);
        const H0 = new THREE.Vector3(sx * 0.25, 1.25, 0.3 - lean * 0.2);
        const up = H0.clone().sub(B).normalize(), top = B.clone().addScaledVector(up, 5);
        this.setTool(top, up.clone().negate());
        this.armTo(kOut, B.clone().addScaledVector(up, 2.55), new THREE.Vector3(sx, -0.3, -0.7));
        this.armTo(kIn, B.clone().addScaledVector(up, 3.05), new THREE.Vector3(-sx, -0.3, -0.7));
        break;
      }
      case 'helm': {
        // standing, a hand back on the tiller; p.steer swings it
        const steer = clamp(p.steer ?? 0, -1, 1);
        qEuler(this.qC, 0.03 + breathe, -0.25, 0);
        qEuler(this.qH, 0, 0.25 + Math.sin(t * 0.3 + ph) * 0.2, 0);
        this.plant(0.02, 0.12, 0.13);
        this.armTo(1, new THREE.Vector3(-0.2 + steer * 0.18, 0.95, -0.36), new THREE.Vector3(-1, -0.2, 0.3));
        this.armRelaxed(0, 0.05, 0.1, 0.35);
        break;
      }
      case 'walk': {
        const speed = p.speed ?? 1.2;
        this.walkPhase += dt * speed * 4.4;
        const w = this.walkPhase, s = Math.sin(w), c = Math.cos(w);
        this.P.y -= 0.025 * Math.abs(c) + 0.01;
        qEuler(this.qP, 0.03, s * 0.12, -s * 0.03);
        qEuler(this.qC, 0.04 + breathe, -s * 0.18, s * 0.02);
        for (let k = 0; k < 2; k++) {
          const ks = k ? -1 : 1;
          this.legStraight(k, -0.42 * s * ks, 0.15 + 0.6 * Math.max(0, -c * ks));
          this.armRelaxed(k, 0.35 * s * ks, 0.08, 0.3);
        }
        break;
      }
      case 'wave': {
        qEuler(this.qC, breathe, 0.1, 0);
        qEuler(this.qH, -0.05, 0.1, 0);
        for (let k = 0; k < 2; k++) this.legStraight(k);
        this.armTo(1, new THREE.Vector3(-0.34 + 0.11 * Math.sin(t * 7 + ph), 1.95, 0.12), new THREE.Vector3(-1, -0.5, -0.2));
        this.armRelaxed(0, 0, 0.08, 0.2);
        break;
      }
      default: {
        // standing: breathing and a slow weight shift
        const shift = Math.sin(t * 0.35 + ph);
        this.P.x = shift * 0.025;
        qEuler(this.qP, 0, Math.sin(t * 0.2 + ph) * 0.05, -shift * 0.04);
        qEuler(this.qC, breathe, 0, shift * 0.04);
        qEuler(this.qH, Math.sin(t * 0.5 + ph) * 0.05, Math.sin(t * 0.27 + ph) * 0.35, 0);
        for (let k = 0; k < 2; k++) this.legTo(k, new THREE.Vector3(SIDES[k] * 0.11, ANKLE_H, 0.01), AZ);
        for (let k = 0; k < 2; k++) this.armRelaxed(k, Math.sin(t * 0.5 + ph + k) * 0.04, 0.07, 0.2);
      }
    }
    const b = this.bones;
    b[BONE.PELVIS].position.copy(this.P);
    b[BONE.PELVIS].quaternion.copy(this.qP);
    b[BONE.CHEST].quaternion.copy(this.qC);
    b[BONE.HEAD].quaternion.copy(this.qH);
  }
}

// ============================================================================
// 5. APPEARANCE FROM A SEED
// ============================================================================
export function createPerson(seed, opts = {}) {
  const rnd = mulberry32(seed * 104729 + 3);
  const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];
  const female = opts.female ?? rnd() < 0.5;
  const outfit = opts.outfit ?? (female ? (rnd() < 0.75 ? 'wax' : 'shirt') : pick(['shirt', 'shirt', 'shirt', 'football', 'fisher']));
  const tourist = outfit === 'tourist';
  const o = {
    female, outfit,
    girth: opts.girth ?? Math.pow(rnd(), 1.6) * (female ? 0.9 : 0.6),
    height: (female ? 1.62 : 1.7) + rnd() * 0.15,
    skin: pick(tourist ? SKIN_TOURIST : SKIN),
    hair: tourist && rnd() < 0.4 ? pick([0x3a2a1a, 0x584022, 0x8f6d43, 0x6e6862]) : pick([0x0d0a08, 0x15100c, 0x1c1410]),
    hairVolume: female ? 0.3 + rnd() * 0.7 : rnd() * 0.25,
    w: [pick(WAX), pick(WAX), pick(WAX)],
    topPat: PAT.plain, sleeve: 1.22, shorts: -1, skirt: false,
    headwrap: opts.headwrap ?? (female && outfit === 'wax' && rnd() < 0.6),
    hat: opts.hat ?? (tourist ? rnd() < 0.8 : outfit === 'fisher' && rnd() < 0.4),
    hatColor: tourist ? pick([0xe8dcb5, 0xf2efe6, 0x8a9a6a]) : 0xc9a86a,
    shoe: rnd() < 0.3 && !tourist ? null : pick(SHOES),
  };
  while (o.w[1] === o.w[0]) o.w[1] = pick(WAX);
  while (o.w[2] === o.w[1]) o.w[2] = pick(WAX);
  o.top = pick(SHIRT);
  o.arm = o.top;
  o.bottom = pick(TROUSERS);
  if (outfit === 'wax') {
    o.skirt = true;
    o.shorts = 2;               // legs bare under the pagne
    o.topPat = rnd() < 0.7 ? PAT.wax : PAT.plain;
    o.sleeve = rnd() < 0.5 ? 1.22 : 1.06;
  } else if (outfit === 'shirt') {
    o.topPat = pick([PAT.plain, PAT.plain, PAT.stripes, PAT.checks]);
    o.w[0] = pick(SHIRT);
    o.sleeve = rnd() < 0.4 ? 0.9 : 1.22;
  } else if (outfit === 'football') {
    o.top = 0x1b6fd1; o.arm = 0x1b6fd1; o.topPat = PAT.jersey;
    if (rnd() < 0.3) o.shorts = 0.55;
  } else if (outfit === 'fisher') {
    o.top = pick([0x8a7a62, 0x5a5048, 0x3f6b3a, 0xb8a27a, 0x2c3e50]); o.arm = o.top;
    o.sleeve = 1.3; o.shorts = 0.5; o.shoe = null;
    o.bottom = pick([0x51473d, 0x35485b, 0x2b2b2b]);
  } else if (tourist) {
    o.top = pick(TOURIST); o.arm = o.top; o.shorts = 0.55;
    o.bottom = pick([0xc9b48a, 0x6e6452, 0x35485b, 0xe8e0cc]); o.shoe = pick([0xe9e4d8, 0x5a5048]);
  }
  if (opts.vest) { o.topPat = PAT.vest; o.top = 0xf26a10; }
  o.shoe ??= o.skin;            // barefoot
  return new Person(seed, o);
}
