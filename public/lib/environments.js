// 3D environments: real places the car stands inside, built from primitives in metres (no photo backplates).
// Pure data and pure helpers only, so the in-app studio (studio.js via env3d.js), the server and
// render/blender_turntable.py all build exactly the same geometry.
//
// Space: Flatform's Y up, metres, car centred on the origin with its tyres on y = 0, car-view camera on +Z.
// Parts (positions are centres unless noted; rot in degrees, XYZ order; repeat = [count, dx, dy, dz]):
//   { box: [w, h, d], at: [x, y, z], rot?, mat, repeat? }
//   { cyl: [radiusTop, radiusBottom, h], at, rot?, mat, repeat? }      (axis along Y before rot)
//   { ring: [radius, tube], at, mat }                                   (lying flat on the floor)
//   { room: [w, h, d], at: [x, z], floor, walls, ceiling }              (inward faces, floor on y = 0; seen from
//                                                                         outside the walls are see-through)
//   { cyc: [w, h, radius, front], at: [x, z], mat }                     (floor from z to z + front, curving up
//                                                                         into a wall at z, `h` high)
//   { glb: 'file.glb', at, rot?, scale? }                               (a bundled CC0 model in public/env/, its
//                                                                         base at `at`; THIRD_PARTY_NOTICES.md)
// Materials: { color, rough, metal?, emit? } (sRGB hex; emit > 0 = a light source seen by the camera).
// Lights: { area: [w, h], at, aim, color, power } (power is the three.js RectAreaLight intensity). Never aim one
//   straight down: tilt it a little towards +z so `h` runs along z in three.js and Blender alike.
// sky: { color } | { hdri, sunU, intensity? } (an open sky at infinity; ground is geometry; sunU = where the HDRI's
//   sun is across the image, 0-1, so skyRotation turns it to light.sun) | { sun: true } (procedural daylight from
//   light.sun: three.js Sky, Blender's Sky Texture).
// rain: { drops, box: [w, h, d], speed, length, color, opacity } falling streaks round the car (rainDrops).
// reflect: the bundled HDRI the paint reflects (else the sky, else the geometry itself).
// cam: the eye-level car-view camera (pipeline.js envCamera): horizon/ground as fractions of the 4:3 frame from the
//   top, width = metres seen across the frame at the car, hfov in degrees.
// light: the matched key/fill/rim, ambient and floor (see studio.js applyLights).

