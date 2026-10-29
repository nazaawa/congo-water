import * as THREE from 'three';
import { noiseGLSL } from './noise.js';

// Analytic tropical sky: a hazy gradient (the Congo basin is humid, the sky is rarely
// deep blue), Mie halo and disc around the sun, and drifting cumulus. The same GLSL
// `skyColor()` lights the water reflections fallback and its fog, so the horizon,
// the fog and the reflected sky always agree.

export const skyGLSL = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uCloud;
uniform float uTime;
${noiseGLSL}
vec3 skyColor(vec3 d, bool clouds) {
  float y = d.y;
  vec3 col = mix(uZenith, uHorizon, pow(1.0 - max(y, 0.0), 5.0));
  if (y < 0.0) col = mix(uHorizon, uHorizon * 0.55, clamp(-y * 4.0, 0.0, 1.0));
  float mu = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (0.05 * pow(mu, 6.0) + 0.35 * pow(mu, 80.0));
  col += uSunColor * smoothstep(0.99955, 0.99975, mu) * 30.0 * smoothstep(-0.02, 0.01, y);
  if (clouds && y > 0.0) {
    vec2 cp = d.xz / (y + 0.06) * 0.9 + vec2(uTime * 0.0035, uTime * 0.0012);
    float c = fbm(cp);
    c = smoothstep(0.62 - uCloud * 0.3, 0.95, c) * smoothstep(0.0, 0.1, y);
    float lit = 0.55 + 0.45 * pow(mu, 3.0);
    vec3 cloudCol = uHorizon * 0.75 + uSunColor * 0.55 * lit;
    // darker cloud bases
    cloudCol *= 0.8 + 0.2 * fbm(cp * 2.3 + 4.0);
    col = mix(col, cloudCol, c * 0.92);
  }
  return col;
}
`;

const SKY_FRAG = /* glsl */`
${skyGLSL}
varying vec3 vDir;
void main() {
  gl_FragColor = vec4(skyColor(normalize(vDir), true), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w;   // always at the far plane
}`;

const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Sky {
  constructor() {
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uZenith: { value: new THREE.Vector3() },
      uHorizon: { value: new THREE.Vector3() },
      uCloud: { value: 0.5 },
      uTime: { value: 0 },
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
        side: THREE.BackSide, depthWrite: false, fog: false,
      }),
    );
    this.mesh.scale.setScalar(20000);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.sunColor = new THREE.Color();
    this.horizon = new THREE.Color();
  }

  // elevation & azimuth in degrees (azimuth 0 = downstream +x, 90 = +z)
  set(elev, azim, cloud) {
    const e = THREE.MathUtils.degToRad(elev), a = THREE.MathUtils.degToRad(azim);
    const dir = this.uniforms.uSunDir.value.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
    this.uniforms.uCloud.value = cloud;

    // colours from elevation: night → golden hour → hazy equatorial day
    const day = smooth(-4, 25, elev), gold = smooth(-5, 3, elev) * (1 - smooth(4, 22, elev));
    const sun = lerp3(lerp3([0.02, 0.02, 0.04], [1.7, 1.55, 1.38], day), [1.6, 0.72, 0.3], gold * 0.8);
    const zen = lerp3(lerp3([0.004, 0.006, 0.014], [0.19, 0.33, 0.6], day), [0.14, 0.17, 0.32], gold * 0.6);
    const hor = lerp3(lerp3([0.012, 0.014, 0.024], [0.68, 0.72, 0.75], day), [0.95, 0.55, 0.32], gold * 0.85);
    this.uniforms.uSunColor.value.fromArray(sun);
    this.uniforms.uZenith.value.fromArray(zen);
    this.uniforms.uHorizon.value.fromArray(hor);
    this.sunColor.setRGB(...sun);
    this.horizon.setRGB(...hor);
    this.elevation = elev;
    return dir;
  }
}
