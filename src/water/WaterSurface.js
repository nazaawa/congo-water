import * as THREE from 'three';
import { wavesGLSL, waveUniforms } from './waves.js';
import { skyGLSL } from './sky.js';

// River surface, after Ultra-Water's OceanSurface, cut down for a river:
// * camera-centred polar grid, rings growing geometrically, scaled with camera height;
// * Gerstner waves carried by the current + rapids standing waves (waves.js), faded
//   with distance so they never alias;
// * two ripple layers advected along the flow with the two-phase flow-map crossfade;
// * sediment plumes: slow, flow-advected brightness swirls in the brown body colour;
// * Fresnel mix of the planar reflection (banks, boats, sky) over the in-scatter colour,
//   GGX sun with twinkling glints;
// * foam on standing-wave crests, around rocks, at the foot of a waterfall, along the
//   banks, textured with a lace that drifts downstream.

const MAX_ROCKS = 24;

const VERT = /* glsl */`
${wavesGLSL}
uniform float uTime;
varying vec3 vWorld;
varying vec2 vGrid;
varying vec4 vReflCoord;
uniform mat4 uReflMatrix;
uniform float uBase;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vGrid = wp.xz;
  float dist = length(wp.xz - cameraPosition.xz);
  vec2 shift = vec2(0.0);
  vec3 h = riverWaves(wp.xz, uTime, dist, shift);
  wp.xz -= shift;
  wp.y = uBase + h.x;
  vWorld = wp.xyz;
  vReflCoord = uReflMatrix * vec4(wp.x, uBase, wp.z, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */`
${wavesGLSL}
${skyGLSL}
uniform sampler2D uRipples;
uniform sampler2D uFoamTex;
uniform sampler2D uRefl;
uniform float uUseRefl;
uniform float uFlow;
uniform float uChop;
uniform float uFoam;
uniform float uBase;
uniform vec3 uScatter;
uniform vec3 uShallow;
uniform vec3 uFoamColor;
uniform vec4 uRocks[${MAX_ROCKS}];  // x, z, radius, -
uniform vec4 uFall;             // s along the bed, half width, active, -
uniform vec2 uMeanFlow;         // overall downstream direction (for the slow, unbounded drifts)
uniform float uFogDensity;
uniform vec4 uWake;             // boat x, z, heading, speed through the water
uniform vec2 uWakeSize;         // half length, half beam
uniform vec2 uClip;             // discard where sign * (s - s0) > 0 (upper pool of a waterfall)
varying vec3 vWorld;
varying vec2 vGrid;
varying vec4 vReflCoord;

vec2 rippleSlope(vec2 p, float scale, float speed, float t) {
  // two phases half a period apart, crossfaded so the stretch never shows
  float T = 3.0;
  float f0 = fract(t / T), f1 = fract(t / T + 0.5);
  float w = abs(1.0 - 2.0 * f0);
  vec2 drift = gFlowDir * uFlow * speed;   // bounded offsets: the local direction is fine
  vec2 a = texture2D(uRipples, (p - drift * f0 * T) / scale).xy * 2.0 - 1.0;
  vec2 b = texture2D(uRipples, (p - drift * f1 * T) / scale + 0.37).xy * 2.0 - 1.0;
  return mix(a, b, 1.0 - w);
}

float foamTex(vec2 p, float t) {
  float T = 4.0;
  float f0 = fract(t / T), f1 = fract(t / T + 0.5);
  float w = abs(1.0 - 2.0 * f0);
  vec2 drift = gFlowDir * uFlow;
  // warped and mixed over two scales so the cells don't read as a grid
  vec2 q = p + 4.0 * vec2(vnoise(p * 0.07), vnoise(p * 0.07 + 7.3));
  float a = texture2D(uFoamTex, (q - drift * f0 * T) / 9.0).r * 0.65 + texture2D(uFoamTex, (q - drift * f0 * T) / 3.3 + 0.2).r * 0.35;
  float b = texture2D(uFoamTex, (q - drift * f1 * T) / 9.0 + 0.5).r * 0.65 + texture2D(uFoamTex, (q - drift * f1 * T) / 3.3 + 0.7).r * 0.35;
  return mix(a, b, 1.0 - w);
}