export const ENVIRONMENTS = {
  'white-cyc-studio': {
    label: 'White Cyc Studio', note: 'Bright infinity cove · soft even light',
    cam: { horizon: 0.5, ground: 0.72, width: 7.4, hfov: 45 },
    light: { sun: { azimuth: -30, elevation: 60, kelvin: 6000 }, key: 0.9, fill: 0.7, rim: 0.4, sky: ['#ffffff', '#d8dade', 0.9], shadow: 0.6, reflection: 0.06, env: 1.0 },
    sky: { color: '#eceef1' }, reflect: 'white_studio_02',
    mats: {
      cyc: { color: '#f4f5f7', rough: 0.92 }, softbox: { color: '#ffffff', rough: 0.5, emit: 2.2 },
      stand: { color: '#2a2a2c', rough: 0.4, metal: 0.8 },
    },
    parts: [
      { cyc: [18, 7, 2.5, 22], at: [0, -6.5], mat: 'cyc' },
      // Two big softboxes on stands, left and right in front of the car, tilted down at it.
      { box: [2.4, 1.6, 0.06], at: [-4, 3.6, 2.5], rot: [-35, -40, 0], mat: 'softbox' },
      { box: [2.4, 1.6, 0.06], at: [4, 3.6, 2.5], rot: [-35, 40, 0], mat: 'softbox' },
      { cyl: [0.02, 0.02, 3.2], at: [-4.3, 1.6, 2.9], mat: 'stand', repeat: [2, 8.6, 0, 0] },
      { box: [5, 0.04, 2.5], at: [0, 6.2, 0], mat: 'softbox' }, // overhead silk
    ],
    lights: [
      { area: [5, 2.5], at: [0, 6, 0], aim: [0, 0, 0.4], color: '#ffffff', power: 4 },
      { area: [2.4, 1.6], at: [-4, 3.6, 2.5], aim: [0, 0.7, 0], color: '#ffffff', power: 3 },
      { area: [2.4, 1.6], at: [4, 3.6, 2.5], aim: [0, 0.7, 0], color: '#ffffff', power: 3 },
    ],
  },
  'soft-studio': {
    label: 'Soft studio', note: 'Grey cove · big overhead softbox · strip lights',
    cam: { horizon: 0.5, ground: 0.72, width: 7.4, hfov: 45 },
    light: { sun: { azimuth: -40, elevation: 55, kelvin: 5600 }, key: 0.8, fill: 0.45, rim: 1.2, sky: ['#e8eaee', '#2a2b2e', 0.35], shadow: 0.75, reflection: 0.12, env: 1.1 },
    sky: { color: '#2b2c30' }, reflect: 'studio_small_03',
    mats: {
      cyc: { color: '#3a3b3f', rough: 0.85 }, softbox: { color: '#fff8f0', rough: 0.5, emit: 2.4 }, strip: { color: '#ffffff', rough: 0.5, emit: 3 },
      stand: { color: '#1c1c1e', rough: 0.4, metal: 0.8 },
    },
    parts: [
      { cyc: [16, 6, 2, 20], at: [0, -6], mat: 'cyc' },
      { box: [6, 0.05, 3], at: [0, 4.4, 0], mat: 'softbox' },
      // Two tall strip boxes behind the car on either side: the rim light along the paint.
      { box: [0.5, 2.8, 0.06], at: [-4.2, 1.7, -2.5], rot: [0, 50, 0], mat: 'strip' },
      { box: [0.5, 2.8, 0.06], at: [4.2, 1.7, -2.5], rot: [0, -50, 0], mat: 'strip' },
      { cyl: [0.02, 0.02, 0.3], at: [-4.2, 0.15, -2.5], mat: 'stand', repeat: [2, 8.4, 0, 0] },
    ],
    lights: [
      { area: [6, 3], at: [0, 4.35, 0], aim: [0, 0, 0.3], color: '#fff8f0', power: 3.5 },
      { area: [0.5, 2.8], at: [-4.2, 1.7, -2.5], aim: [0, 0.8, 0], color: '#ffffff', power: 6 },
      { area: [0.5, 2.8], at: [4.2, 1.7, -2.5], aim: [0, 0.8, 0], color: '#ffffff', power: 6 },
    ],
  },
  showroom: {
    label: 'Showroom', note: 'Dark showroom · gold ring · ceiling softbox',
    cam: { horizon: 0.53, ground: 0.71, width: 7.3, hfov: 50 },
    light: { sun: { azimuth: 0, elevation: 70, kelvin: 6500 }, key: 1.0, fill: 0.15, rim: 1.6, sky: ['#d8dde6', '#2a1e10', 0.12], shadow: 0.85, reflection: 0.35, env: 0.9 },
    sky: { color: '#09090a' },
    mats: {
      floor: { color: '#0b0a0a', rough: 0.25 }, wall: { color: '#100f0f', rough: 0.9 }, ceiling: { color: '#050505', rough: 0.95 },
      gold: { color: '#f2b56b', rough: 0.3, emit: 1.5 }, bar: { color: '#ffffff', rough: 0.3, emit: 3.5 }, softbox: { color: '#f4f7ff', rough: 0.3, emit: 1.3 },
    },
    parts: [
      { room: [24, 6, 24], at: [0, 1.5], floor: 'floor', walls: 'wall', ceiling: 'ceiling' },
      { ring: [3.3, 0.014], at: [0, 0.008, 0], mat: 'gold' },
      { box: [0.1, 2.6, 0.1], at: [-4.8, 1.3, -4.2], mat: 'bar', repeat: [2, 9.6, 0, 0] },
      { box: [9, 0.02, 5], at: [0, 5.98, -0.5], mat: 'softbox' },
    ],
    lights: [
      { area: [8, 5], at: [0, 4.5, -0.6], aim: [0, 0, -0.3], color: '#f4f7ff', power: 3.2 },
      { area: [0.3, 2.6], at: [-4.8, 1.3, -4], aim: [0, 0.8, 0], color: '#ffffff', power: 4 },
      { area: [0.3, 2.6], at: [4.8, 1.3, -4], aim: [0, 0.8, 0], color: '#ffffff', power: 4 },
      { area: [6.6, 6.6], at: [0, 0.01, 0], aim: [0, 1, 0.2], color: '#f2b56b', power: 0.3 },
    ],
  },
  'luxury-garage': {
    label: 'Luxury Garage', note: 'Polished concrete · warm LED strips',
    cam: { horizon: 0.5, ground: 0.76, width: 7.6, hfov: 55 },
    light: { sun: { azimuth: 0, elevation: 75, kelvin: 3600 }, key: 1.0, fill: 0.3, rim: 1.3, sky: ['#ffe2bd', '#3a332c', 0.25], shadow: 0.8, reflection: 0.3, env: 1.0 },
    sky: { color: '#0b0a09' }, reflect: 'garage',
    mats: {
      concrete: { color: '#6f6b67', rough: 0.22 }, wall: { color: '#2e2c2a', rough: 0.85 }, ceiling: { color: '#1c1b1a', rough: 0.9 },
      led: { color: '#ffb874', rough: 0.3, emit: 4 }, wood: { color: '#5a3a22', rough: 0.6 }, column: { color: '#55524e', rough: 0.8 },
      door: { color: '#3b3b3d', rough: 0.5, metal: 0.6 }, cabinet: { color: '#161618', rough: 0.35, metal: 0.4 },
    },
    parts: [
      { room: [12, 3.2, 20], at: [0, 1.5], floor: 'concrete', walls: 'wall', ceiling: 'ceiling' },
      // Warm LED: two lines along the ceiling and a cove line along the foot and top of the back wall.
      { box: [0.06, 0.03, 18], at: [-2.2, 3.18, 1.5], mat: 'led', repeat: [2, 4.4, 0, 0] },
      { box: [11.8, 0.04, 0.04], at: [0, 0.05, -8.45], mat: 'led' },
      { box: [11.8, 0.04, 0.04], at: [0, 3.1, -8.45], mat: 'led' },
      // Wooden slat wall behind the car, two concrete columns, a roller door on the left, tool cabinets on the right.
      { box: [0.08, 2.9, 0.06], at: [-4.5, 1.55, -8.42], mat: 'wood', repeat: [31, 0.3, 0, 0] },
      { box: [0.5, 3.2, 0.5], at: [-4.6, 1.6, -4.5], mat: 'column', repeat: [2, 9.2, 0, 0] },
      { box: [0.06, 2.6, 5], at: [-5.96, 1.3, -1], mat: 'door' },
      { box: [0.6, 1.0, 3], at: [5.65, 0.5, -3.5], mat: 'cabinet' },
    ],
    lights: [
      { area: [0.3, 16], at: [-2.2, 3.12, 1.5], aim: [-2.2, 0, 2], color: '#ffc896', power: 5 },
      { area: [0.3, 16], at: [2.2, 3.12, 1.5], aim: [2.2, 0, 2], color: '#ffc896', power: 5 },
      { area: [11, 0.2], at: [0, 3.0, -8.3], aim: [0, 1, 0], color: '#ffb874', power: 6 },
    ],
  },
  'golden-hour-coast': {
    label: 'Golden Hour Coast', note: 'Oceanfront road · warm low sun',
    cam: { horizon: 0.5, ground: 0.76, width: 7.6, hfov: 50 },
    light: { sun: { azimuth: -70, elevation: 8, kelvin: 3300 }, key: 1.8, fill: 0.25, rim: 0.9, sky: ['#ffd9a8', '#5a4636', 0.35], shadow: 0.75, reflection: 0, env: 0.8 },
    sky: { hdri: 'umhlanga_sunrise', sunU: 0.6, intensity: 1 },
    mats: {
      asphalt: { color: '#3a3836', rough: 0.85 }, line: { color: '#e8e4da', rough: 0.7 }, promenade: { color: '#c9b79a', rough: 0.9 },
      wall: { color: '#ece6da', rough: 0.8 }, sand: { color: '#d9c39a', rough: 1 }, sea: { color: '#1d4a66', rough: 0.06 },
      trunk: { color: '#6b5642', rough: 0.9 }, frond: { color: '#3b5f2c', rough: 0.8 }, hotel: { color: '#efe9df', rough: 0.85 },
    },
    parts: [
      { box: [600, 0.02, 10], at: [0, -0.01, 0], mat: 'asphalt' },
      { box: [3, 0.005, 0.12], at: [-297, 0.0025, 0], mat: 'line', repeat: [100, 6, 0, 0] },
      { box: [600, 0.15, 5], at: [0, 0.075, -7.5], mat: 'promenade' },
      { box: [600, 0.9, 0.3], at: [0, 0.45, -10.1], mat: 'wall' },
      { box: [600, 0.4, 40], at: [0, -0.6, -30.3], mat: 'sand' },
      { box: [2000, 0.02, 1200], at: [0, -0.9, -650], mat: 'sea' },
      { box: [600, 0.02, 200], at: [0, -0.01, 105], mat: 'promenade' }, // the town side behind the camera
      // Palms along the promenade, a hotel row across the road.
      { cyl: [0.14, 0.2, 8], at: [-77, 4, -8], mat: 'trunk', repeat: [12, 14, 0, 0] },
      { cyl: [2.2, 0.25, 0.7], at: [-77, 8.2, -8], mat: 'frond', repeat: [12, 14, 0, 0] },
      { box: [24, 14, 12], at: [-60, 7, 26], mat: 'hotel', repeat: [5, 30, 0, 0] },
      // Benches on the promenade facing the sea, a lifebuoy on the sea wall, a buoy out on the water.
      { glb: 'painted_wooden_bench.glb', at: [-6, 0.15, -9.2], rot: [0, 180, 0], repeat: [4, 7, 0, 0] },
      { glb: 'lifebuoy.glb', at: [2.5, 0.55, -9.9] },
      { glb: 'ocean_buoy.glb', at: [-14, -0.4, -70], scale: 1.6 },
    ],
    lights: [],
  },
  'night-city-rain': {
    label: 'Night City Rain', note: 'Wet asphalt · neon reflections',
    cam: { horizon: 0.5, ground: 0.76, width: 7.6, hfov: 50 },
    light: { sun: { azimuth: 150, elevation: 25, kelvin: 7500 }, key: 0.5, fill: 0.2, rim: 1.6, sky: ['#5a6cff', '#1a0f2a', 0.25], shadow: 0.7, reflection: 0.55, env: 1.2 },
    sky: { hdri: 'shanghai_bund', sunU: 0.093, intensity: 0.7 }, // sunU: its brightest light, put behind the car as the rim
    mats: {
      asphalt: { color: '#17181c', rough: 0.12 }, line: { color: '#cfcfcf', rough: 0.5 }, curb: { color: '#3a3a40', rough: 0.8 },
      tower: { color: '#2a2c38', rough: 0.6 }, window: { color: '#ffd59a', rough: 0.5, emit: 0.6 }, pink: { color: '#ff2fb0', rough: 0.4, emit: 2 },
      cyan: { color: '#2fe0ff', rough: 0.4, emit: 2 }, lamp: { color: '#ffe0b0', rough: 0.4, emit: 2.5 },
    },
    parts: [
      { box: [600, 0.02, 14], at: [0, -0.01, 0], mat: 'asphalt' },
      { box: [3, 0.005, 0.12], at: [-297, 0.0025, 0], mat: 'line', repeat: [100, 6, 0, 0] },
      { box: [600, 0.15, 5], at: [0, 0.075, -9.5], mat: 'curb' },
      { box: [600, 0.15, 5], at: [0, 0.075, 9.5], mat: 'curb' },
      // Towers both sides of the street, lit window bands, neon signs at shop height.
      { box: [18, 30, 14], at: [-80, 15, -19], mat: 'tower', repeat: [9, 20, 0, 0] },
      { box: [18, 22, 14], at: [-70, 11, 19], mat: 'tower', repeat: [8, 20, 0, 0] },
      { box: [15, 0.3, 0.05], at: [-80, 6, -11.95], mat: 'window', repeat: [9, 20, 0, 0] },
      { box: [15, 0.3, 0.05], at: [-80, 10, -11.95], mat: 'window', repeat: [9, 20, 0, 0] },
      { box: [15, 0.3, 0.05], at: [-80, 14, -11.95], mat: 'window', repeat: [9, 20, 0, 0] },
      { box: [15, 0.3, 0.05], at: [-80, 18, -11.95], mat: 'window', repeat: [9, 20, 0, 0] },
      { box: [4, 0.25, 0.08], at: [-6, 3.4, -11.9], mat: 'pink' },
      { box: [0.25, 3, 0.08], at: [5, 4, -11.9], mat: 'cyan' },
      { box: [5, 0.25, 0.08], at: [-24, 3, -11.9], mat: 'cyan' },
      { box: [3, 0.25, 0.08], at: [22, 3.6, -11.9], mat: 'pink' },
      // Street lamps along the far curb (their lit heads are the lamp boxes), bins and utility boxes on the pavements.
      { glb: 'street_lamp_01.glb', at: [-36, 0.15, -7.6], scale: 1.4, repeat: [7, 12, 0, 0] },
      { box: [0.5, 0.06, 0.3], at: [-36, 5.25, -7.6], mat: 'lamp', repeat: [7, 12, 0, 0] },
      { glb: 'metal_trash_can.glb', at: [-9, 0.15, -10.6], repeat: [2, 17, 0, 0] },
      { glb: 'utility_box_01.glb', at: [11, 0.15, -10.8], repeat: [2, -27, 0, 0] },
      { glb: 'metal_trash_can.glb', at: [4, 0.15, 10.6], rot: [0, 180, 0] },
    ],
    lights: [
      { area: [4, 0.5], at: [-6, 3.4, -11.6], aim: [-6, 0, 0], color: '#ff2fb0', power: 12 },
      { area: [0.5, 3], at: [5, 4, -11.6], aim: [5, 0, 0], color: '#2fe0ff', power: 12 },
    ],
    rain: { drops: 3000, box: [24, 9, 24], speed: 9, length: 0.45, color: '#b8c8e8', opacity: 0.35 },
  },
  'desert-highway-dusk': {
    label: 'Desert Highway Dusk', note: 'Purple-orange sky · open road',
    cam: { horizon: 0.5, ground: 0.78, width: 7.6, hfov: 50 },
    light: { sun: { azimuth: 170, elevation: 6, kelvin: 2900 }, key: 0.9, fill: 0.3, rim: 1.4, sky: ['#b58cd8', '#4a3a3e', 0.4], shadow: 0.6, reflection: 0, env: 0.9 },
    sky: { hdri: 'goegap_road', sunU: 0.6, intensity: 1.1 },
    mats: {
      asphalt: { color: '#3b3a3a', rough: 0.8 }, yellow: { color: '#e0b440', rough: 0.6 }, white: { color: '#e6e3dc', rough: 0.6 },
      sand: { color: '#a8835f', rough: 1 }, shoulder: { color: '#7d6a58', rough: 1 }, pole: { color: '#5a4636', rough: 0.9 },
    },
    parts: [
      { box: [1200, 0.02, 1200], at: [0, -0.035, 0], mat: 'sand' },
      { box: [1200, 0.02, 11], at: [0, -0.0125, 0], mat: 'shoulder' },
      { box: [1200, 0.02, 8], at: [0, -0.01, 0], mat: 'asphalt' },
      { box: [3, 0.005, 0.12], at: [-597, 0.0025, 0], mat: 'yellow', repeat: [134, 9, 0, 0] },
      { box: [1200, 0.005, 0.12], at: [0, 0.0025, -3.8], mat: 'white', repeat: [2, 0, 0, 7.6] },
      { cyl: [0.12, 0.15, 9], at: [-160, 4.5, -12], mat: 'pole', repeat: [9, 40, 0, 0] },
      // Namaqualand boulders, quiver trees and rooibos scrub either side of the road.
      { glb: 'namaqualand_boulder_04.glb', at: [-18, -0.1, -26], rot: [0, 30, 0] },
      { glb: 'namaqualand_boulder_04.glb', at: [31, -0.2, -40], rot: [0, -110, 0], scale: 1.8 },
      { glb: 'namaqualand_boulder_04.glb', at: [24, -0.1, 30], rot: [0, 70, 0], scale: 0.7 },
      { glb: 'quiver_tree_02.glb', at: [-9, -0.03, -15], scale: 2.6 },
      { glb: 'quiver_tree_02.glb', at: [14, -0.03, -22], rot: [0, 140, 0], scale: 3.2 },
      { glb: 'dead_quiver_trunk.glb', at: [-26, -0.03, -12], rot: [0, 60, 0], scale: 1.5 },
      { glb: 'wild_rooibos_bush.glb', at: [-5, -0.03, -9], scale: 1.2 },
      { glb: 'wild_rooibos_bush.glb', at: [8, -0.03, -10], rot: [0, 200, 0] },
      { glb: 'wild_rooibos_bush.glb', at: [-14, -0.03, 11], rot: [0, 90, 0] },
    ],
    lights: [],
  },
  'modern-villa-driveway': {
    label: 'Modern Villa Driveway', note: 'Palms · white architecture · midday',
    cam: { horizon: 0.5, ground: 0.8, width: 7.6, hfov: 50 },
    light: { sun: { azimuth: -35, elevation: 62, kelvin: 5800 }, key: 2.0, fill: 0.45, rim: 0.6, sky: ['#bcd8ff', '#e8e2d8', 0.6], shadow: 0.85, reflection: 0, env: 1.0 },
    sky: { hdri: 'kloofendal_48d_partly_cloudy_puresky', sunU: 0.595, intensity: 1 },
    mats: {
      pavers: { color: '#d8d2c6', rough: 0.7 }, lawn: { color: '#4f7a3a', rough: 1 }, white: { color: '#f2f0ec', rough: 0.8 },
      glass: { color: '#1d2a33', rough: 0.05, metal: 0.2 }, wood: { color: '#7a5434', rough: 0.6 }, slab: { color: '#e4e1db', rough: 0.85 },
      trunk: { color: '#7b6650', rough: 0.9 }, frond: { color: '#3f6a30', rough: 0.8 },
    },
    parts: [
      { box: [800, 0.02, 800], at: [0, -0.025, 0], mat: 'lawn' },
      { box: [16, 0.02, 30], at: [0, -0.01, 4], mat: 'pavers' },
      // The villa behind the car: a white ground floor with a glass front, a cantilevered upper floor, a timber screen.
      { box: [22, 3.4, 10], at: [0, 1.7, -14], mat: 'white' },
      { box: [16, 2.4, 0.06], at: [-1, 1.4, -8.97], mat: 'glass' },
      { box: [16, 3.2, 11], at: [-3, 5.1, -13], mat: 'white' },
      { box: [12, 2.2, 0.06], at: [-3, 5.1, -7.47], mat: 'glass' },
      { box: [24, 0.3, 13], at: [-2, 6.85, -13.5], mat: 'slab' },
      { box: [0.08, 3, 0.12], at: [3.4, 5.1, -7.4], mat: 'wood', repeat: [6, 0.28, 0, 0] },
      { box: [30, 0.8, 0.3], at: [0, 0.4, 19.5], mat: 'white' }, // garden wall behind the camera
      // Planters with shrubs along the glass front, a table and chairs on the terrace.
      { glb: 'planter_box_01.glb', at: [-7, 0, -6.5], scale: 1.4, repeat: [2, 14, 0, 0] },
      { glb: 'shrub_04.glb', at: [-7.4, 0.55, -6.5], scale: 2.2, repeat: [2, 14, 0, 0] },
      { glb: 'outdoor_table_chair_set_01.glb', at: [-10.5, 0, -2], rot: [0, 25, 0] },
      { glb: 'planter_box_01.glb', at: [4.5, 0, -8.5], scale: 1.2, repeat: [3, 1.6, 0, 0] },
      { cyl: [0.14, 0.2, 7], at: [-9, 3.5, -4], mat: 'trunk', repeat: [2, 18, 0, 0] },
      { cyl: [2.0, 0.25, 0.6], at: [-9, 7.2, -4], mat: 'frond', repeat: [2, 18, 0, 0] },
    ],
    lights: [],
  },
};

