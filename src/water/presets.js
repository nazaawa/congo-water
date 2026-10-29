// 3D water presets, one per kind of place on the tours (see src/data/routes.js `scene`).
// Units: metres, m/s, degrees. Colours are linear RGB. `pirogue` is the default boat
// model (floaters.js PIROGUES) when the route doesn't choose one.
//
// Congo water is a sediment-laden brown: it scatters back far more light than clear
// water and hardly lets you see the bottom, so the body colour is a strong in-scatter
// term (Ultra-Water's "murky brown" preset pushed further), mixed with the reflection
// by Fresnel.

const BROWN = { scatter: [0.13, 0.078, 0.036], shallow: [0.2, 0.13, 0.065], foam: [0.82, 0.76, 0.62] };
const DARK_BROWN = { scatter: [0.07, 0.048, 0.024], shallow: [0.13, 0.095, 0.05], foam: [0.8, 0.76, 0.64] };
const ESTUARY = { scatter: [0.12, 0.095, 0.05], shallow: [0.18, 0.15, 0.08], foam: [0.86, 0.84, 0.74] };

export const PRESETS = {
  ville: {
    label: 'Kinshasa – Brazzaville', pirogue: 'transport',
    halfWidth: 1700, meander: [120, 9000], flow: 1.6,
    waves: [{ dir: 20, len: 9, amp: 0.12 }, { dir: -35, len: 4.5, amp: 0.06 }, { dir: 70, len: 2.2, amp: 0.025 }],
    chop: 0.9, standing: 0, rocks: 0, foam: 0.05,
    water: BROWN,
    sun: { elev: 7, azim: 255 }, cloud: 0.55, haze: 0.00026,
    bank: 'ville', bankHeight: 12, bankRise: 60, trees: 0.35,
    hyacinths: 70, camera: { dist: 26, height: 7, angle: 150 },
  },
  pool: {
    label: 'Pool Malebo', pirogue: 'peche',
    halfWidth: 2600, meander: [200, 12000], flow: 0.8,
    waves: [{ dir: 10, len: 6, amp: 0.07 }, { dir: -50, len: 3, amp: 0.035 }, { dir: 80, len: 1.6, amp: 0.012 }],
    chop: 0.7, standing: 0, rocks: 0, foam: 0.02,
    water: BROWN,
    sun: { elev: 32, azim: 120 }, cloud: 0.65, haze: 0.0002,
    bank: 'foret', bankHeight: 7, bankRise: 40, trees: 0.6,
    islands: [[-900, 700, 520, 160], [600, -900, 300, 90], [1800, 1200, 700, 220]],
    hyacinths: 160, camera: { dist: 22, height: 5, angle: 205 },
  },
  rapides: {
    label: 'Rapides', pirogue: 'peche',
    halfWidth: 420, meander: [40, 3000], flow: 5.5,
    waves: [{ dir: 0, len: 7, amp: 0.15 }, { dir: 40, len: 3, amp: 0.08 }, { dir: -60, len: 1.7, amp: 0.04 }],
    chop: 1.6, standing: 1.2, rocks: 46, foam: 0.3,
    water: BROWN,
    sun: { elev: 24, azim: 230 }, cloud: 0.5, haze: 0.0005,
    bank: 'falaise', bankHeight: 45, bankRise: 120, trees: 0.45,
    hyacinths: 0, camera: { dist: 32, height: 10, angle: -115 },
  },
  fleuve: {
    label: 'Fleuve en forêt équatoriale', pirogue: 'baleiniere-sacs',
    halfWidth: 950, meander: [260, 7000], flow: 1.3,
    waves: [{ dir: 15, len: 7, amp: 0.08 }, { dir: -40, len: 3.5, amp: 0.04 }, { dir: 75, len: 1.8, amp: 0.015 }],
    chop: 0.75, standing: 0, rocks: 0, foam: 0.03,
    water: BROWN,
    sun: { elev: 11, azim: 95 }, cloud: 0.7, haze: 0.00055,
    bank: 'foret', bankHeight: 14, bankRise: 25, trees: 1,
    islands: [[1400, 520, 600, 120], [-1600, -420, 380, 90]],
    hyacinths: 90, camera: { dist: 24, height: 6, angle: 160 },
  },
  riviere: {
    label: 'Rivière sous les arbres', pirogue: 'petite',
    halfWidth: 22, meander: [28, 340], flow: 0.5,
    waves: [{ dir: 10, len: 2.2, amp: 0.015 }, { dir: -45, len: 1.1, amp: 0.008 }, { dir: 70, len: 0.6, amp: 0.004 }],
    chop: 0.45, standing: 0, rocks: 6, foam: 0.01,
    water: DARK_BROWN,
    sun: { elev: 48, azim: 140 }, cloud: 0.6, haze: 0.0016,
    bank: 'foret', bankHeight: 6, bankRise: 8, trees: 1,
    hyacinths: 10, camera: { dist: 14, height: 3.5, angle: 200 },
  },
  chutes: {
    label: 'Chutes', pirogue: 'petite',
    halfWidth: 70, meander: [0, 1000], flow: 2.6,
    waves: [{ dir: 0, len: 4, amp: 0.14 }, { dir: 50, len: 2, amp: 0.07 }, { dir: -70, len: 1, amp: 0.03 }],
    chop: 1.4, standing: 0.35, rocks: 16, foam: 0.25,
    water: DARK_BROWN,
    sun: { elev: 40, azim: 160 }, cloud: 0.5, haze: 0.0012,
    bank: 'falaise', bankHeight: 55, bankRise: 30, trees: 0.9,
    fall: { x: -170, height: 48 },
    hyacinths: 0, camera: { dist: 22, height: 4, angle: 20 },
  },
  estuaire: {
    label: 'Estuaire et mangroves', pirogue: 'peche',
    halfWidth: 3800, meander: [0, 10000], flow: 1.1,
    waves: [{ dir: 160, len: 22, amp: 0.35 }, { dir: 130, len: 8, amp: 0.16 }, { dir: -150, len: 3.2, amp: 0.06 }, { dir: 100, len: 1.5, amp: 0.02 }],
    chop: 1.1, standing: 0, rocks: 0, foam: 0.07,
    water: ESTUARY,
    sun: { elev: 58, azim: 200 }, cloud: 0.45, haze: 0.00022,
    bank: 'mangrove', bankHeight: 3, bankRise: 30, trees: 0.8,
    hyacinths: 20, camera: { dist: 26, height: 7, angle: 170 },
  },
};

// centre line of the modelled channel (z at distance x downstream), shared by the
// terrain, the water shader uniforms and the piloting
export function channelCentre(p, x) {
  return p.meander[0] * Math.sin((x / p.meander[1]) * Math.PI * 2);
}

// half length of the modelled river each side of x = 0 (the terrain in world.js)
export function riverHalfLength(p) {
  return Math.min(14000, Math.max(900, p.halfWidth * 7)) * 0.8;
}
