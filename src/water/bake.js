import * as THREE from 'three';
import { mulberry32 } from './noise.js';

// Tileable textures baked once on the CPU at startup.
// * ripples: slope (dh/dx, dh/dz) of a sum of integer-wavenumber sines, so it tiles
//   exactly; the water shader scrolls two copies with the current (flow map style).
// * foam: cellular lace (F2 − F1 of a tileable Worley field) in R, soft blotches in G.

const N = 256;

function makeTexture(data) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function bakeRipples() {
  const rnd = mulberry32(7);
  const waves = [];
  for (let i = 0; i < 64; i++) {
    let kx, ky;
    do { kx = Math.round((rnd() * 2 - 1) * 14); ky = Math.round((rnd() * 2 - 1) * 14); } while (kx === 0 && ky === 0);
    const k = Math.hypot(kx, ky);
    waves.push({ kx, ky, a: 1 / Math.pow(k, 1.6), p: rnd() * Math.PI * 2 });
  }
  const gx = new Float32Array(N * N), gy = new Float32Array(N * N);
  let maxG = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let sx = 0, sy = 0;
    const u = (x / N) * Math.PI * 2, v = (y / N) * Math.PI * 2;
    for (const w of waves) {
      const c = Math.cos(w.kx * u + w.ky * v + w.p) * w.a;
      sx += c * w.kx; sy += c * w.ky;
    }
    gx[y * N + x] = sx; gy[y * N + x] = sy;
    maxG = Math.max(maxG, Math.abs(sx), Math.abs(sy));
  }
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round((gx[i] / maxG) * 127.5 + 127.5);
    data[i * 4 + 1] = Math.round((gy[i] / maxG) * 127.5 + 127.5);
    data[i * 4 + 2] = 128;
    data[i * 4 + 3] = 255;
  }
  return makeTexture(data);
}

function bakeFoam() {
  const rnd = mulberry32(11);
  const C = 14, pts = [];
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) pts.push([(i + rnd()) / C, (j + rnd()) / C]);
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, ci = Math.floor(u * C), cj = Math.floor(v * C);
    let f1 = 9, f2 = 9;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const ii = (ci + di + C) % C, jj = (cj + dj + C) % C;
      const p = pts[jj * C + ii];
      const px = p[0] + Math.floor((ci + di) / C), py = p[1] + Math.floor((cj + dj) / C);
      const d = Math.hypot(px - u, py - v);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    const edge = Math.min(1, (f2 - f1) * C * 1.6);       // 0 on cell borders
    const lace = Math.pow(1 - edge, 2.2);
    const blot = Math.min(1, f1 * C * 0.9);
    const o = (y * N + x) * 4;
    data[o] = Math.round(lace * 255);
    data[o + 1] = Math.round((1 - blot) * 255);
    data[o + 2] = 0;
    data[o + 3] = 255;
  }
  return makeTexture(data);
}

export function bakeWaterTextures() {
  return { ripples: bakeRipples(), foam: bakeFoam() };
}