// Real-world size of what the places are built round: a car's length, a person's height (m).
const REAL = { car: 4.6, humanoid: 1.8 };
/** How much to scale the place so the model stands in it at its real size. size: the normalised model {x, y, z}, Y up. */
export function envScale(size, kind = 'car') {
  if (!size) return 1;
  const s = kind === 'humanoid' ? size.y / REAL.humanoid : Math.max(size.x, size.z) / REAL.car;
  return Number.isFinite(s) && s > 0 ? Math.min(4, Math.max(0.25, s)) : 1;
}

// The turn (degrees about Y, as three.js scene.backgroundRotation) that puts an HDRI sky's sun where light.sun is,
// so the sun you see and the key light's shadows agree. A direction at angle atan2(z, x) shows u = angle / 360 + 0.5
// (three.js and Cycles alike); the key is at atan2(cos az, sin az). Blender's Mapping node turns by minus this.
export function skyRotation(e) {
  if (!e.sky.hdri) return 0;
  const sun = 360 * (e.sky.sunU - 0.5);
  const key = 90 - e.light.sun.azimuth;
  return ((sun - key) % 360 + 540) % 360 - 180;
}

// Rain (spec.rain): where each streak starts, [x, y, z] in the box round the car, from a fixed seed so the app and
// Blender (its rain_drops) place the same rain. mulberry32: integer maths only, identical in both.
export function rainDrops(rain) {
  let a = 0x9e3779b9 | 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const [w, h, d] = rain.box;
  return Array.from({ length: rain.drops }, () => [(rand() - 0.5) * w, rand() * h, (rand() - 0.5) * d]);
}