float ggx(float NdotH, float r) {
  float a2 = r * r * r * r;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159 * d * d);
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float t = uTime;
  vec2 p = vGrid;
  if (uClip.x != 0.0 && uClip.x * (channelAt(p).y - uClip.y) > 0.0) discard;

  vec2 sh = vec2(0.0);
  vec3 h = riverWaves(p, t, dist, sh);

  // ripples: fade the finest layer with distance (they'd only add noise there)
  float near = 1.0 - smoothstep(20.0, 160.0, dist);
  float mid = 1.0 - smoothstep(80.0, 900.0, dist);
  vec2 rs = rippleSlope(p, 6.5, 1.0, t) * 0.11 * mid
          + rippleSlope(p * 1.0 + 3.1, 1.9, 1.15, t) * 0.07 * near;
  vec2 grad = h.yz + rs * uChop;
  vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));

  // distance to the bank (from the channel grid) and rock / waterfall proximity
  float bankD = gBankD;
  float shore = 1.0 - smoothstep(0.0, min(40.0, uHalfWidth * 0.4), bankD);
  vec2 across = vec2(-gFlowDir.y, gFlowDir.x);

  float foam = 0.0;
  for (int i = 0; i < ${MAX_ROCKS}; i++) {
    vec4 r = uRocks[i];
    if (r.z <= 0.0) continue;
    vec2 d = p - r.xy;
    // stretched downstream: the wake trails with the current
    float da = dot(d, gFlowDir);
    vec2 e = vec2(da / (1.0 + 2.5 * step(0.0, da)), dot(d, across));
    float rr = length(e) / r.z;
    foam += exp(-max(rr - 0.9, 0.0) * 2.2) * 0.9;
  }
  if (uFall.z > 0.0) {
    float dx = gAlong - uFall.x;
    foam += smoothstep(-2.0, 4.0, dx) * exp(-max(dx, 0.0) / 22.0) * 1.3 * (1.0 - smoothstep(uFall.y * 0.9, uFall.y * 1.2, uHalfWidth - gBankD));
  }
  // whitecaps on crests (standing waves in the rapids, steep chop elsewhere)
  float crest = h.x * 1.2 + length(h.yz) * 1.6;
  foam += smoothstep(0.7, 1.6, crest) * 0.5;
  foam += smoothstep(0.15, 0.75, gStanding) * 1.3;          // white horses on the standing waves
  foam += uFoam * smoothstep(0.35, 0.8, vnoise(p * 0.018 - uMeanFlow * t * uFlow * 0.018));
  foam += shore * 0.25;
  // wake: the Kelvin wedge (±19.5°) trailing from the stern, churned water along the
  // centreline and a bow wave, all growing with the speed through the water
  if (uWake.w > 0.3) {
    vec2 fwd = vec2(cos(uWake.z), sin(uWake.z));
    vec2 d = p - uWake.xy;
    float behind = -dot(d, fwd) - uWakeSize.x * 0.8;
    float lat = abs(d.x * -fwd.y + d.y * fwd.x);
    float k = smoothstep(0.3, 2.5, uWake.w);
    if (behind > -uWakeSize.x * 1.8) {
      float b = max(behind, 0.0);
      float arm = exp(-pow((lat - uWakeSize.y - b * 0.354) / (0.5 + b * 0.05), 2.0));
      float churn = exp(-pow(lat / (uWakeSize.y + b * 0.04), 2.0)) * step(0.0, behind);
      float bow = exp(-pow((lat - uWakeSize.y * 1.1) / 0.45, 2.0)) * (1.0 - smoothstep(-uWakeSize.x * 1.8, 0.0, behind)) * smoothstep(-uWakeSize.x * 2.0, -uWakeSize.x * 1.6, behind);
      float fade = exp(-b / (18.0 + uWake.w * 10.0));
      foam += (arm * 0.9 + churn * 1.2 + bow * 0.8) * fade * k;
    }
  }
  float lace = foamTex(p, t);
  float blot = texture2D(uFoamTex, (p - uMeanFlow * t * uFlow) / 23.0).g;
  // coverage erodes the way Ultra-Water's does: solid where there is a lot of foam,
  // holes, then only the lace on the cell borders, then nothing
  float foamA = clamp(foam * 1.5 - (1.0 - lace) * 0.85 - (1.0 - blot) * 0.35 - 0.22, 0.0, 1.0);
  foamA *= 1.0 - smoothstep(600.0, 2500.0, dist) * 0.7;
  if (uFall.z > 0.0) foamA = max(foamA, smoothstep(6.0, -1.0, gAlong - uFall.x) * 0.95 * (1.0 - smoothstep(uFall.y, uFall.y * 1.2, uHalfWidth - gBankD)));

  // sun
  vec3 L = uSunDir;
  vec3 H = normalize(L + V);
  float NdotL = max(dot(N, L), 0.0), NdotV = max(dot(N, V), 1e-3);
  float rough = mix(0.075, 0.16, smoothstep(50.0, 1500.0, dist));   // unresolved slopes add roughness far away
  float spec = ggx(max(dot(N, H), 0.0), rough) * NdotL * 0.25;
  // glints: cells that happen to face the sun flicker on and off
  vec2 cell = floor(p * 2.5);
  float tw = step(0.985, hash12(cell + floor(t * 6.0 + hash12(cell) * 6.0)));
  spec += tw * pow(max(dot(N, H), 0.0), 900.0) * 30.0 * near * step(0.0, L.y);

  float F = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

  // reflection: planar (banks, boats, sky) distorted by the slopes, else the analytic sky
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl;
  if (uUseRefl > 0.5) {
    vec2 uv = vReflCoord.xy / vReflCoord.w + N.xz * vec2(0.35, 0.35) * (1.0 / (1.0 + dist * 0.01));
    refl = texture2D(uRefl, uv).rgb;
  } else {
    refl = skyColor(R, false);
  }

  // body: light scattered back by the sediment, lit by the sun and the sky dome
  float plume = fbm((p - uMeanFlow * t * uFlow * 0.6) * 0.012);
  vec3 body = mix(uScatter, uShallow, shore * 0.7) * (0.82 + 0.4 * plume);
  vec3 ambient = (uZenith * 0.6 + uHorizon * 0.4) * 1.1;
  body *= uSunColor * max(L.y, 0.0) * 0.9 + ambient;

  // subsurface glow: looking towards a low sun, light crossing the thin wave crests
  // comes out tinted by the sediment (the ochre glow of the Congo at sunset)
  float back = pow(max(dot(-V, L) * 0.5 + 0.5, 0.0), 5.0);
  float thin = clamp(h.x * 3.0 + gStanding * 1.5 + length(grad) * 0.8, 0.0, 1.0);
  vec3 sss = uShallow * uSunColor * back * thin * 1.6 * (1.0 - smoothstep(150.0, 900.0, dist));
  body += sss;

  vec3 col = mix(body, refl, F) + uSunColor * spec * (1.0 - foamA);
  vec3 foamCol = uFoamColor * (uSunColor * (0.35 + 0.65 * NdotL) * 0.7 + ambient * 0.8);
  col = mix(col, foamCol, foamA);

  // aerial perspective: fade to the sky right behind (matches the horizon)
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  vec3 fogDir = normalize(vec3(-V.x, max(-V.y, 0.015), -V.z));
  col = mix(col, skyColor(fogDir, false), fog);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function polarGrid(rings = 230, segments = 320, r0 = 0.35, growth = 1.038) {
  const pos = [0, 0, 0];
  const idx = [];
  let r = r0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
    r *= growth;
  }
  for (let j = 0; j < segments; j++) idx.push(0, 1 + ((j + 1) % segments), 1 + j);
  for (let i = 0; i < rings - 1; i++) {
    const a = 1 + i * segments, b = a + segments;
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      idx.push(a + j, a + j1, b + j, a + j1, b + j1, b + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export class WaterSurface {
  constructor(sky, textures) {
    this.uniforms = {
      ...sky.uniforms,
      uTime: { value: 0 },
      uWaveA: { value: [] }, uWaveB: { value: [] }, uStanding: { value: 0 },
      uRipples: { value: textures.ripples },
      uFoamTex: { value: textures.foam },
      uRefl: { value: null }, uUseRefl: { value: 0 }, uReflMatrix: { value: new THREE.Matrix4() },
      uFlow: { value: 1 }, uChop: { value: 1 }, uFoam: { value: 0 }, uBase: { value: 0 },
      uScatter: { value: new THREE.Color() }, uShallow: { value: new THREE.Color() }, uFoamColor: { value: new THREE.Color() },
      uChan: { value: null }, uChanBox: { value: new THREE.Vector4(0, 0, 1, 1) }, uHalfWidth: { value: 100 },
      uMeanFlow: { value: new THREE.Vector2(1, 0) },
      uRocks: { value: Array.from({ length: MAX_ROCKS }, () => new THREE.Vector4()) },
      uFall: { value: new THREE.Vector4() },
      uFogDensity: { value: 0.0003 },
      uClip: { value: new THREE.Vector2() },
      uWake: { value: new THREE.Vector4() },
      uWakeSize: { value: new THREE.Vector2(5, 0.4) },
    };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG });
    this.mesh = new THREE.Mesh(polarGrid(), this.material);
    this.mesh.frustumCulled = false;
  }

  // the channel grid as a float texture (filtered when the GPU can)
  setChannel(channel, texture) {
    const u = this.uniforms;
    u.uChan.value = texture;
    // grid nodes sit at texel centres
    const c = channel.cell;
    u.uChanBox.value.set(channel.x0 - c / 2, channel.z0 - c / 2, 1 / (channel.nx * c), 1 / (channel.nz * c));
    u.uHalfWidth.value = channel.halfWidth;
    u.uMeanFlow.value.set(Math.cos(channel.meanAngle), Math.sin(channel.meanAngle));
  }

  setRocks(rocks) {
    this.uniforms.uRocks.value.forEach((v, i) => {
      const r = rocks[i];
      v.set(r ? r.x : 0, r ? r.z : 0, r ? r.r : 0, 0);
    });
  }

  configure(preset, waves, rocks, fall) {
    const u = this.uniforms, wu = waveUniforms(waves);
    u.uWaveA.value = wu.uWaveA.map((a) => new THREE.Vector4(...a));
    u.uWaveB.value = wu.uWaveB.map((b) => new THREE.Vector4(...b));
    u.uStanding.value = wu.uStanding;
    u.uFlow.value = preset.flow;
    u.uChop.value = preset.chop;
    u.uFoam.value = preset.foam;
    u.uScatter.value.setRGB(...preset.water.scatter);
    u.uShallow.value.setRGB(...preset.water.shallow);
    u.uFoamColor.value.setRGB(...preset.water.foam);
    u.uFogDensity.value = preset.haze;
    this.setRocks(rocks);
    u.uFall.value.set(fall ? fall.s : 0, fall ? preset.halfWidth : 0, fall ? 1 : 0, 0);
  }

  // follow the camera; grid snapped to whole metres, scaled with height so the
  // fine inner rings aren't wasted on an aerial view
  follow(camera) {
    const s = THREE.MathUtils.clamp(Math.abs(camera.position.y - this.uniforms.uBase.value) / 4, 1, 40);
    this.mesh.scale.setScalar(s);
    this.mesh.position.set(Math.round(camera.position.x), 0, Math.round(camera.position.z));
  }
}
