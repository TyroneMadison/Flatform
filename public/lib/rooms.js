// v3 rooms: every scene is a real 3D room, never a flat photo. Shared by studio.js, the server and
// render/blender_turntable.py (through --room), so the app and Blender build the same room.
// - cyc: a white floor curving up into the back wall. studio: a grey room with big softboxes. showroom: the modeled
//   showroom (studio.js buildShowroom).
// - hdri: a CC0 HDRI projected onto the ground (three's GroundedSkybox, a matching dome in Blender) with a real,
//   textured floor round the model. The HDRI is turned so its sun comes from the scene's key light.
// Assets are bundled in public/img/rooms (licenses in THIRD_PARTY_NOTICES.md). Pure data and maths only.
import { PLATES, plateCamera, DEFAULT_LIGHTING } from './pipeline.js';

// height: the HDRI camera's height above its ground (m). radius: how far its ground reaches (m). floor: a Poly Haven
// texture set, tile = metres per repeat. sun: where the HDRI's sun is (u across the image, 0-1).
export const ROOMS = {
  'white-cyc-studio': { type: 'cyc', color: '#f4f5f7' },
  cyclorama: { type: 'cyc', color: '#f4f5f7' },
  'soft-studio': { type: 'studio', color: '#7d8087' },
  showroom: { type: 'showroom' },
  'luxury-garage': { type: 'hdri', hdri: 'autoshop_01', height: 1.6, radius: 16, sun: 0.032, floor: { tex: 'concrete_floor_01', tile: 3, roughness: 0.35, radius: 9 } },
  'golden-hour-coast': { type: 'hdri', hdri: 'umhlanga_sunrise', height: 1.7, radius: 60, sun: 0.6, floor: { tex: 'coast_sand_01', tile: 3, roughness: 1, radius: 12 } },
  'night-city-rain': { type: 'hdri', hdri: 'shanghai_bund', height: 1.8, radius: 40, sun: 0.952, floor: { tex: 'asphalt_02', tile: 3, roughness: 0.12, radius: 12 } },
  'desert-highway-dusk': { type: 'hdri', hdri: 'goegap_road', height: 1.7, radius: 60, sun: 0.6, floor: { tex: 'asphalt_01', tile: 3, roughness: 0.8, radius: 12 } },
  'modern-villa-driveway': { type: 'hdri', hdri: 'pool', height: 1.7, radius: 30, sun: 0.608, floor: { tex: 'large_floor_tiles_02', tile: 2.5, roughness: 0.6, radius: 10 } },
};
export const ROOM_DIR = '/img/rooms';
export const roomThumb = (slug) => `${ROOM_DIR}/${slug}-thumb.png`;
/** The room's files, relative to public/img/rooms (the server joins them onto the rooms folder for Blender). */
export function roomFiles(slug) {
  const r = ROOMS[slug];
  if (r?.type !== 'hdri') return null;
  const t = r.floor.tex;
  return { hdri: `${r.hdri}_2k.hdr`, diff: `${t}_diff_1k.jpg`, rough: `${t}_rough_1k.jpg`, nor: `${t}_nor_1k.jpg` };
}

// Real-world size of what the room was built round: a car's length, a person's height (m).
const REAL = { car: 4.6, humanoid: 1.8 };
/** How much to scale the room so the model sits in it at its real size. size: the normalised model {x, y, z}, Y up. */
export function roomScale(size, kind = 'car') {
  if (!size) return 1;
  const s = kind === 'humanoid' ? size.y / REAL.humanoid : Math.max(size.x, size.z) / REAL.car;
  return Number.isFinite(s) && s > 0 ? Math.min(4, Math.max(0.25, s)) : 1;
}

/**
 * The turn (radians about Y, three.js) that puts the HDRI's sun where the key light is. keyAzimuth: degrees,
 * 0 = from the camera, negative = camera left (studio.js applyLights). In three.js a direction at angle
 * atan2(z, x) shows u = angle / 2π + 0.5; Blender's equirect maps the same way, so Blender turns by -this.
 */
export function roomRotation(slug, keyAzimuth) {
  const r = ROOMS[slug];
  if (r?.type !== 'hdri') return 0;
  const key = Math.PI / 2 - (keyAzimuth * Math.PI) / 180; // the key's angle atan2(z, x)
  return 2 * Math.PI * (r.sun - 0.5) - key;
}

/**
 * The --room argument for render/blender_turntable.py: the room, its camera and light (PLATES), the files under
 * `dir` and the HDRI's turn for the key light at `keyAzimuth` degrees (the Render step's rig, default -40). null when
 * the preset has no room.
 */
export function blenderRoom(slug, { kind = 'car', keyAzimuth = DEFAULT_LIGHTING.azimuth, dir = '' } = {}) {
  const room = ROOMS[slug];
  if (!room) return null;
  const plate = PLATES[slug];
  const files = roomFiles(slug);
  return {
    slug, ...room, kind: kind === 'humanoid' ? 'humanoid' : 'car',
    camera: plate ? plateCamera(plate.cam, 4 / 3) : null, light: slug !== 'showroom' ? plate?.light || null : null,
    ...(files && {
      files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, dir ? `${dir.replace(/[\\/]+$/, '')}/${f}` : f])),
      turn: roomRotation(slug, plate.light.sun.azimuth + keyAzimuth - DEFAULT_LIGHTING.azimuth),
    }),
  };
}