// The flat part list with every repeat expanded: what env3d.js and Blender build.
export function envParts(spec) {
  const out = [];
  for (const p of spec.parts) {
    const [n, dx, dy, dz] = p.repeat || [1, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const { repeat, ...rest } = p;
      out.push(p.at && p.at.length === 3 ? { ...rest, at: [p.at[0] + dx * i, p.at[1] + dy * i, p.at[2] + dz * i] } : rest);
    }
  }
  return out;
}

// Axis-aligned bounds of a part, ignoring its rotation (rotated parts here are small props): { min, max }.
export function partBounds(p) {
  if (p.room) {
    const [w, h, d] = p.room;
    return { min: [p.at[0] - w / 2, 0, p.at[1] - d / 2], max: [p.at[0] + w / 2, h, p.at[1] + d / 2] };
  }
  if (p.cyc) {
    const [w, h, , front] = p.cyc;
    return { min: [p.at[0] - w / 2, 0, p.at[1]], max: [p.at[0] + w / 2, h, p.at[1] + front] };
  }
  const half = p.box ? p.box.map((v) => v / 2) : p.cyl ? [Math.max(p.cyl[0], p.cyl[1]), p.cyl[2] / 2, Math.max(p.cyl[0], p.cyl[1])]
    : p.ring ? [p.ring[0] + p.ring[1], p.ring[1], p.ring[0] + p.ring[1]] : [0, 0, 0];
  return { min: p.at.map((v, i) => v - half[i]), max: p.at.map((v, i) => v + half[i]) };
}

// What render/blender_turntable.py gets (--environment): the expanded parts plus everything needed to light it.
// hdri(name) and glb(file) resolve bundled assets to files on disk.
export function blenderEnvironment(slug, camera, { hdri: hdriPath = () => null, glb = () => null } = {}) {
  const e = ENVIRONMENTS[slug];
  return {
    slug, camera, light: e.light, mats: e.mats, lights: e.lights,
    parts: envParts(e).map((p) => (p.glb ? { ...p, path: glb(p.glb) } : p)),
    sky: e.sky.hdri ? { ...e.sky, rotation: skyRotation(e), path: hdriPath(e.sky.hdri) } : e.sky,
    rain: e.rain || null,
    reflect: e.reflect ? hdriPath(e.reflect) : null,
  };
}
