// Boat models in public/models (meshopt-compressed GLBs). The hull bottom is at
// y = 0 and the bow (with the mooring chain or rope) points to +x. `draft` is how deep each sits loaded.
// Piloting: `vmax` top speed through the water (m/s), `turn` yaw rate (rad/s), `motor`
// an outboard at the stern: true adds one (the long transport pirogues of Kinshasa are
// motorised), 'model' swings the long-tail motor that comes with the GLB.
// Crew stand on `floor` (height above the keel): a number is a paddler at that x, {x, paddle: false}
// a helmsman (y: standing on a thwart instead; `pose` to choose: 'helm', 'paddle', 'pole', 'stand', 'wave').
// `seated` passengers: x on the benches, or [x, z, height, yaw?] to sit on the cargo or a chair
// (yaw turns them; 0 faces the bow). `passengers` / `crewOutfit` dress them (people.js options).
// `motorNode` / `pivotNode` name the GLB's motor and the part it swings about.
const BALEINIERE = { draft: 0.32, floor: 0.44, bench: 1.26, crew: [{ x: -5.9, y: 1.26, paddle: false }, 6.0], cargo: 0, motor: 'model', vmax: 6.5, turn: 0.2 };
export const PIROGUES = {
  transport: { file: 'pirogue-transport.glb', label: 'Pirogue de transport (12 m)', draft: 0.26, crew: [-5.0, 4.6], seated: [-3.8, -2.6, -1.5, 0.3, 1.5, 2.6], cargo: 7, vmax: 7, turn: 0.32, motor: true },
  peche: { file: 'pirogue-peche.glb', label: 'Pirogue de pêche (8 m)', draft: 0.2, crew: [-3.2, 2.3], seated: [], cargo: 2, net: true, vmax: 2.8, turn: 0.5 },
  petite: { file: 'pirogue-petite.glb', label: 'Petite pirogue (4,5 m)', draft: 0.15, crew: [-1.45], seated: [0.55], cargo: 1, vmax: 2.3, turn: 0.75 },
  // the plank whaleboats of the river trade, 16 m with a long-tail outboard
  baleiniere: {
    ...BALEINIERE, file: 'baleiniere-vide.glb', label: 'Baleinière à passagers (16 m)',
    seated: [-3.9, -1.7, 0.6, 2.9, 5.0].flatMap((x) => [[x, -0.55, 1.26], [x, 0.55, 1.26]]),
  },
  'baleiniere-sacs': {
    ...BALEINIERE, file: 'baleiniere-sacs.glb', label: 'Baleinière chargée de sacs (16 m)', draft: 0.6, vmax: 4.6, turn: 0.17,
    seated: [[-3.9, -0.5, 1.26], [-3.9, 0.5, 1.26], [-1.0, 0.35, 1.55], [1.2, -0.35, 1.55], [3.2, 0.3, 1.57], [5.0, -0.5, 1.26]],
  },
  'baleiniere-bois': {
    ...BALEINIERE, file: 'baleiniere-bois.glb', label: 'Baleinière chargée de bois (16 m)', draft: 0.7, vmax: 4.0, turn: 0.16,
    seated: [[-2.0, 0, 1.73], [2.0, 0, 1.75]],
  },
  // the painted leisure whaleboat of Sunday outings on the Pool: raffia roof, chairs around
  // little tables, an outboard at the stern and a guide at the bow
  'baleiniere-loisirs': {
    file: 'baleiniere-loisirs.glb', label: 'Baleinière peinte de loisirs (18 m)',
    draft: 0.32, floor: 0.36, motor: 'model', motorNode: 'moteur_hors_bord', pivotNode: 'moteur_capot',
    vmax: 5.5, turn: 0.18, cargo: 0,
    crew: [{ x: -8.2, paddle: false }, { x: 2.35, pose: 'wave' }],
    seated: [[-6.6, 0.5], [-4.85, -0.79], [-4.85, 0.79], [-3.1, -0.8], [-1.35, 0.79], [-1.35, -0.79], [0.4, 0.8], [0.4, -0.8], [2.03, 0.42]]
      .map(([x, z]) => [x, z, 0.78, z > 0 ? Math.PI / 2 : -Math.PI / 2]),
    passengers: { outfit: 'tourist', vest: true },
  },
};
