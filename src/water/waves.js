// River waves, evaluated identically on the GPU (water mesh) and the CPU (floaters).
//
// * Wind waves: Gerstner trains whose phase is carried downstream by the current,
//   θ = k·(d·x) − (ω + k (d·U)) t, with deep-water dispersion ω² = g k.
// * Rapids: standing waves. Over a rock bar the current holds a wave train still
//   (ω = k U), so the crests stay put while the water runs through them, the way
//   the Kinshasa rapids look from the bank. They come in patches and breathe.
// The river's course comes from a Channel (channel.js): the wind waves are turned with its
// mean downstream direction, the standing waves live in its own frame (s along the bed,
// d across it), so they follow the bends.

export const MAX_WAVES = 6;
const G = 9.81;

export function buildWaves(preset, channel) {
  const rot = channel?.meanAngle ?? 0;
  const list = preset.waves.slice(0, MAX_WAVES).map((w, i) => {
    const a = (w.dir * Math.PI) / 180, k = (2 * Math.PI) / w.len;
    return {
      dx: Math.cos(a + rot), dz: Math.sin(a + rot), k, amp: w.amp,
      omega: Math.sqrt(G * k) + k * Math.cos(a) * preset.flow,
      phase: i * 1.731,
      steep: Math.min(0.12, k * w.amp),   // Q·k·A, summed it stays < 1 so crests never loop
    };
  });
  while (list.length < MAX_WAVES) list.push({ dx: 1, dz: 0, k: 1, amp: 0, omega: 0, phase: 0, steep: 0 });
  return { list, standing: preset.standing ?? 0, channel };
}

// CPU height at (x, z), ignoring the small Gerstner horizontal shift
export function waveHeight(waves, x, z, t) {
  let h = 0;
  for (const w of waves.list) h += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.omega * t + w.phase);
  if (waves.standing > 0 && waves.channel) {
    const c = waves.channel.sample(x, z, _c);
    h += standing(waves.standing, c.s, c.d, t) * bankCalm(waves.channel.halfWidth - Math.abs(c.d));
  }
  return h;
}
const _c = {};

// standing waves need the full current: they die out in the slack water along the banks
function bankCalm(d) {
  const t = Math.min(1, Math.max(0, (d - 25) / 90));
  return t * t * (3 - 2 * t);
}

// in the channel's frame: x = s along the bed, z = d across it
function standing(A, x, z, t) {
  const patch = Math.max(0, Math.sin(x * 0.011 + 1.3) * Math.sin(z * 0.017 + 0.4) * 1.4 - 0.15);
  const breathe = 0.75 + 0.25 * Math.sin(t * 0.6 + x * 0.02);
  const warp = 2.0 * Math.sin(z * 0.037 + x * 0.013) + 1.3 * Math.sin(z * 0.071 - x * 0.029 + 1.7);
  const cz = Math.cos(z * 0.21 + 1.5 * Math.sin(x * 0.05 + z * 0.02));
  return A * patch * breathe * Math.sin(x * 0.42 + warp + 0.6 * Math.sin(t * 0.9 + z * 0.05)) * cz;
}

export const wavesGLSL = /* glsl */`
#define MAX_WAVES ${MAX_WAVES}
uniform vec4 uWaveA[MAX_WAVES];   // dir.x, dir.z, k, amp
uniform vec4 uWaveB[MAX_WAVES];   // omega, phase, steepness, -
uniform float uStanding;
uniform sampler2D uChan;        // channel grid: d (signed, from the centreline), s (along), downstream dir
uniform vec4 uChanBox;          // x0, z0, 1 / width, 1 / depth of the grid
uniform float uHalfWidth;

vec4 channelAt(vec2 p) { return texture2D(uChan, (p - uChanBox.xy) * uChanBox.zw); }
vec2 gFlowDir;     // downstream direction at the last riverWaves() point
float gBankD;      // distance to the nearer bank there (< 0 on land)
float gAlong;      // distance along the bed

float gStanding;   // the standing-wave part of the last riverWaves() call (rapids foam)

// returns height in .x and its gradient (dh/dx, dh/dz) in .yz; fade band-limits by distance
vec3 riverWaves(vec2 p, float t, float dist, inout vec2 shift) {
  vec3 h = vec3(0.0);
  gStanding = 0.0;
  vec4 ch = channelAt(p);
  gFlowDir = normalize(ch.zw + vec2(1e-5, 0.0));
  gBankD = uHalfWidth - abs(ch.x);
  gAlong = ch.y;
  for (int i = 0; i < MAX_WAVES; i++) {
    vec4 a = uWaveA[i], b = uWaveB[i];
    float lambda = 6.2831853 / a.z;
    float fade = 1.0 - smoothstep(lambda * 25.0, lambda * 70.0, dist);
    float th = a.z * dot(a.xy, p) - b.x * t + b.y;
    float s = sin(th), c = cos(th);
    float amp = a.w * fade;
    h.x += amp * s;
    h.yz += amp * a.z * c * a.xy;
    shift += b.z / a.z * fade * a.xy * c;
  }
  if (uStanding > 0.0) {
    vec2 q = vec2(ch.y, ch.x);    // the bed's own frame: along, across
    float patchy = max(0.0, sin(q.x * 0.011 + 1.3) * sin(q.y * 0.017 + 0.4) * 1.4 - 0.15);
    float breathe = 0.75 + 0.25 * sin(t * 0.6 + q.x * 0.02);
    float A = uStanding * patchy * breathe * (1.0 - smoothstep(300.0, 900.0, dist)) * smoothstep(25.0, 115.0, gBankD);
    float warp = 2.0 * sin(q.y * 0.037 + q.x * 0.013) + 1.3 * sin(q.y * 0.071 - q.x * 0.029 + 1.7);
    float ph = q.x * 0.42 + warp + 0.6 * sin(t * 0.9 + q.y * 0.05);
    float czp = q.y * 0.21 + 1.5 * sin(q.x * 0.05 + q.y * 0.02);
    float cz = cos(czp);
    gStanding = A * sin(ph) * cz;
    h.x += gStanding;
    // gradient in the bed's frame, turned back to world x/z (the slow warp terms are left
    // out of the derivative, they're ~10x smaller)
    float gs = A * 0.42 * cos(ph) * cz, gd = -A * 0.21 * sin(ph) * sin(czp);
    h.yz += gs * gFlowDir + gd * vec2(-gFlowDir.y, gFlowDir.x);
  }
  return h;
}
`;

export function waveUniforms(waves) {
  return {
    uWaveA: waves.list.map((w) => [w.dx, w.dz, w.k, w.amp]),
    uWaveB: waves.list.map((w) => [w.omega, w.phase, w.steep, 0]),
    uStanding: waves.standing,
  };
}
